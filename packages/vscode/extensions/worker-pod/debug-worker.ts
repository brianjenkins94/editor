/**
 * tsval debug worker — runs the target program under tsval's stepping VM and adds TIME TRAVEL. It speaks
 * debug-protocol.ts over the pod hub: control arrives on its session's control subject, stops and output go out on its
 * event subject, and a React app's render stream goes straight to the render surface.
 *
 * Pausing is ASYNC: the whole program is driven by THIS worker's own loop (`runToBreakpoint`/`stepStatement`/`step`),
 * so to "pause" the loop simply awaits the next control message. The exception is a breakpoint inside a guest call the
 * host makes synchronously (native React calling a handler): that blocks the worker on Atomics.wait until the adapter
 * resumes it through the shared control word (see onBreakpointHook).
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
import type { LoadedVM } from "@brianjenkins94/tsval";
import type { TraceEvent } from "@brianjenkins94/tsval";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import { givenResult, ruleMatches } from "@brianjenkins94/util/silo/policy";
import type { CapabilityAsk, Control, CoverageReport, Explored, PreviewMessage, SetHook, Snapshot, Variable, WorkerEvent } from "./debug-protocol";
import type { SiteSums } from "./site-sums";
import type { GuestRoot } from "./debug-react";

import { createHub, portTransport } from "@brianjenkins94/hub";
import { createVM, explore, runToEnd, UNCATCHABLE } from "@brianjenkins94/tsval";
import React from "react";

import ts from "typescript";
import { capabilityBreakLines, classifyCall, shouldBreak } from "../capabilities/capability-breakpoints";
import { capabilityStandins, givenAs, inert, standinCapability } from "../capabilities/canary";
import { NETWORK_PROBES } from "../../architecture";
import { observe } from "@brianjenkins94/observability";
import { controlSubject, eventSubject, PREVIEW_STREAM } from "./debug-protocol";
import { createGuestRoot } from "./debug-react";
import { LiveRecord } from "./live-values";
import { addObservation, copySums, siteObservations } from "./site-sums";

// This worker's own hub, linked UP to the pod hub. The whole debug protocol rides it (debug-protocol.ts), on its
// session's subjects — the adapter puts the session id in our URL. It announces `pod.ready` after launch.
const hub = createHub({ "id": "debug-worker" });
const SESSION = new URL(location.href).searchParams.get("session") ?? "";

hub.link(portTransport(globalThis));

// This worker's util/logger spans/records federate UP through the pod (which links our hub) to the root
// collector — so a step's span shows up in the top-page timeline with no worker→page window path of its own.
// (With its uncaught errors, and its hub + own requests on $sys.arch.)
const { "log": workerLog } = observe(hub, { "network": NETWORK_PROBES });

type Vm = LoadedVM["vm"];

/** A span's cross-context trace context: the hub envelope of a control message that triggers work carries the
 *  adapter action's, so this worker's span continues the adapter's trace (see continueSpan). */
interface TraceContext { "traceId": string; "parentSpanId": string }

type Action = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect";
type ForwardAction = "continue" | "next" | "stepIn" | "stepOut";

/** An event for the adapter, on this session's event subject. */
function post(message: WorkerEvent): void { hub.publish(eventSubject(SESSION), message); }

/** Straight to the render surface — the render stream doesn't pass through the adapter. */
function toPreview(message: PreviewMessage): void { hub.publish(PREVIEW_STREAM, message); }

let sourceFile: ts.SourceFile | undefined;
/** The session's live values (LIVE-VALUES.md): what each line bound, returned or chose, told to the adapter a few times
 *  a second, and before each stop and the end. */
const live = new LiveRecord();
let liveTimer: ReturnType<typeof setInterval> | undefined;
/** 1-based lines pre-armed as capability breakpoints (policy said stop) — so a stop there reports reason
 *  "capability" rather than "breakpoint". Computed at launch from the policy the adapter sent. */
let capabilityLines = new Set<number>();
/** The policy the run is under (the adapter's, updated after an "Allow always"); none, no capability stops. */
let policy: Policy | undefined;
/** The user's breakpoints (1-based lines), armed beside the capability lines. */
let userLines: number[] = [];
/** The statements rules set something after (RULES.md: *set variables.<name>*, *at* a place), by 1-based line: armed
 *  as breakpoints that aren't stops — the statement runs, the sets are made, the run goes on. */
let setHooks = new Map<number, SetHook[]>();
/** The program, workspace-relative: the subject's `program` at a hook. */
let programPath = "";
/** "Deny" at a capability stop: the next capability call fails, as a denied one would. Reset at every stop. */
let denyNext = false;
/** The result the user gave the call at a capability stop, once (`decide` with `give`): the next stand-in call returns it. */
let giveNext: { "value": unknown } | undefined;
/** The last value traced: its call, its loops' turns and its step — where a value set at a stop is recorded. */
let lastTraced: { "call": number; "turns": number[]; "step": number } | undefined;
/** Forks, one per stop reached; `index` is the currently-displayed stop. */
let history: Vm[] = [];
let index = -1;
let done = false;
/** Resolver for the control message the session loop is currently awaiting (top-level, async pause). */
let awaitAction: ((action: Action) => void) | undefined;
/** Trace context of the control message currently being handled — so the step span it drives continues the
 *  adapter's trace (one cross-context trace per debug action). Set just before the awaited action resolves. */
let actionTrace: TraceContext | undefined;
/**
 * Shared control word for the SYNCHRONOUS in-handler pause (M3b). A breakpoint reached inside a host-invoked
 * guest call (e.g. React's onClick) can't pause by awaiting — the call is on a synchronous stack the worker
 * loop doesn't drive — so the onBreakpoint hook blocks the whole worker on `Atomics.wait` while the main
 * thread stays live, and the adapter resumes it via `Atomics.notify`. control[0]: 0 = waiting, 1 = go.
 */
