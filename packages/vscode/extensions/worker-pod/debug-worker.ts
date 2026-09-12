/**
 * tsval debug worker (M2) — runs the target program under tsval's stepping VM and adds TIME TRAVEL.
 *
 * Pausing is ASYNC, not Atomics-blocked: the whole program is driven by THIS worker's own loop
 * (`runToBreakpoint`/`stepStatement`/`step`), so to "pause" the loop simply awaits the next control message.
 * Atomics.wait only becomes necessary in M3, when native React synchronously invokes guest code.
 *
 * Time travel is tsval's `fork()` — a full, independent snapshot of the machine (frames are plain data, so
 * the whole state clones). We keep a HISTORY of forks, one per stop: forward actions fork the current stop and
 * advance a copy (leaving the stored fork pristine); backward actions just move the index and re-emit an
 * earlier fork. Because the interpreter is deterministic, re-advancing after a step-back reproduces the same
 * states. Only user (guest) state lives in the fork — native side effects would not rewind, but a plain
 * program has none, which is exactly why time travel is clean here.
 *
 * On every stop the worker sends the adapter a COMPLETE snapshot (frame + Locals scope + variable values), so
 * the adapter answers stackTrace/scopes/variables from it with no round-trip.
 */
import ts from "typescript";
import React from "react";

import { createVM, type LoadedVM } from "@brianjenkins94/tsval";

import { createGuestRoot, type GuestRoot } from "./debug-react";

type Vm = LoadedVM["vm"];

/** Control messages from the adapter. */
type Incoming =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control": SharedArrayBuffer; "react"?: boolean }
	| { "type": "setBreakpoints"; "lines": number[] }
	| { "type": "dispatch"; "id": number; "event": string }
	| { "type": "timeTravel"; "index": number }
	| { "type": "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect" };

type Action = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect";
type ForwardAction = "continue" | "next" | "stepIn" | "stepOut";

interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }
interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number }[];
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	"variables": Record<number, Variable[]>;
	/** True when this stop is an earlier point in history (a time-travel view), for the stop reason. */
	"traveled"?: boolean;
}

const post = (message: Record<string, unknown>): void => { (self as unknown as Worker).postMessage(message); };

let sourceFile: ts.SourceFile | undefined;
/** Forks, one per stop reached; `index` is the currently-displayed stop. */
let history: Vm[] = [];
let index = -1;
let done = false;
/** Resolver for the control message the session loop is currently awaiting (top-level, async pause). */
let awaitAction: ((action: Action) => void) | undefined;
/**
 * Shared control word for the SYNCHRONOUS in-handler pause (M3b). A breakpoint reached inside a host-invoked
 * guest call (e.g. React's onClick) can't pause by awaiting — the call is on a synchronous stack the worker
 * loop doesn't drive — so the onBreakpoint hook blocks the whole worker on `Atomics.wait` while the main
 * thread stays live, and the adapter resumes it via `Atomics.notify`. control[0]: 0 = waiting, 1 = go.
 */
let control: Int32Array | undefined;
/** In React mode, the reconciler root the guest app renders into (see launchReact). */
let guestRoot: GuestRoot | undefined;

function nextAction(): Promise<Action> {
	return new Promise((resolve) => { awaitAction = resolve; });
}

/** A readable one-line rendering of a runtime value for the Variables pane. */
function format(value: unknown): string {
	switch (typeof value) {
		case "string": return JSON.stringify(value);
		case "function": return "ƒ " + ((value as { "name"?: string }).name ?? "");
		case "object":
			if (value === null) { return "null"; }
			try { return Array.isArray(value) ? `Array(${value.length})` : "{…}"; } catch { return "{…}"; }
		default: return String(value);
	}
}

function typeName(value: unknown): string {
	if (value === null) { return "null"; }
	if (Array.isArray(value)) { return "array"; }

	return typeof value;
}

/**
 * Build a DAP-ready snapshot of `vm`'s current stop. M2 is a SINGLE frame at the current node with one
 * "Locals" scope: the in-scope program bindings, walked from the current (top) scope up through its parents
 * (inner shadows outer). Standard globals live on the global object, not as scope bindings, so including the
 * root scope surfaces the program's top-level vars without dumping the whole global namespace.
 */
