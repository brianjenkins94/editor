/**
 * tsval debug worker (M1) — runs the target program under tsval's stepping VM in a dedicated worker, and
 * speaks a tiny control protocol to the debug adapter (see debug-adapter.ts) that the adapter maps onto DAP.
 *
 * Pausing here is ASYNC, not Atomics-blocked: the whole program is driven by THIS worker's own loop
 * (`runToBreakpoint`/`stepStatement`/`step`), so to "pause" the loop simply awaits the next control message.
 * Atomics.wait only becomes necessary in M3, when native React synchronously invokes guest code and we must
 * block a synchronous call stack. For a plain program the loop owns execution, so awaiting suffices.
 *
 * Before pausing, the worker sends the adapter a COMPLETE snapshot of the stop (frames + scopes + variables),
 * so the adapter can answer every stackTrace/scopes/variables request from it without a round-trip — which
 * also keeps the door open for the M3 Atomics model, where a blocked worker can't service messages at all.
 */
import ts from "typescript";

import { createVM, type LoadedVM } from "@brianjenkins94/tsval";

/** Control messages from the adapter. */
type Incoming =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[] }
	| { "type": "setBreakpoints"; "lines": number[] }
	| { "type": "continue" | "next" | "stepIn" | "stepOut" | "disconnect" };

type StepAction = "continue" | "next" | "stepIn" | "stepOut" | "disconnect";

interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }
interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number }[];
	/** frameId → its scopes. */
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	/** variablesReference → its rows. */
	"variables": Record<number, Variable[]>;
}

const post = (message: Record<string, unknown>): void => { (self as unknown as Worker).postMessage(message); };

let loaded: LoadedVM | undefined;
/** Resolver for the control message the drive loop is currently awaiting (set only while paused). */
let awaitAction: ((action: StepAction) => void) | undefined;

function nextAction(): Promise<StepAction> {
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
 * Build a DAP-ready snapshot of the current stop. M1 is deliberately a SINGLE frame at the current node with
 * one "Locals" scope: the in-scope program bindings, walked from the current (top) scope up through its
 * parents (inner shadows outer). Standard globals live on the global object, not as scope bindings, so
 * including the root scope surfaces the program's top-level vars without dumping the whole global namespace.
 * Reconstructing a multi-frame call stack from the CEK continuation frames is a later refinement.
 */
function snapshot(): Snapshot {
	const vm = loaded!.vm;
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
 * continuation frames aren't 1:1 with function calls, so we resolve this off the AST by position instead —
 * walk the SourceFile, and among the function-like nodes spanning `pos`, keep the deepest.
 */
function functionName(pos: number | undefined): string {
	if (pos === undefined || loaded === undefined) {
		return "<module>";
	}

	const isFunctionLike = (node: ts.Node): boolean =>
		ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
	let best: ts.FunctionLikeDeclaration | undefined;
	let bestSpan = Infinity;

	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node) && node.getStart(loaded!.sourceFile) <= pos && pos < node.getEnd()) {
			const span = node.getEnd() - node.getStart(loaded!.sourceFile);

			if (span < bestSpan) {
				bestSpan = span;
				best = node as ts.FunctionLikeDeclaration;
			}
		}

		node.forEachChild(visit);
	};

	loaded.sourceFile.forEachChild(visit);

	if (best === undefined) {
		return "<module>";
	}

	return best.name !== undefined && ts.isIdentifier(best.name) ? best.name.text : "<anonymous>";
}

/** The drive loop: perform the pending action, then either terminate or emit a stop and await the next. */
async function drive(): Promise<void> {
	const vm = loaded!.vm;
	let action: StepAction = "continue"; // first run: continue to the first breakpoint (or completion)

	for (;;) {
		try {
			switch (action) {
				case "continue": vm.runToBreakpoint(); break;
				case "next": vm.stepStatement(); break;
				case "stepIn": vm.step(); break;
				case "stepOut": vm.stepStatement(); break; // TODO: true step-out (run to caller) in a later pass
				case "disconnect": post({ "type": "terminated" }); return;
			}
		} catch (error) {
			post({ "type": "output", "text": "Uncaught " + String(error) });
			post({ "type": "terminated" });

			return;
		}

		if (vm.finished) {
			if (vm.completion !== undefined) {
				post({ "type": "output", "text": "→ " + format(vm.completion) });
			}

			post({ "type": "terminated" });

			return;
		}

		post({ "type": "stopped", "reason": action === "continue" ? "breakpoint" : "step", "snapshot": snapshot() });
		action = await nextAction();
	}
}

self.onmessage = (event: MessageEvent<Incoming>): void => {
	const message = event.data;

	switch (message.type) {
		case "launch":
			loaded = createVM(message.source, { "fileName": message.fileName });
			loaded.vm.addBreakpointsByLine(...message.lines);
			void drive();
			break;

		case "setBreakpoints":
			if (loaded !== undefined) {
				loaded.vm.breakpoints.clear();
				loaded.vm.addBreakpointsByLine(...message.lines);
			}
			break;

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut":
		case "disconnect":
			if (awaitAction !== undefined) {
				const resolve = awaitAction;
				awaitAction = undefined;
				resolve(message.type);
			}
			break;
	}
};