let control: Int32Array | undefined;
/** In React mode, the reconciler root the guest app renders into (see launchReact). */
let guestRoot: GuestRoot | undefined;
/** The VM on the timeline being shown — what coverage reports on. A forward step advances a fork; a step back
 *  returns to an earlier stop. */
let current: Vm | undefined;
/** Where the run's event loop started (its clock then), for times shown since; and what a wait costs (Skip Waits). */
let loopStart = 0;
let pace: "real" | "fast" = "real";
/** What went through each observed site on each timeline (tsval's `observe`), and the sums being added to now — the
 *  timeline running. A fork starts from a copy of its stop's sums, as its coverage starts from a copy of its counts. */
const sumsOf = new WeakMap<Vm, SiteSums>();
let recording: SiteSums = new Map();

/** tsval's `observe`: what went through a site, added to the running timeline's sums (not a probe's: it didn't run). */
function observeSite(node: ts.Node, site: Parameters<typeof addObservation>[2], value: unknown): void {
	if (probing === undefined) {
		addObservation(recording, node, site, value);
	}
}

/** A probe running (probeResource): the capability whose call it's after, and the resource that call reached. */
let probing: { "capability": string; "resource"?: string } | undefined;
/** What ends a probe's fork at the call — uncatchable, so the guest's own try/catch can't swallow it. */
const PROBED = Object.assign(new Error("probe: the call reached"), { [UNCATCHABLE]: true });
/** Each stop's probed resource, by machine and line: a stop asks more than once. */
const probed = new WeakMap<Vm, Map<number, string | undefined>>();

/**
 * The resource a capability call on `line` reaches, when its argument is computed on the line itself
 * (`path.join(dir, name)`, a template): the machine forked at the stop and stepped until the call — its arguments
 * evaluated as the run will evaluate them, every capability call on the way its inert stand-in, the event loop
 * deterministic — then thrown away. Undefined if the fork doesn't get there (it threw first, or took too long).
 */
function probeResource(vm: Vm, line: number, capability: string): string | undefined {
	const known = probed.get(vm);

	if (known?.has(line) === true) {
		return known.get(line);
	}

	const fork = vm.fork();
	let resource: string | undefined;

	fork.breakpoints.clear();
	probing = { "capability": capability };

	try {
		for (let steps = 0; steps < 20_000 && !fork.finished && !fork.idle && probing.resource === undefined; steps += 1) {
			fork.step();
		}
	} catch {
		// PROBED (the call reached), or the fork threw before it: either way, what was found is what there is.
	} finally {
		resource = probing.resource;
		probing = undefined;
	}

	probed.set(vm, (known ?? new Map()).set(line, resource));

	return resource;
}

/** Start recording `vm`'s observations into `sums`. */
function record(vm: Vm, sums: SiteSums): void {
	sumsOf.set(vm, sums);
	recording = sums;
}

function nextAction(): Promise<Action> {
	return new Promise((resolve) => { awaitAction = resolve; });
}

/**
 * A debugged tsval run gets the SAME zero-authority capability surface the canary uses (shared `capabilityStandins`):
 * `fetch` and node builtins (`node:fs`, `node:child_process`, …) resolve to inert, effect-free stand-ins, and any
 * OTHER import resolves to a recursive inert proxy. Without this the guest crashes on the first `import` of a node
 * builtin (there is no real module system in the worker) BEFORE reaching a capability breakpoint — the whole point of
 * the hard-stop. Real effects belong to the almostnode "production" adapter, not to tsval's reverse-steppable VM.
 */
function capabilitySurface(fileName: string, args: string[]): { "globals": Record<string, unknown>; "resolveModule": (specifier: string) => unknown } {
	const standins = denying(capabilityStandins());
	// What a script reads of its process: its arguments (a run's inputs), and a workspace to be in — nothing it can do.
	const process = { "argv": ["node", fileName, ...args], "env": {}, "platform": "browser", "cwd": () => "/workspace" };

	return {
		"globals": { ...standins.globals, "console": guestConsole(), "process": process },
		"resolveModule": (specifier: string) => (Object.hasOwn(standins.modules, specifier) ? standins.modules[specifier] : inert())
	};
}

/** The stand-ins, each failing when the user denied its call at a capability stop (`denyNext`) — with node's EACCES, as
 *  the call would fail if the policy denied it — and returning the result a rule gives its call (RULES.md, slice 2), or
 *  the user gave it at the stop (`giveNext`), instead of an inert one. (A module object shared under several names stays
 *  one object.) */