function snapshot(vm: Vm): Snapshot {
	const loc = vm.location();
	const scope = vm.top?.scope ?? vm.rootScope;

	const rows: Variable[] = [];
	const seen = new Set<string>();

	for (let s: typeof scope | undefined = scope; s !== undefined; s = s.parent) {
		for (const [name, binding] of s.bindings) {
			if (seen.has(name)) {
				continue;
			}

			seen.add(name);
			rows.push({
				"name": name,
				"value": binding.initialized ? format(binding.value) : "<uninitialized>",
				"type": typeName(binding.value),
				"variablesReference": 0
			});
		}
	}

	return {
		"frames": [{ "id": 1, "name": functionName(loc?.pos), "line": (loc?.line ?? 0) + 1, "column": (loc?.character ?? 0) + 1 }],
		"scopes": { 1: [{ "name": "Locals", "variablesReference": 1000, "expensive": false }] },
		"variables": { 1000: rows }
	};
}

/**
 * Label for the stack frame: the INNERMOST function whose source range contains the current position. The
 * continuation frames aren't 1:1 with function calls, so we resolve this off the AST by position instead.
 */
function functionName(pos: number | undefined): string {
	if (pos === undefined || sourceFile === undefined) {
		return "<module>";
	}

	const isFunctionLike = (node: ts.Node): boolean =>
		ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
	let best: ts.FunctionLikeDeclaration | undefined;
	let bestSpan = Infinity;

	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node) && node.getStart(sourceFile!) <= pos && pos < node.getEnd()) {
			const span = node.getEnd() - node.getStart(sourceFile!);

			if (span < bestSpan) {
				bestSpan = span;
				best = node as ts.FunctionLikeDeclaration;
			}
		}

		node.forEachChild(visit);
	};

	sourceFile.forEachChild(visit);

	if (best === undefined) {
		return "<module>";
	}

	return best.name !== undefined && ts.isIdentifier(best.name) ? best.name.text : "<anonymous>";
}

function emitStopped(vm: Vm, reason: string, traveled = false): void {
	post({ "type": "stopped", "reason": reason, "snapshot": { ...snapshot(vm), "traveled": traveled } });
}

/**
 * Pause hook for a breakpoint reached inside a synchronous host-invoked guest call (React onClick, an array
 * callback). We can't await here — the call is running on a synchronous stack driven by tsval's runSub, not
 * by our loop — so we send the stop (tagged `atomic` so the adapter resumes via the control word, not a
 * message the blocked worker can't receive) and then BLOCK the worker on Atomics.wait until the adapter
 * stores 1 + notifies. The main thread stays responsive throughout.
 */
function onBreakpointHook(vm: Vm): void {
	if (control === undefined) {
		return; // no shared control word (shouldn't happen post-launch) — resume rather than hang
	}

	// Set WAITING before posting, so an adapter that stores 1 + notifies before we reach `wait` isn't lost:
	// Atomics.wait returns immediately when the value is no longer 0.
	Atomics.store(control, 0, 0);
	post({ "type": "stopped", "reason": "breakpoint", "snapshot": { ...snapshot(vm), "traveled": false }, "atomic": true });
	Atomics.wait(control, 0, 0);
}

/** Advance `base` (a VM we own) by a forward action, then record the new stop or terminate. */
function advanceFrom(base: Vm, action: ForwardAction): void {
	try {
		switch (action) {
			case "continue": base.runToBreakpoint(); break;
			case "next": base.stepStatement(); break;
			case "stepIn": base.step(); break;
			case "stepOut": base.stepStatement(); break; // TODO: true step-out (run to caller) in a later pass
		}
	} catch (error) {
		post({ "type": "output", "text": "Uncaught " + String(error) });
		post({ "type": "terminated" });
		done = true;

		return;
	}

	if (base.finished) {
		if (base.completion !== undefined) {
			post({ "type": "output", "text": "→ " + format(base.completion) });
		}

		post({ "type": "terminated" });
		done = true;

		return;
	}

	// Branch: drop any redo tail, then record this stop. The stored fork is only ever forked from, never
	// stepped, so it stays a pristine snapshot we can return to.
	history = history.slice(0, index + 1);
	history.push(base);
	index = history.length - 1;
	emitStopped(base, action === "continue" ? "breakpoint" : "step");
}