function denying(standins: ReturnType<typeof capabilityStandins>): ReturnType<typeof capabilityStandins> {
	const wrapped = new Map<unknown, unknown>();
	const gate = (fn: (...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]): unknown {
		// A probe's fork (probeResource): the call it's after records what it reaches, and ends the fork there; any other
		// call on the way is its inert self — neither touches what the run itself was given (denyNext, giveNext).
		if (probing !== undefined) {
			const tagged = standinCapability(fn);

			if (tagged?.capability === probing.capability) {
				const resource = args[tagged.resourceArg];

				probing.resource = typeof resource === "string" ? resource : resource instanceof URL ? resource.href : undefined;

				throw PROBED;
			}

			return fn.apply(this, args);
		}

		if (denyNext) {
			denyNext = false;

			throw Object.assign(new Error("EACCES: permission denied (denied at its capability stop)"), { "code": "EACCES" });
		}

		const real = fn.apply(this, args);
		const tagged = standinCapability(fn);

		if (tagged === undefined) {
			return real;
		}

		const resource = args[tagged.resourceArg];
		const given = giveNext ?? (policy === undefined ? undefined : givenResult(policy, { "capability": tagged.capability, "resource": typeof resource === "string" ? resource : resource instanceof URL ? resource.href : "" }));

		giveNext = undefined;

		return given === undefined ? real : givenAs(tagged.capability, real, given.value);
	};
	const wrap = (value: unknown): unknown => {
		if (!wrapped.has(value)) {
			wrapped.set(value, typeof value === "function" ? gate(value as (...args: unknown[]) => unknown) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, member]) => [key, typeof member === "function" ? gate(member as (...args: unknown[]) => unknown) : member])) : value);
		}

		return wrapped.get(value);
	};

	return { "globals": Object.fromEntries(Object.entries(standins.globals).map(([key, value]) => [key, wrap(value)])), "modules": Object.fromEntries(Object.entries(standins.modules).map(([key, value]) => [key, wrap(value)])) };
}

/** `text` as the value it writes, when it's a literal — a string, a number, a boolean, null or undefined, or an array or
 *  object of those — so setting a value can't run code. */
function literalOf(text: string): { "value": unknown } | { "error": string } {
	const file = ts.createSourceFile("value.ts", `(${text})`, ts.ScriptTarget.Latest, true);
	const [statement] = file.statements;
	const read = (node: ts.Node): unknown => {
		if (ts.isParenthesizedExpression(node)) {
			return read(node.expression);
		}

		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return node.text;
		}

		if (ts.isNumericLiteral(node)) {
			return Number(node.text);
		}

		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
			return -Number(node.operand.text);
		}

		if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
			return node.kind === ts.SyntaxKind.TrueKeyword;
		}

		if (node.kind === ts.SyntaxKind.NullKeyword) {
			return null;
		}

		if (ts.isIdentifier(node) && ["undefined", "NaN", "Infinity"].includes(node.text)) {
			return { "undefined": undefined, "NaN": Number.NaN, "Infinity": Number.POSITIVE_INFINITY }[node.text];
		}

		if (ts.isArrayLiteralExpression(node)) {
			return node.elements.map(read);
		}

		if (ts.isObjectLiteralExpression(node)) {
			return Object.fromEntries(node.properties.map((property) => {
				if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) {
					throw new Error("only plain properties");
				}

				return [property.name.text, read(property.initializer)];
			}));
		}

		throw new Error(`not a literal: ${node.getText(file)}`);
	};

	try {
		if (file.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement) || file.parseDiagnostics.length > 0) {
			throw new Error("not a value");
		}

		return { "value": read(statement.expression) };
	} catch (error) {
		return { "error": `${text} — ${error instanceof Error ? error.message : String(error)} (a literal: 'text', 4, true, null, [1, 2], { a: 1 })` };
	}
}

/** At the stop `vm` is at: `name`, a variable in scope there, set to `text`'s literal — and recorded with the run's values,
 *  on the stop's line, as set by hand. */
function setValue(vm: Vm, name: string, text: string, overConst = false): Extract<WorkerEvent, { "type": "valueSet" }> {
	const literal = literalOf(text);

	if ("error" in literal) {
		return { "type": "valueSet", "ok": false, "error": literal.error };
	}

	for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
		const binding = scope.bindings.get(name);

		if (binding !== undefined) {
			// A rule mocks it, const or not; Set Value at a stop does as code can.
			if (binding.kind === "const" && !overConst) {
				return { "type": "valueSet", "ok": false, "error": `${name} is a const` };
			}

			if (!binding.initialized) {
				return { "type": "valueSet", "ok": false, "error": `${name} isn't declared yet here` };
			}

			binding.value = vm.fromHost(literal.value);

			const at = vm.location();

			if (at !== null) {
				live.add({ "line": at.line, "name": name, "value": "", "raw": binding.value, "kind": "set", "call": lastTraced?.call ?? 0, "turns": lastTraced?.turns ?? [], "step": lastTraced?.step ?? 0, ...vm.currentNode === null ? {} : { "at": rangeOf(vm.currentNode) } });
				flushLive();
			}

			return { "type": "valueSet", "ok": true, "value": format(binding.value), "snapshot": snapshot(vm) };
		}
	}

	return { "type": "valueSet", "ok": false, "error": `no ${name} in scope here` };
}

/** Arm `vm`'s breakpoints: the user's, the capability calls the policy gates, and the statements rules set after. */
function arm(vm: Vm): void {
	vm.breakpoints.clear();
	vm.addBreakpointsByLine(...userLines, ...capabilityLines, ...setHooks.keys());
}

/** Whether a run reaching `line` stops there: a breakpoint of the user's, or a capability call the policy gates. */
function stopsAt(vm: Vm, line: number): boolean {
	return userLines.includes(line) || (capabilityLines.has(line) && askAt(vm, line) !== undefined);
}

/** The values of the variables in scope that a rule can test: strings, numbers, booleans, null — the innermost of a name. */
function scopeValues(vm: Vm): Record<string, unknown> {
	const values: Record<string, unknown> = {};

	for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
		for (const [name, binding] of scope.bindings) {
			if (!(name in values) && binding.initialized && (binding.value === null || ["string", "number", "boolean"].includes(typeof binding.value))) {
				values[name] = binding.value;
			}
		}
	}

	return values;
}

/** The statement on `line` has run: make the sets of the rules placed there that match here. */
function applySets(vm: Vm, line: number): void {
	const variables = scopeValues(vm);

	for (const { place, rule } of setHooks.get(line) ?? []) {
		if (!ruleMatches(rule, { "program": programPath, "at": place, "variables": variables })) {
			continue;
		}

		for (const action of rule.then) {
			if (action.action_id === "set" && action.target_id?.startsWith("variables.") === true) {
				const name = action.target_id.slice("variables.".length);
				const result = setValue(vm, name, JSON.stringify(action.argument), true);

				if (!result.ok) {
					post({ "type": "output", "text": `A rule couldn't set ${name}: ${result.error ?? ""}`, "stream": "stderr" });
				}
			}
		}
	}
}

/** At statements rules set something after, one after another: run each and make its sets. True when that lands
 *  where the run stops (or at its end). */
function passHooks(base: Vm): boolean {
	let line = atLine(base);
	let passed = false;

	while (!base.finished && line !== undefined && setHooks.has(line)) {
		if (passed && stopsAt(base, line)) {
			return true;
		}

		base.stepStatement();
		applySets(base, line);
		passed = true;
		line = atLine(base);
	}

	return passed && (base.finished || (line !== undefined && stopsAt(base, line)));
}

/** Continue: run to the next stop — through the statements rules set after (each run, then its sets made) and the
 *  capability lines the policy now lets pass. From a stop on a statement a rule sets after, that statement first. */
function runOn(base: Vm): void {
	if (history.length > 0 && passHooks(base)) {
		return;
	}

	for (;;) {
		base.runToBreakpoint();

		const line = atLine(base);

		if (base.finished || line === undefined) {
			return;
		}

		if (setHooks.has(line) && !stopsAt(base, line)) {
			if (passHooks(base)) {
				return;
			}

			continue;
		}

		// A capability line whose calls the policy now lets pass (allowed always since it was armed, or its resource
		// allowed once known) isn't a stop: go on, unless the user has a breakpoint there too.
		if (capabilityLines.has(line) && !userLines.includes(line) && askAt(base, line) === undefined) {
			continue;
		}

		return;
	}
}

/** What the capability stop at `line` (1-based) asks: the first call on it the policy gates, with the resource it would
 *  reach as far as it's known before the line runs — undefined when the policy now lets every call on it pass. */
function askAt(vm: Vm, line: number): CapabilityAsk | undefined {
	const file = sourceFile;

	if (file === undefined || policy === undefined) {
		return undefined;
	}

	const calls: ts.CallExpression[] = [];

	(function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && file.getLineAndCharacterOfPosition(node.getStart(file)).line === line - 1) {
			calls.push(node);
		}

		node.forEachChild(visit);
	})(file);

	for (const call of calls) {
		const hit = classifyCall(call, []);

		if (hit !== undefined) {
			const before = resourceOf(vm, call.arguments[hit.argIndex], file);
			// Computed on the line: what it will be, from a fork run to the call.
			const probe = before.resolved ? undefined : probeResource(vm, line, hit.capability);
			const { resource, resolved } = probe === undefined ? before : { "resource": probe, "resolved": true };

			if (shouldBreak(policy, { ...hit, "resource": resolved ? resource : "" })) {
				return { "line": line - 1, "at": rangeOf(call), "capability": hit.capability, "callee": hit.callee, "resource": resource, "resolved": resolved, "dangerous": hit.dangerous };
			}
		}
	}

	return undefined;
}

/** An argument's value before its line runs: a literal's text, a variable's value (a string) — resolved — else the
 *  argument as written. */
function resourceOf(vm: Vm, argument: ts.Expression | undefined, file: ts.SourceFile): { "resource": string; "resolved": boolean } {
	if (argument === undefined) {
		return { "resource": "", "resolved": false };
	}

	if (ts.isStringLiteralLike(argument)) {
		return { "resource": argument.text, "resolved": true };
	}

	if (ts.isIdentifier(argument)) {
		for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
			for (const [name, binding] of scope.bindings) {
				if (name === argument.text && binding.initialized && typeof binding.value === "string") {
					return { "resource": binding.value, "resolved": true };
				}
			}
		}
	}

	return { "resource": argument.getText(file), "resolved": false };
}

/** A console argument the way node's console prints it: strings bare, everything else JSON-ish. */
function formatLogArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "function") {
		return "[Function: " + ((value as { "name"?: string }).name || "(anonymous)") + "]";
	}

	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value); // circular, or a BigInt
	}
}

/** The program's console: what it logs goes to the Debug Console (warn/error as stderr), and nothing else happens. */
/**
 * Every ordering of the program's events (tsval's explore): each run fresh, with the stand-ins a debug run has — so
 * every host call answers at once, and which answer comes first, or whether one comes before a timer, is the choice —
 * no breakpoints, no stops. Each distinct ending: what it printed (a crash too — a throw, or a rejection nothing
 * handled), a schedule that gets there, and the events chosen along it.
 */
async function exploreOrderings(message: Extract<Control, { "type": "explore" }>): Promise<Explored> {
	policy = message.policy;

	const found = await explore(async (schedule) => {
		const output: string[] = [];
		const surface = capabilitySurface(message.fileName, message.args ?? []);
		const write = (...args: unknown[]): void => { output.push(args.map(formatLogArg).join(" ")); };
		const console = Object.fromEntries(["log", "info", "debug", "dir", "warn", "error", "trace"].map((name) => [name, write]));
		const { vm } = createVM(message.source, { "fileName": message.fileName, "globals": { ...surface.globals, "console": console }, "resolveModule": surface.resolveModule, "eventLoop": { ...message.eventLoop, "schedule": schedule, "pace": "fast" } });
		let crash: string | undefined;
		const unhandled = (event: PromiseRejectionEvent): void => {
			crash ??= event.reason instanceof Error ? event.reason.message : String(event.reason);
			event.preventDefault();
		};

		globalThis.addEventListener("unhandledrejection", unhandled);

		try {
			await runToEnd(vm);
		} catch (error) {
			crash = error instanceof Error ? error.message : String(error);
		} finally {
			// A rejection nothing handled is told a turn later.
			await new Promise((resolve) => { setTimeout(resolve, 0); });
			globalThis.removeEventListener("unhandledrejection", unhandled);
		}

		return { "outcome": { "output": output, ...crash === undefined ? {} : { "crash": crash } }, "choices": vm.choices };
	}, { "maxRuns": message.maxRuns ?? 100 });

	return {
		"runs": found.runs,
		"complete": found.complete,
		"eventLoop": message.eventLoop,
		"outcomes": found.outcomes.map(({ outcome, schedule, choices, runs }) => ({ ...outcome, "schedule": schedule, "path": choices.map((choice) => choice.candidates[choice.picked]!.label), "runs": runs }))
	};
}