function handle(action: Action): void {
	switch (action) {
		case "stepBack":
			if (index > 0) {
				index -= 1;
			}

			emitStopped(history[index], "step", true);
			break;

		case "reverseContinue":
			// M2: nearest earlier stop. (A true reverse-to-breakpoint scan is a later refinement.)
			if (index > 0) {
				index -= 1;
			}

			emitStopped(history[index], "breakpoint", true);
			break;

		case "disconnect":
			post({ "type": "terminated" });
			done = true;
			break;

		default:
			// Forward: fork the current stop and advance a copy (honors the action even after a step-back).
			advanceFrom(history[index].fork(), action);
			break;
	}
}

async function session(initial: Vm): Promise<void> {
	advanceFrom(initial, "continue"); // run to the first breakpoint (or completion)

	while (!done) {
		const action = await nextAction();
		handle(action);
	}
}

/**
 * React launch (M3c): run the app under tsval with native React and a reconciler-backed ReactDOM shim as
 * guest globals. The app's own `ReactDOM.createRoot(...).render(<App/>)` drives our reconciler, which streams
 * mutations to the adapter. Component/handler code is guest, so a breakpoint in it pauses via onBreakpointHook
 * (the reconciler invokes them synchronously). After mount the worker is idle, servicing `dispatch` (DOM
 * events routed back from the iframe) — each re-renders and streams more mutations.
 */
function launchReact(message: Extract<Incoming, { "type": "launch" }>): void {
	guestRoot = createGuestRoot(React, (mutation) => post({ "type": "mutation", "mutation": mutation }));

	const reactDom = {
		"createRoot": () => ({ "render": (element: unknown) => guestRoot?.render(element), "unmount": () => guestRoot?.unmount() }),
		"render": (element: unknown) => guestRoot?.render(element)
	};
	// Minimal document shim so `ReactDOM.createRoot(document.getElementById("root"))` (the idiomatic entry)
	// doesn't throw; the container arg is ignored (our root is the reconciler container).
	const documentShim = { "getElementById": () => ({}), "createElement": () => ({}), "body": {} };

	const loaded = createVM(message.source, {
		"fileName": message.fileName,
		"onBreakpoint": onBreakpointHook,
		"globals": { "React": React, "ReactDOM": reactDom, "document": documentShim }
	});
	sourceFile = loaded.sourceFile;
	loaded.vm.addBreakpointsByLine(...message.lines);

	try {
		loaded.vm.run(); // executes the module → guest render() → mount → mutations posted
	} catch (error) {
		post({ "type": "output", "text": "Uncaught " + String(error) });
	}

	post({ "type": "rendered" });
}

self.onmessage = (event: MessageEvent<Incoming>): void => {
	const message = event.data;

	switch (message.type) {
		case "launch": {
			control = new Int32Array(message.control);

			if (message.react === true) {
				launchReact(message);
				break;
			}

			const loaded = createVM(message.source, { "fileName": message.fileName, "onBreakpoint": onBreakpointHook });
			sourceFile = loaded.sourceFile;
			loaded.vm.addBreakpointsByLine(...message.lines);
			history = [];
			index = -1;
			done = false;
			void session(loaded.vm);
			break;
		}

		case "dispatch":
			guestRoot?.dispatch(message.id, message.event);
			post({ "type": "history", "length": guestRoot?.historyLength() ?? 0 });
			break;

		case "timeTravel":
			guestRoot?.timeTravel(message.index);
			break;

		case "setBreakpoints":
			// Re-point breakpoints on every stored fork so time-traveled forward runs honor the new set.
			for (const vm of history) {
				vm.breakpoints.clear();
				vm.addBreakpointsByLine(...message.lines);
			}
			break;

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut":
		case "stepBack":
		case "reverseContinue":
		case "disconnect":
			if (awaitAction !== undefined) {
				const resolve = awaitAction;
				awaitAction = undefined;
				resolve(message.type);
			}
			break;
	}
};