function guestConsole(): Record<string, (...args: unknown[]) => void> {
	// (Not a probe's: it didn't run.)
	const write = (stream: "stdout" | "stderr") => (...args: unknown[]): void => {
		if (probing === undefined) {
			post({ "type": "output", "text": args.map(formatLogArg).join(" "), "stream": stream });
		}
	};

	return { "log": write("stdout"), "info": write("stdout"), "debug": write("stdout"), "dir": write("stdout"), "warn": write("stderr"), "error": write("stderr"), "trace": write("stderr") };
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
		"frames": [{ "id": 1, "name": functionName(loc?.pos), "line": (loc?.line ?? 0) + 1, "column": (loc?.character ?? 0) + 1, ...vm.currentNode === null ? {} : { "at": rangeOf(vm.currentNode) } }],
		"scopes": { "1": [{ "name": "Locals", "variablesReference": 1000, "expensive": false }, ...vm.loop === undefined ? [] : [{ "name": "Event loop", "variablesReference": 2000, "expensive": false }]] },
		"variables": { "1000": rows, ...vm.loop === undefined ? {} : { "2000": loopRows(vm.loop) } }
	};
}

/** The event loop at a stop, as the Variables view shows it: the virtual clock (since the run started, and its date),
 *  the pace, each timer pending and when it's due, each host call's result the program is owed — in, or not yet — and
 *  how many choices were made. */
function loopRows(loop: NonNullable<Vm["loop"]>): Variable[] {
	const since = (ms: number): string => `+${ms - loopStart}ms`;
	const row = (name: string, value: string, type: string): Variable => ({ "name": name, "value": value, "type": type, "variablesReference": 0 });
	const timers = [...loop.timers.values()].sort((a, b) => a.due - b.due || a.seq - b.seq);

	return [
		row("time", `${since(loop.clock)} · ${new Date(loop.clock).toISOString()}`, "virtual clock"),
		row("pace", loop.pace === "fast" ? "skipping waits" : "real time", ""),
		...timers.slice(0, 20).map((timer) => row(`${timer.interval ? "setInterval" : timer.delay === 0 ? "setImmediate" : "setTimeout"} ${timer.delay}ms`, `due ${since(timer.due)}${timer.ref ? "" : " · unref'd"}`, "timer")),
		...timers.length > 20 ? [row("…", `${timers.length - 20} more timers`, "")] : [],
		...[...loop.results.values()].map((result) => row(result.label, result.deliver === undefined ? "not in yet" : "in — waiting its turn", "result")),
		row("choices made", String(loop.choices.length), "")
	];
}

/**
 * Label for the stack frame: the INNERMOST function whose source range contains the current position. The
 * continuation frames aren't 1:1 with function calls, so we resolve this off the AST by position instead.
 */
function functionName(pos: number | undefined): string {
	if (pos === undefined || sourceFile === undefined) {
		return "<module>";
	}

	const isFunctionLike = (node: ts.Node): boolean => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
	let best: ts.FunctionLikeDeclaration | undefined;
	let bestSpan = Infinity;

	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node) && node.getStart(sourceFile) <= pos && pos < node.getEnd()) {
			const span = node.getEnd() - node.getStart(sourceFile);

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

/** What tsval's trace told, into the session's live values: its line, and its call's function by name and line. */
function traceValue(event: TraceEvent): void {
	if (sourceFile === undefined || probing !== undefined) {
		return; // (a probe's fork didn't run)
	}

	const lineOf = (node: ts.Node): number => sourceFile!.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
	const callee = event.callee === undefined ? undefined : { "name": calleeName(event.callee), "line": lineOf(event.callee), "at": rangeOf(event.callee) };

	lastTraced = { "call": event.call, "turns": event.loops.map((loop) => loop.turn), "step": event.step };
	live.add({ "line": lineOf(event.node), "name": event.name, "value": "", "raw": event.value, "kind": event.kind, "call": event.call, "turns": lastTraced.turns, "step": event.step, "at": rangeOf(event.node), ...callee === undefined ? {} : { "callee": callee } });
}

/** The run's process.argv, as the margin shows it (a command line: what Mock takes), on the first line reading it — if
 *  the program reads it at all. */
function reportArgv(file: ts.SourceFile, args: string[]): void {
	let read: ts.Node | undefined;

	(function visit(node: ts.Node): void {
		if (read === undefined && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "argv") {
			read = node;
		}

		node.forEachChild(visit);
	})(file);

	if (read !== undefined) {
		live.add({ "line": file.getLineAndCharacterOfPosition(read.getStart(file)).line, "name": "process.argv", "value": args.map((arg) => (arg === "" || /[\s"'|]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" "), "kind": "input", "call": 0, "turns": [], "step": 0, "at": [read.getStart(file), read.getEnd()] });
	}
}

/** A node's range in the text that ran (offsets, from its first token): what the margin anchors a line's data by — for
 *  a node with a body, its head (`headOf`). */
function rangeOf(node: ts.Node): [number, number] {
	const head = headOf(node);

	return [head.getStart(sourceFile), head.getEnd()];
}

/** What stands for `node` on the code through a reformat: a statement with a body by its head — an `if`'s or a loop's
 *  condition, a `for`'s header, a function's or a class's name — since its whole span changes with any token in its
 *  body (BABLR's identity for a node includes its children's tokens: a semicolon dropped inside orphans it); anything
 *  else itself. The head starts the line the statement does, where its marks go. */
function headOf(node: ts.Node): ts.Node {
	// (Not a `do … while`: its condition ends it, on another line than its marks.)
	if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isSwitchStatement(node) || ts.isWithStatement(node)) {
		return node.expression;
	}

	if (ts.isForStatement(node)) {
		return node.initializer ?? node.condition ?? node.incrementor ?? node;
	}

	if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
		return node.initializer;
	}

	if (ts.isLabeledStatement(node)) {
		return node.label;
	}

	if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
		return node.name;
	}

	// An unnamed function: its first parameter, or the variable it's assigned to.
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		return node.parameters[0] ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : node);
	}

	return node;
}

/** A function's name as the panel lists its calls: its own, a method's, or the variable an arrow was assigned to. */
function calleeName(node: ts.Node): string {
	const named = (node as { "name"?: ts.Node }).name;

	if (named !== undefined && (ts.isIdentifier(named) || ts.isPrivateIdentifier(named))) {
		return named.text;
	}

	return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : "anonymous";
}

/** Tell the adapter the live values new since it was last told. */
function flushLive(): void {
	const batch = live.drain();

	if (batch !== undefined) {
		post({ "type": "values", "batch": batch });
	}
}

function emitStopped(vm: Vm, reason: string, traveled = false, ask?: CapabilityAsk): void {
	denyNext = false;
	flushLive();
	post({ "type": "stopped", "reason": reason, "snapshot": { ...snapshot(vm), "traveled": traveled }, ...ask === undefined ? {} : { "ask": ask } });
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
	flushLive();
	post({ "type": "stopped", "reason": "breakpoint", "snapshot": { ...snapshot(vm), "traveled": false }, "atomic": true });
	Atomics.wait(control, 0, 0);
}

/** Every statement tsval can run (see its isStatement: blocks and declarations never take a step of their own), with
 *  how often `current` has run each — 0 for the ones it hasn't. */
function coverageReport(): CoverageReport {
	const file = sourceFile;
	const counts = current?.coverage;
	const statements: CoverageReport["statements"] = [];

	if (file === undefined) {
		return { "file": "", "statements": statements, "sites": [] };
	}

	const visit = (node: ts.Node): void => {
		if (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement) {
			const start = file.getLineAndCharacterOfPosition(node.getStart(file));
			const end = file.getLineAndCharacterOfPosition(node.getEnd());

			statements.push({ "start": [start.line, start.character], "end": [end.line, end.character], "count": counts?.get(node) ?? 0, "anchor": rangeOf(node) });
		}

		node.forEachChild(visit);
	};

	file.forEachChild(visit);

	return { "file": file.fileName, "statements": statements, "sites": siteObservations(current === undefined ? undefined : sumsOf.get(current), file) };
}

/** The program is over: report its coverage, then end the session — with 1 for a program that threw, as node would, and
 *  where it threw. */
function finish(exitCode = 0, crash?: { "line": number; "at": [number, number]; "message": string }): void {
	clearInterval(liveTimer);
	flushLive();
	post({ "type": "coverage", "report": coverageReport(), "final": true });
	post({ "type": "terminated", "exitCode": exitCode, ...crash === undefined ? {} : { "crash": crash } });
}

/** The 1-based line `vm` is stopped at. */
function atLine(vm: Vm): number | undefined {
	const location = vm.location();

	return location === null ? undefined : location.line + 1;
}

/** Where `error` was thrown, for the margin's mark: by now the frames have unwound, so tsval's note of it, not the
 *  current node. Best-effort — the run ends whatever this finds. */
function crashOf(vm: Vm, error: unknown): { "line": number; "at": [number, number]; "message": string } | undefined {
	try {
		const site = vm.throwSite(error);
		const at = vm.location(site);

		return at === null || site === null ? undefined : { "line": at.line, "at": rangeOf(site), "message": String(error) };
	} catch {
		return undefined;
	}
}

/** Guest call depth: the `call`/`construct` frames on the control stack (the rest are expression/statement frames). */
function callDepth(vm: Vm): number {
	let depth = 0;

	for (const frame of vm.frames) {
		if (frame.kind === "call" || frame.kind === "construct") {
			depth += 1;
		}
	}

	return depth;
}

/** Run until the current guest function has returned and the caller reaches its next statement, stopping early at a
 *  breakpoint. At top level (depth 0) nothing can return, so this runs to the next breakpoint or the end, as in VS Code. */
function stepOut(vm: Vm): void {
	const depth = callDepth(vm);

	vm.step();
	// (A statement a rule only sets after isn't a stop.)
	vm.runUntil((current) => (current.atBreakpoint() && (atLine(current) === undefined || !setHooks.has(atLine(current)!) || stopsAt(current, atLine(current)!))) || (current.atStatementBoundary() && callDepth(current) < depth));
}

/** Advance `base` (a VM we own) by a forward action, then record the new stop or terminate. When the action
 *  carried a `trace` (the adapter's action span), the step span CONTINUES that trace, so a debug step is one
 *  cross-context trace (adapter action → worker step) rather than an unrelated root. */
/** Do `action` on `base`, as far as it goes without waiting. */
function act(base: Vm, action: ForwardAction): void {
	switch (action) {
		case "continue": runOn(base); break;
		case "next": {
			const from = atLine(base);

			base.stepStatement();

			// Stepped over a statement a rule sets after: its sets, as a run through it makes them.
			if (from !== undefined && setHooks.has(from)) {
				applySets(base, from);
			}

			break;
		}
		case "stepIn": base.step(); break;
		case "stepOut": stepOut(base); break;
		default: break;
	}
}

async function advanceFrom(base: Vm, action: ForwardAction, trace?: TraceContext): Promise<void> {
	current = base;
	const span = trace !== undefined ? workerLog.continueSpan(trace, "step", { "action": action }) : workerLog.span("step", { "action": action });

	try {
		try {
			act(base, action);

			// Async work pending and none ready (tsval's steppedAsync): let it settle, then go on — a continue to its next
			// stop, a step to the next statement that runs (in whichever job runs next).
			while (!base.finished && base.idle) {
				await base.whenSettled();

				if (done) {
					return;
				}

				if (action === "continue") {
					runOn(base);
				} else {
					base.runUntil((vm) => vm.atStatementBoundary() || vm.atBreakpoint());
				}
			}
		} catch (error) {
			post({ "type": "output", "text": "Uncaught " + String(error), "stream": "stderr" });
			finish(1, crashOf(base, error));
			done = true;

			return;
		}

		if (base.finished) {
			if (base.completion !== undefined) {
				post({ "type": "output", "text": "→ " + format(base.completion) });
			}

			finish();
			done = true;

			return;
		}

		// Branch: drop any redo tail, then record this stop. The stored fork is only ever forked from, never
		// stepped, so it stays a pristine snapshot we can return to.
		history = history.slice(0, index + 1);
		history.push(base);
		index = history.length - 1;
		// A "continue" that landed on a capability line is a capability stop (the policy gated it); steps stay "step".
		const location = base.location();
		const stopLine = location !== null ? location.line + 1 : undefined;
		// A step-out cut short by a breakpoint reports it as one, like a continue would.
		const reason = action === "continue" || (action === "stepOut" && base.atBreakpoint()) ? (stopLine !== undefined && capabilityLines.has(stopLine) ? "capability" : "breakpoint") : "step";

		emitStopped(base, reason, false, reason === "capability" && stopLine !== undefined ? askAt(base, stopLine) : undefined);
	} finally {
		span.end();
	}
}

async function handle(action: Action): Promise<void> {
	switch (action) {
		case "stepBack":
			if (index > 0) {
				index -= 1;
			}

			current = history[index];
			emitStopped(history[index], "step", true);
			break;

		case "reverseContinue":
			// M2: nearest earlier stop. (A true reverse-to-breakpoint scan is a later refinement.)
			if (index > 0) {
				index -= 1;
			}

			current = history[index];

			emitStopped(history[index], "breakpoint", true);
			break;

		case "disconnect":
			finish();
			done = true;
			break;

		default: {
			// Forward: fork the current stop and advance a copy (honors the action even after a step-back), its
			// observations going on from a copy of that stop's.
			const next = history[index].fork();

			if (next.loop !== undefined) {
				next.loop.pace = pace;
			}

			record(next, copySums(sumsOf.get(history[index])));
			await advanceFrom(next, action, actionTrace);
			break;
		}
	}
}

async function session(initial: Vm, launchTrace?: TraceContext): Promise<void> {
	await advanceFrom(initial, "continue", launchTrace); // run to the first breakpoint (or completion)

	while (!done) {
		const action = await nextAction();

		await handle(action);
	}
}

/**
 * React launch (M3c): run the app under tsval with native React and a reconciler-backed ReactDOM shim as
 * guest globals. The app's own `ReactDOM.createRoot(...).render(<App/>)` drives our reconciler, which streams
 * mutations to the adapter. Component/handler code is guest, so a breakpoint in it pauses via onBreakpointHook
 * (the reconciler invokes them synchronously). After mount the worker is idle, servicing `dispatch` (DOM
 * events routed back from the iframe) — each re-renders and streams more mutations.
 */
function launchReact(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): void {
	guestRoot = createGuestRoot(React, (mutation) => { toPreview({ "type": "mutation", "mutation": mutation }); });

	const reactDom = {
		"createRoot": () => ({ "render": (element: unknown) => { guestRoot?.render(element); }, "unmount": () => { guestRoot?.unmount(); } }),
		"render": (element: unknown) => { guestRoot?.render(element); }
	};
	// Minimal document shim so `ReactDOM.createRoot(document.getElementById("root"))` (the idiomatic entry)
	// doesn't throw; the container arg is ignored (our root is the reconciler container).
	const documentShim = { "getElementById": () => ({}), "createElement": () => ({}), "body": {} };

	const loaded = createVM(message.source, {
		"fileName": message.fileName,
		"onBreakpoint": onBreakpointHook,
		"coverage": true,
		"observe": observeSite,
		"globals": { "React": React, "ReactDOM": reactDom, "document": documentShim, "console": guestConsole() }
	});

	sourceFile = loaded.sourceFile;
	current = loaded.vm;
	record(loaded.vm, new Map());
	loaded.vm.addBreakpointsByLine(...message.lines);

	// The initial mount is the launch's work — span it as a continuation of the adapter's launch trace, so the
	// React app coming up is part of the same trace as `debug.launch` (see debug-adapter startAction).
	const span = trace !== undefined
		? workerLog.continueSpan(trace, "render", { "react": true })
		: workerLog.span("render", { "react": true });

	try {
		loaded.vm.run(); // executes the module → guest render() → mount → mutations posted
	} catch (error) {
		post({ "type": "output", "text": "Uncaught " + String(error), "stream": "stderr" });
	} finally {
		span.end();
	}

	post({ "type": "rendered" });
	toPreview({ "type": "rendered" });
}

hub.subscribe(controlSubject(SESSION), (data, envelope): void => {
	const message = data as Control;
	const trace = envelope.traceContext;

	switch (message.type) {
		case "explore":
			void exploreOrderings(message).then((explored) => { post({ "type": "explored", "explored": explored }); });
			break;

		case "launch": {
			// Absent without cross-origin isolation: then a breakpoint inside a React handler can't pause (see onBreakpointHook).
			control = message.control === undefined ? undefined : new Int32Array(message.control);
			// Announce membership to the pod hub. Safe here (not at module load): the pod's interest sub-control
			// precedes `launch` on this ordered channel, so by now the pod is known to want `pod.ready`.
			hub.publish("pod.ready", { "worker": hub.id, "react": message.react === true });
			workerLog.info("launch", { "file": message.fileName, "react": message.react === true, "breakpoints": message.lines.length });

			if (message.react === true) {
				launchReact(message, trace);
				break;
			}

			// tsval's event loop (steppedAsync with timers, a virtual clock and a seeded random): async code and timers run
			// on the stack the debugger steps — its breakpoints, capability stops, rules — and the same way every time, so a
			// step forward from any stop it travelled back to goes the way it went. Its start is logged, to run it again; a
			// launch can give one (an ordering explore found: its clock, seed and schedule).
			const eventLoop = { "now": Date.now(), "seed": Math.floor(Math.random() * 2 ** 32), ...message.eventLoop, "pace": "real" as const };
			const loaded = createVM(message.source, { "fileName": message.fileName, "onBreakpoint": onBreakpointHook, "coverage": true, "observe": observeSite, "trace": traceValue, "eventLoop": eventLoop, ...capabilitySurface(message.fileName, message.args ?? []) });

			loopStart = eventLoop.now;
			pace = "real";
			workerLog.info("event loop", { "now": eventLoop.now, "seed": eventLoop.seed, ...eventLoop.schedule === undefined ? {} : { "schedule": eventLoop.schedule } });

			liveTimer = setInterval(flushLive, 250);

			sourceFile = loaded.sourceFile;
			record(loaded.vm, new Map());
			// Capability breakpoints: pre-arm a breakpoint at every capability call the policy won't let pass, so a
			// gated call hard-stops at its line with the debugger's normal step / step-back, and asks there (step 8 of
			// LIVE-VALUES.md). No policy → every undecided dangerous call breaks (firewall default).
			policy = message.policy;
			userLines = message.lines;
			programPath = message.program ?? message.fileName;
			setHooks = new Map();

			for (const hook of message.hooks ?? []) {
				setHooks.set(hook.line, [...setHooks.get(hook.line) ?? [], hook]);
			}
			// What it reads from outside, first: process.argv (the margin mocks it there).
			reportArgv(loaded.sourceFile, message.args ?? []);
			capabilityLines = new Set(policy !== undefined ? capabilityBreakLines(loaded.sourceFile, policy) : []);
			arm(loaded.vm);

			history = [];
			index = -1;
			done = false;
			void session(loaded.vm, trace);
			break;
		}

		case "dispatch": {
			// A DOM event routed back from the render pane → re-render. Span it (continuing the dispatch action's
			// trace when present) so an interaction and the re-render it causes read as one operation.
			const span = trace !== undefined
				? workerLog.continueSpan(trace, "render", { "event": message.event })
				: workerLog.span("render", { "event": message.event });

			try {
				guestRoot?.dispatch(message.id, message.event);
			} finally {
				span.end();
			}

			const history = guestRoot?.historyLength() ?? 0;

			post({ "type": "history", "length": history });
			toPreview({ "type": "history", "length": history });
			break;
		}

		case "timeTravel":
			guestRoot?.timeTravel(message.index);
			break;

		case "coverage":
			post({ "type": "coverage", "report": coverageReport() });
			break;

		case "setBreakpoints":
			// Re-point breakpoints on every stored fork so time-traveled forward runs honor the new set — the capability
			// lines with them (replacing the user's alone would disarm those).
			userLines = message.lines;

			for (const vm of history) {
				arm(vm);
			}

			break;

		case "pace":
			// From the next wait on — the machine running now, and every stop it may go on from.
			pace = message.pace;

			for (const vm of [...history, current]) {
				if (vm?.loop !== undefined) {
					vm.loop.pace = pace;
				}
			}

			break;

		case "setValue":
			// The stop's own machine (the pristine snapshot a continue forks from), so the run goes on with the value.
			post(done || history[index] === undefined ? { "type": "valueSet", "ok": false, "error": "not stopped" } : setValue(history[index], message.name, message.value));
			break;

		case "decide":
			// After "Allow always": the policy now in effect, and the capability lines it still gates.
			if (message.policy !== undefined && sourceFile !== undefined) {
				policy = message.policy;
				capabilityLines = new Set(capabilityBreakLines(sourceFile, policy));

				for (const vm of history) {
					arm(vm);
				}
			}

			denyNext = message.deny === true;
			giveNext = message.give === undefined ? undefined : { "value": message.give };
			break;

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut":
		case "stepBack":
		case "reverseContinue":
		case "disconnect":
			if (awaitAction !== undefined) {
				actionTrace = trace; // continue the adapter action's trace in the step it drives
				const resolve = awaitAction;

				awaitAction = undefined;
				resolve(message.type);
			}

			break;

		default:
			break;
	}
});
