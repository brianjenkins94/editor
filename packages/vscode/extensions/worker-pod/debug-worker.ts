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
import type { LoadedVM, ModuleLoader } from "@brianjenkins94/tsval";
import type { TraceEvent } from "@brianjenkins94/tsval";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition, givenResult, isDangerous, ruleMatches } from "@brianjenkins94/util/silo/policy";
import type { CapabilityAsk, Control, CoverageReport, Crash, Explored, PreviewMessage, SetHook, Snapshot, Variable, WorkerEvent } from "./debug-protocol";
import type { SiteSums } from "./site-sums";
import type { GuestRoot } from "./debug-react";
import type { VirtualRequest } from "./workspace-runtime";

import { createHub, portTransport, serve } from "@brianjenkins94/hub";
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
const { "log": workerLog, architecture } = observe(hub, { "network": NETWORK_PROBES });

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
 *  a second, and before each stop and the end — by the program file they're in (MODULES.md), each its own record. */
const live = new Map<ts.SourceFile, LiveRecord>();
/** The program's files whose text the adapter has been told (with their first values): the entry's it has. */
const toldSource = new Set<string>();

/** `file`'s live values. */
function liveIn(file: ts.SourceFile): LiveRecord {
	let record = live.get(file);

	if (record === undefined) {
		record = new LiveRecord();
		live.set(file, record);
	}

	return record;
}
let liveTimer: ReturnType<typeof setInterval> | undefined;
/** Where the run is: a program file and a 1-based line in it — the entry's, or another of the program's (MODULES.md). */
interface Place { "file": string; "line": number }

/** 1-based lines pre-armed as capability breakpoints (policy said stop), by program file — so a stop there reports
 *  reason "capability" rather than "breakpoint". The entry's computed at launch from the policy the adapter sent;
 *  another file's as it loads (noteProgramFile). */
let capabilityLines = new Map<string, Set<number>>();
/** The program's files known so far — the entry, and each other one as it loads — parsed for their capability calls. */
let programFiles = new Map<string, ts.SourceFile>();
/** The policy the run is under (the adapter's, updated after an "Allow always"); none, no capability stops. */
let policy: Policy | undefined;
/** The user's breakpoints (1-based lines), armed beside the capability lines. */
let userLines: number[] = [];
/** The user's breakpoints in the program's other files (MODULES.md), by file. */
let fileLines = new Map<string, number[]>();
/** The statements rules set something after (RULES.md: *set variables.<name>*, *at* a place), by program file and
 *  1-based line: armed as breakpoints that aren't stops — the statement runs, the sets are made, the run goes on. */
let setHooks = new Map<string, Map<number, SetHook[]>>();
/** The program, workspace-relative: the subject's `program` at a hook. */
let programPath = "";
/** "Deny" at a capability stop: the next capability call fails, as a denied one would. Reset at every stop. */
let denyNext = false;
/** The result the user gave the call at a capability stop, once (`decide` with `give`): the next stand-in call returns it. */
let giveNext: { "value": unknown } | undefined;
/** "Allow once" (or this run, or always) at a capability stop: the next capability call the policy doesn't allow happens
 *  for real all the same — the one asked about. Reset at every stop. */
let allowNext = false;
/** Writes a program's allowed call is making right now: the runtime lets these through, a package's it refuses. */
let allowingWrites = 0;
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
/** Each stop's probed resource, by machine and place (`file:line`): a stop asks more than once. */
const probed = new WeakMap<Vm, Map<string, string | undefined>>();

/**
 * The resource a capability call on `line` reaches, when its argument is computed on the line itself
 * (`path.join(dir, name)`, a template): the machine forked at the stop and stepped until the call — its arguments
 * evaluated as the run will evaluate them, every capability call on the way its inert stand-in, the event loop
 * deterministic — then thrown away. Undefined if the fork doesn't get there (it threw first, or took too long).
 */
function probeResource(vm: Vm, place: Place, capability: string): string | undefined {
	const known = probed.get(vm);
	const key = `${place.file}:${place.line}`;

	if (known?.has(key) === true) {
		return known.get(key);
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

	probed.set(vm, (known ?? new Map()).set(key, resource));

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
function capabilitySurface(fileName: string, args: string[], real?: Runtime, where: { "cwd"?: string; "env"?: Record<string, string> } = {}): { "globals": Record<string, unknown>; "modules": Record<string, unknown> } {
	const standins = gated(capabilityStandins(), real, where.cwd ?? "/workspace");
	// What a script reads of its process: its arguments (a run's inputs), the directory it was started in and its
	// environment (a terminal's — RUNNING.md, step 3), and its stdin — nothing it can do.
	const process = { "argv": ["node", fileName, ...args], "env": { ...where.env }, "platform": "browser", "cwd": () => where.cwd ?? "/workspace", "stdin": stdin };

	return { "globals": { ...standins.globals, "console": guestConsole(), "process": process }, "modules": standins.modules };
}

/** The program's module system (MODULES.md): almostnode on the shared workspace — resolution, the module graph, the
 *  cache — with tsval evaluating the program's own files (programModules). A package's built-ins are almostnode's, its
 *  writes refused (a library's effects aren't stepped or asked about); the program's are its stand-ins (programBuiltins:
 *  what a capability stop is about). Loaded at a run's start. */
let runtime: Runtime | undefined;
/** The globals the program has on Node beyond ECMAScript's (workspace-runtime.ts' programGlobals), once the runtime's up. */
let nodeGlobals: Record<string, unknown> = {};
/** The built-ins the program's code gets (the run's capability stand-ins, by name) — set as a run starts. */
let programBuiltins: Record<string, unknown> = {};
/** The machine evaluating the program: a program file a package requires is evaluated on it (a nested run). */
let evaluating: Vm | undefined;

type Runtime = InstanceType<typeof import("@brianjenkins94/almostnode").Runtime>;

/** The runtime, loaded once per worker: the shared workspace (the launch's — the pod holds it) attached, its servers
 *  answering the preview. */
async function runtimeReady(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	if (runtime !== undefined) {
		return runtime;
	}

	const [{ getServerBridge }, { answerServer, programGlobals, serverOn, workerTapResponse, workspaceRuntime }, zenfs] = await Promise.all([import("@brianjenkins94/almostnode"), import("./workspace-runtime"), import("./zenfs-vfs.js")]);

	if (workspace !== undefined) {
		zenfs.attachSharedWorkspace(workspace);
	}

	const write = (method: string, path: string): never => {
		throw Object.assign(new Error(`EACCES: a library can't write in a debug run (${method} ${path})`), { "code": "EACCES" });
	};

	runtime = workspaceRuntime(await zenfs.createZenfsVFS(), {
		// (A program's own allowed write is let through while it's made: madeFor.)
		"beforeFs": (op, method, path) => { if (op === "write" && allowingWrites === 0) { write(method, path); } },
		// The program's code gets its stand-ins (`fs`, `child_process`); a package, almostnode's own.
		"builtinFor": (id, requester) => (requester === "program" && Object.hasOwn(programBuiltins, id) ? programBuiltins[id] : undefined),
		// A program file a package requires: tsval's to evaluate, on the run's machine (a nested run).
		"evaluateProgram": (module, _require, source) => {
			if (evaluating === undefined) {
				throw new Error(`no run to evaluate ${module.filename} on`);
			}

			noteProgramFile(module.filename, () => source);
			evaluating.evaluateModule(module);
		}
	});
	// A server the program starts: answering the preview for its port, the request its handler's call (not stepped on the
	// main stack — a breakpoint in it pauses there, as in a React handler).
	getServerBridge({ "onServerReady": (port: number) => {
		if (listening.has(port)) {
			return;
		}

		listening.add(port);
		serve(hub, `virtual.debug.${port}`, async (raw) => {
			const request = raw as VirtualRequest;
			const server = serverOn(port);

			if (server === undefined) {
				return workerTapResponse(request.url) ?? { "status": 502, "statusText": "Bad Gateway", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`nothing listens on ${port} any more`) };
			}

			// As a run's server answers (workspace-runtime.ts): the preview's taps in what it serves.
			return workerTapResponse(request.url) ?? answerServer(server, request, (direction, label, bytes) => {
				if (direction === "request") {
					architecture.record(architecture.self, `server:${port}`, "request", label, bytes);
				} else {
					architecture.record(`server:${port}`, architecture.self, direction, label, bytes);
				}
			});
		});
		post({ "type": "listening", "port": port });
	} });

	nodeGlobals = programGlobals(runtime);

	return runtime;
}

/** The runtime as tsval's module loader (VMOptions.modules): it resolves; tsval evaluates the program's files; what isn't
 *  the program's, almostnode loads — asked for by the program, so its built-ins are the stand-ins. */
function programModules(loaded: Runtime): ModuleLoader {
	const vfs = loaded.getVFS();

	return {
		"resolve": (specifier, fromDir) => loaded.resolve(specifier, fromDir),
		"require": (specifier, fromDir) => loaded.require(specifier, fromDir, "program"),
		"source": (filename) => vfs.readFileSync(filename, "utf8") as string,
		"cached": (filename) => loaded.cached(filename),
		"register": (filename, module) => {
			// Another of the program's files, about to run: its capability stops armed first.
			noteProgramFile(filename, () => vfs.readFileSync(filename, "utf8") as string);
			loaded.register(filename, module as Parameters<Runtime["register"]>[1]);
		},
		"forget": (filename) => { loaded.forget(filename); }
	};
}

/** The ports a debug run's servers listen on (node:http, from almostnode): each answers the preview (`virtual.debug.<port>`,
 *  asked by the dev-server worker) and keeps the run alive — out of work, it idles, serving. */
const listening = new Set<number>();
/** The program's process.stdin: what's typed in the Debug Console arrives on it (`stdin` control) — a `data` event, a
 *  string — and a program listening on it is kept alive, waiting for input, as by a server. */
const stdin = ((): { "on": (event: string, listener: (...args: unknown[]) => void) => unknown; "emit": (event: string, ...args: unknown[]) => boolean; "listenerCount": (event: string) => number } => {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const self = {
		"isTTY": false,
		"on": (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]); return self; },
		"addListener": (event: string, listener: (...args: unknown[]) => void) => self.on(event, listener),
		"once": (event: string, listener: (...args: unknown[]) => void) => {
			const once = (...args: unknown[]): void => { self.off(event, once); listener(...args); };

			return self.on(event, once);
		},
		"off": (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, (listeners.get(event) ?? []).filter((each) => each !== listener)); return self; },
		"removeListener": (event: string, listener: (...args: unknown[]) => void) => self.off(event, listener),
		"removeAllListeners": (event?: string) => { if (event === undefined) { listeners.clear(); } else { listeners.delete(event); } return self; },
		"emit": (event: string, ...args: unknown[]) => { const each = listeners.get(event) ?? []; each.forEach((listener) => { listener(...args); }); return each.length > 0; },
		"listenerCount": (event: string) => listeners.get(event)?.length ?? 0,
		"setEncoding": () => self,
		"resume": () => self,
		"pause": () => self,
		"setRawMode": () => self
	};

	return self;
})();

/** Whether the program waits on its stdin. */
const readsStdin = (): boolean => stdin.listenerCount("data") + stdin.listenerCount("readable") > 0;

/** What holds a debug run open — almostnode's keep-alive hook (`__nodeKeepAlive`): a server is held from the moment
 *  it's told to listen (its port is known a microtask later), let go when it closes or is unref'd. */
const held = new Set<unknown>();

(globalThis as unknown as { "__nodeKeepAlive"?: { "retain": (handle: unknown) => void; "release": (handle: unknown) => void } }).__nodeKeepAlive = {
	"retain": (handle) => { held.add(handle); },
	"release": (handle) => { held.delete(handle); }
};

/** The program's capabilities (RUNNING.md, step 2): its `fs`, `child_process` and `fetch`, each gated call decided as it's
 *  made — a probe's fork gets the stand-in; a call the user denied at its stop (`denyNext`) fails with node's EACCES; a
 *  call a rule gives the result of (RULES.md, slice 2), or the user gave it at the stop (`giveNext`), gets that; a call the
 *  policy allows, or the user allowed at its stop (`allowNext`), happens for real through almostnode (`real`) — what it
 *  read recorded — and any other fails as a denied one would. With no `real` (exploring orderings: a run many times
 *  over), every call is its inert stand-in, as before. A module's other members are almostnode's own. (A module object
 *  shared under several names stays one object.) */
function gated(standins: ReturnType<typeof capabilityStandins>, real?: Runtime, cwd = "/workspace"): ReturnType<typeof capabilityStandins> {
	const wrapped = new Map<unknown, unknown>();
	const gate = (fn: (...args: unknown[]) => unknown, effect?: (...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]): unknown {
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

		const tagged = standinCapability(fn);

		if (tagged === undefined) {
			return fn.apply(this, args);
		}

		const argument = args[tagged.resourceArg];
		const resource = typeof argument === "string" ? argument : argument instanceof URL ? argument.href : typeof argument === "object" && argument !== null && "url" in argument ? String((argument as { "url": unknown }).url) : "";
		const given = giveNext ?? (policy === undefined ? undefined : givenResult(policy, { "capability": tagged.capability, "resource": resource }));

		giveNext = undefined;

		if (given !== undefined) {
			return givenAs(tagged.capability, fn.apply(this, args), given.value);
		}

		if (effect === undefined) {
			return fn.apply(this, args);
		}

		const allowed = policy !== undefined && effectiveDisposition(policy, tagged.capability, resource, isDangerous(tagged.capability)) === "allow";

		if (!allowed && !allowNext) {
			throw Object.assign(new Error(`EACCES: permission denied — ${tagged.capability} ${resource} isn't allowed (the policy decides it, and it wasn't asked)`), { "code": "EACCES" });
		}

		if (!allowed) {
			allowNext = false;
		}

		// A relative path is the program's directory's (its process.cwd(): a terminal's), as node resolves it.
		const made = tagged.capability.startsWith("fs:") && typeof argument === "string" && !argument.startsWith("/") ? args.map((each, index) => (index === tagged.resourceArg ? `${cwd}/${argument}` : each)) : args;

		return madeFor(tagged.capability, resource, () => effect(...made));
	};
	// almostnode's own module (or the network) a stand-in module stands for: its members, the gated ones made real.
	const realOf = (key: string): Record<string, unknown> | undefined => {
		if (real === undefined) {
			return undefined;
		}

		const id = key.replace(/^node:/u, "");

		return (id === "fs/promises" ? (real.require("fs", "/workspace", "package") as { "promises": Record<string, unknown> }).promises : real.require(id, "/workspace", "package")) as Record<string, unknown>;
	};
	const wrap = (value: unknown, key: string): unknown => {
		if (wrapped.has(value)) {
			return wrapped.get(value);
		}

		let made: unknown;

		if (typeof value === "function") {
			made = gate(value as (...args: unknown[]) => unknown, real === undefined ? undefined : key === "fetch" ? (...args: unknown[]) => (fetch as (...fetchArgs: unknown[]) => unknown)(...args) : undefined);
		} else if (typeof value === "object" && value !== null) {
			const module = realOf(key);
			const effectOf = (name: string): ((...args: unknown[]) => unknown) | undefined => {
				const member = module?.[name];

				return typeof member === "function" ? (...args: unknown[]) => (member as (...memberArgs: unknown[]) => unknown).apply(module, args) : undefined;
			};

			made = { ...module, ...Object.fromEntries(Object.entries(value).map(([name, member]) => [name, typeof member === "function" ? gate(member as (...args: unknown[]) => unknown, effectOf(name)) : member])) };
		} else {
			made = value;
		}

		wrapped.set(value, made);

		return made;
	};

	return { "globals": Object.fromEntries(Object.entries(standins.globals).map(([key, value]) => [key, wrap(value, key)])), "modules": Object.fromEntries(Object.entries(standins.modules).map(([key, value]) => [key, wrap(value, key)])) };
}

/** The most of a read's result recorded (RULES.md, slice 2: what a call returned, to give back in a debugger). */
const RECORD_MAX = 256 * 1024;

/** Make `call` — a program's capability call, allowed — for real: a write let through the runtime's refusal while it's
 *  made, what a read returned recorded (text, not too much of it). */
function madeFor(capability: string, resource: string, call: () => unknown): unknown {
	const record = (value: unknown): void => {
		const text = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;

		if (text !== undefined && text !== "" && text.length <= RECORD_MAX) {
			post({ "type": "recorded", "capability": capability, "resource": resource, "value": text });
		}
	};

	allowingWrites += 1;

	let result: unknown;

	try {
		result = call();
	} finally {
		allowingWrites -= 1;
	}

	if (capability === "net" && result instanceof Promise) {
		void result.then((response: unknown) => (response instanceof Response && response.ok ? response.clone().text().then(record) : undefined), () => undefined);
	} else if (capability === "fs:read") {
		if (result instanceof Promise) {
			void result.then(record, () => undefined);
		} else {
			record(result);
		}
	}

	return result;
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

			if (at !== null && vm.currentNode !== null) {
				liveIn(vm.currentNode.getSourceFile()).add({ "line": at.line, "name": name, "value": "", "raw": binding.value, "kind": "set", "call": lastTraced?.call ?? 0, "turns": lastTraced?.turns ?? [], "step": lastTraced?.step ?? 0, ...vm.currentNode === null ? {} : { "at": rangeOf(vm.currentNode) } });
				flushLive();
			}

			return { "type": "valueSet", "ok": true, "value": format(binding.value), "snapshot": snapshot(vm) };
		}
	}

	return { "type": "valueSet", "ok": false, "error": `no ${name} in scope here` };
}

/** The rules' hooks at `place` (none: an empty list). */
const hooksAt = (place: Place): SetHook[] => setHooks.get(place.file)?.get(place.line) ?? [];
/** Whether `place` is a capability call the policy gated when it was armed. */
const capabilityAt = (place: Place): boolean => capabilityLines.get(place.file)?.has(place.line) === true;
/** Whether the user has a breakpoint at `place`. */
const userStopAt = (place: Place): boolean => (place.file === sourceFile?.fileName ? userLines : fileLines.get(place.file) ?? []).includes(place.line);

/** Every line to arm in `file`: the user's breakpoints, the capability calls the policy gates, the statements rules set
 *  after. */
function linesIn(file: string): number[] {
	return [...file === sourceFile?.fileName ? userLines : fileLines.get(file) ?? [], ...capabilityLines.get(file) ?? [], ...setHooks.get(file)?.keys() ?? []];
}

/** Arm `vm`'s breakpoints: in each of the program's files, the user's, the capability calls the policy gates, and the
 *  statements rules set after. */
function arm(vm: Vm): void {
	vm.breakpoints.clear();

	for (const file of new Set([sourceFile?.fileName ?? "", ...fileLines.keys(), ...capabilityLines.keys(), ...setHooks.keys()])) {
		try {
			vm.addBreakpointsInFile(file, ...linesIn(file));
		} catch {
			// (a file that isn't there, or doesn't parse: nothing of it runs)
		}
	}
}

/** Another of the program's files is loading (the loader's register, or a package requiring it): its capability calls
 *  the policy gates are armed, on the machine running and each stop's, before any of it runs. */
function noteProgramFile(filename: string, source: () => string): void {
	if (programFiles.has(filename)) {
		return;
	}

	let file: ts.SourceFile;

	try {
		file = ts.createSourceFile(filename, source(), ts.ScriptTarget.Latest, true, /\.[jt]sx$/u.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	} catch {
		return;
	}

	programFiles.set(filename, file);
	capabilityLines.set(filename, new Set(policy === undefined ? [] : capabilityBreakLines(file, policy)));

	for (const vm of new Set([current, ...history])) {
		vm?.addBreakpointsInFile(filename, ...linesIn(filename));
	}
}

/** Whether a run reaching `place` stops there: a breakpoint of the user's, or a capability call the policy gates. */
function stopsAt(vm: Vm, place: Place): boolean {
	return userStopAt(place) || (capabilityAt(place) && askAt(vm, place) !== undefined);
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
function applySets(vm: Vm, at: Place): void {
	const variables = scopeValues(vm);

	for (const { place, rule } of hooksAt(at)) {
		// *program is* the file the rule is placed in — as the margin makes it (another of the program's files, a rule
		// made in its margin, holds wherever it's run from).
		const file = (place as { "file"?: unknown } | null)?.file;

		if (!ruleMatches(rule, { "program": typeof file === "string" ? file : programPath, "at": place, "variables": variables })) {
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
	let place = placeOf(base);
	let passed = false;

	while (!base.finished && place !== undefined && hooksAt(place).length > 0) {
		if (passed && stopsAt(base, place)) {
			return true;
		}

		base.stepStatement();
		applySets(base, place);
		passed = true;
		place = placeOf(base);
	}

	return passed && (base.finished || (place !== undefined && stopsAt(base, place)));
}

/** Continue: run to the next stop — through the statements rules set after (each run, then its sets made) and the
 *  capability lines the policy now lets pass. From a stop on a statement a rule sets after, that statement first. */
function runOn(base: Vm): void {
	if (history.length > 0 && passHooks(base)) {
		return;
	}

	for (;;) {
		base.runToBreakpoint();

		const place = placeOf(base);

		if (base.finished || place === undefined) {
			return;
		}

		if (hooksAt(place).length > 0 && !stopsAt(base, place)) {
			if (passHooks(base)) {
				return;
			}

			continue;
		}

		// A capability line whose calls the policy now lets pass (allowed always since it was armed, or its resource
		// allowed once known) isn't a stop: go on, unless the user has a breakpoint there too.
		if (capabilityAt(place) && !userStopAt(place) && askAt(base, place) === undefined) {
			continue;
		}

		return;
	}
}

/** What the capability stop at `place` asks: the first call on its line the policy gates, with the resource it would
 *  reach as far as it's known before the line runs — undefined when the policy now lets every call on it pass. */
function askAt(vm: Vm, place: Place): CapabilityAsk | undefined {
	// The file as the run has it (the stop's own node's), else as it was read to arm it.
	const here = vm.currentNode?.getSourceFile();
	const file = here?.fileName === place.file ? here : place.file === sourceFile?.fileName ? sourceFile : programFiles.get(place.file);
	const { line } = place;

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
			const probe = before.resolved ? undefined : probeResource(vm, place, hit.capability);
			const { resource, resolved } = probe === undefined ? before : { "resource": probe, "resolved": true };

			if (shouldBreak(policy, { ...hit, "resource": resolved ? resource : "" })) {
				return { "line": line - 1, "at": rangeOf(call), "capability": hit.capability, "callee": hit.callee, "resource": resource, "resolved": resolved, "dangerous": hit.dangerous, ...file === sourceFile ? {} : { "file": file.fileName, "source": file.text } };
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
	const loaded = await runtimeReady(message.workspace);

	const found = await explore(async (schedule) => {
		const output: string[] = [];
		const surface = capabilitySurface(message.fileName, message.args ?? []);

		// Each run from scratch: its own modules (the program's evaluated again), its own stand-ins.
		loaded.clearCache();
		programBuiltins = surface.modules;
		const write = (...args: unknown[]): void => { output.push(args.map(formatLogArg).join(" ")); };
		const console = Object.fromEntries(["log", "info", "debug", "dir", "warn", "error", "trace"].map((name) => [name, write]));
		const { vm } = createVM(message.source, { "fileName": message.fileName, "globals": { ...nodeGlobals, ...surface.globals, "console": console }, "modules": programModules(loaded), "eventLoop": { ...message.eventLoop, "schedule": schedule, "pace": "fast" } });

		evaluating = vm;
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
		"frames": [{ "id": 1, "name": functionName(vm.currentNode), "line": (loc?.line ?? 0) + 1, "column": (loc?.character ?? 0) + 1, ...vm.currentNode === null ? {} : { "at": rangeOf(vm.currentNode) }, ...loc === null || loc.file === sourceFile?.fileName ? {} : { "file": loc.file, "code": vm.currentNode?.getSourceFile().text.split("\n")[loc.line]?.trim() } }],
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
 * Label for the stack frame: the INNERMOST function containing the current node, in its own file. The continuation
 * frames aren't 1:1 with function calls, so we resolve this off the AST instead.
 */
function functionName(node: ts.Node | null): string {
	for (let at = node ?? undefined; at !== undefined; at = at.parent) {
		if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || ts.isArrowFunction(at) || ts.isMethodDeclaration(at)) {
			return at.name !== undefined && ts.isIdentifier(at.name) ? at.name.text : "<anonymous>";
		}
	}

	return "<module>";
}

/** What tsval's trace told, into the session's live values: its line, and its call's function by name and line. */
function traceValue(event: TraceEvent): void {
	if (sourceFile === undefined || probing !== undefined) {
		return; // (a probe's fork didn't run)
	}

	// Each in its own file: the entry's, or another of the program's (MODULES.md).
	const file = event.node.getSourceFile();
	const lineOf = (node: ts.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart(node.getSourceFile())).line;
	const callee = event.callee === undefined ? undefined : { "name": calleeName(event.callee), "line": lineOf(event.callee), "at": rangeOf(event.callee) };

	lastTraced = { "call": event.call, "turns": event.loops.map((loop) => loop.turn), "step": event.step };
	liveIn(file).add({ "line": lineOf(event.node), "name": event.name, "value": "", "raw": event.value, "kind": event.kind, "call": event.call, "turns": lastTraced.turns, "step": event.step, "at": rangeOf(event.node), ...callee === undefined ? {} : { "callee": callee } });
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
		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(read.getStart(file)).line, "name": "process.argv", "value": args.map((arg) => (arg === "" || /[\s"'|]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" "), "kind": "input", "call": 0, "turns": [], "step": 0, "at": [read.getStart(file), read.getEnd()] });
	}
}

/** A node's range in the text that ran (offsets, from its first token): what the margin anchors a line's data by — for
 *  a node with a body, its head (`headOf`). */
function rangeOf(node: ts.Node): [number, number] {
	const head = headOf(node);

	return [head.getStart(head.getSourceFile()), head.getEnd()];
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
	for (const [file, record] of live) {
		const batch = record.drain();

		if (batch === undefined) {
			continue;
		}

		// Another of the program's files: which, and its text the first time (what its values' ranges are in).
		const other = file === sourceFile ? {} : { "file": file.fileName, ...toldSource.has(file.fileName) ? {} : { "source": file.text } };

		toldSource.add(file.fileName);
		post({ "type": "values", "batch": batch, ...other });
	}
}

function emitStopped(vm: Vm, reason: string, traveled = false, ask?: CapabilityAsk): void {
	denyNext = false;
	allowNext = false;
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
 *  how often `current` has run each — 0 for the ones it hasn't: the entry's, and each other program file's that ran
 *  (`files`, with its source). */
function coverageReport(): CoverageReport {
	if (sourceFile === undefined) {
		return { "file": "", "statements": [], "sites": [] };
	}

	const others = new Set<ts.SourceFile>();

	for (const node of current?.coverage?.keys() ?? []) {
		others.add(node.getSourceFile());
	}

	others.delete(sourceFile);

	const files = [...others].map((file) => ({ ...fileCoverage(file), "source": file.text }));

	return { ...fileCoverage(sourceFile), ...files.length === 0 ? {} : { "files": files } };
}

/** One program file's coverage, its observed sites and its top-level statements' profile. */
function fileCoverage(file: ts.SourceFile): CoverageReport {
	const counts = current?.coverage;
	const statements: CoverageReport["statements"] = [];

	const visit = (node: ts.Node): void => {
		if (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement) {
			const start = file.getLineAndCharacterOfPosition(node.getStart(file));
			const end = file.getLineAndCharacterOfPosition(node.getEnd());

			statements.push({ "start": [start.line, start.character], "end": [end.line, end.character], "count": counts?.get(node) ?? 0, "anchor": rangeOf(node) });
		}

		node.forEachChild(visit);
	};

	file.forEachChild(visit);

	// Where the run's work went, by top-level statement — declarations too (tsval's profile).
	const profile = file.statements.flatMap((statement) => {
		const entry = current?.profile?.get(statement);
		const start = file.getLineAndCharacterOfPosition(statement.getStart(file));

		return entry === undefined ? [] : [{ "start": [start.line, start.character] as [number, number], "anchor": rangeOf(statement), ...entry }];
	});

	return { "file": file.fileName, "statements": statements, "sites": siteObservations(current === undefined ? undefined : sumsOf.get(current), file), ...profile.length === 0 ? {} : { "profile": profile } };
}

/** The program is over: report its coverage, then end the session — with 1 for a program that threw, as node would, and
 *  where it threw. */
function finish(exitCode = 0, crash?: Crash): void {
	clearInterval(liveTimer);
	flushLive();
	post({ "type": "coverage", "report": coverageReport(), "final": true });
	post({ "type": "terminated", "exitCode": exitCode, ...crash === undefined ? {} : { "crash": crash } });
}

/** Where `vm` is stopped: its file, and the 1-based line in it. */
function placeOf(vm: Vm): Place | undefined {
	const location = vm.location();

	return location === null ? undefined : { "file": location.file, "line": location.line + 1 };
}

/** Where `error` was thrown, for the margin's mark: by now the frames have unwound, so tsval's note of it, not the
 *  current node. Best-effort — the run ends whatever this finds. */
function crashOf(vm: Vm, error: unknown): Crash | undefined {
	try {
		const site = vm.throwSite(error);
		const at = vm.location(site);

		return at === null || site === null ? undefined : { "line": at.line, "at": rangeOf(site), "message": String(error), ...at.file === sourceFile?.fileName ? {} : { "file": at.file } };
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
	vm.runUntil((running) => {
		const place = running.atBreakpoint() ? placeOf(running) : undefined;

		return (running.atBreakpoint() && (place === undefined || hooksAt(place).length === 0 || stopsAt(running, place))) || (running.atStatementBoundary() && callDepth(running) < depth);
	});
}

/** Advance `base` (a VM we own) by a forward action, then record the new stop or terminate. When the action
 *  carried a `trace` (the adapter's action span), the step span CONTINUES that trace, so a debug step is one
 *  cross-context trace (adapter action → worker step) rather than an unrelated root. */
/** Do `action` on `base`, as far as it goes without waiting. */
function act(base: Vm, action: ForwardAction): void {
	switch (action) {
		case "continue": runOn(base); break;
		case "next": {
			const from = placeOf(base);

			base.stepStatement();

			// Stepped over a statement a rule sets after: its sets, as a run through it makes them.
			if (from !== undefined && hooksAt(from).length > 0) {
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
	evaluating = base; // (a program file a package requires is evaluated on the machine running)
	const span = trace !== undefined ? workerLog.continueSpan(trace, "step", { "action": action }) : workerLog.span("step", { "action": action });

	try {
		try {
			act(base, action);

			// Async work pending and none ready (tsval's steppedAsync): let it settle, then go on — a continue to its next
			// stop, a step to the next statement that runs (in whichever job runs next).
			while (!base.finished && base.idle) {
				// Out of work but serving: the session is idle — a request (or a timer it sets) goes on from here.
				if (held.size > 0 || readsStdin()) {
					post({ "type": "serving", "ports": [...listening] });
				}

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
		const stop = placeOf(base);
		// A step-out cut short by a breakpoint reports it as one, like a continue would.
		const reason = action === "continue" || (action === "stepOut" && base.atBreakpoint()) ? (stop !== undefined && capabilityAt(stop) ? "capability" : "breakpoint") : "step";

		emitStopped(base, reason, false, reason === "capability" && stop !== undefined ? askAt(base, stop) : undefined);
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

/** A program launched for debugging: its module system ready first (almostnode: MODULES.md), then its machine — the entry
 *  a module of the program's, its files tsval's — armed and run to its first stop. */
async function launchProgram(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Promise<void> {
	// tsval's event loop (steppedAsync with timers, a virtual clock and a seeded random): async code and timers run
	// on the stack the debugger steps — its breakpoints, capability stops, rules — and the same way every time, so a
	// step forward from any stop it travelled back to goes the way it went. Its start is logged, to run it again; a
	// launch can give one (an ordering explore found: its clock, seed and schedule).
	// A server it starts keeps it alive: out of work, it idles, serving.
	const eventLoop = { "now": Date.now(), "seed": Math.floor(Math.random() * 2 ** 32), ...message.eventLoop, "pace": "real" as const, "keepAlive": () => held.size > 0 || readsStdin() };
	let modules: ModuleLoader;
	let loadedRuntime: Runtime;

	try {
		loadedRuntime = await runtimeReady(message.workspace);
		modules = programModules(loadedRuntime);
	} catch (error) {
		post({ "type": "output", "text": `The program's modules can't be loaded: ${String(error)}`, "stream": "stderr" });
		finish(1);

		return;
	}

	// Its capabilities real (RUNNING.md, step 2): each gated call decided as it's made — but for a run of an ordering
	// exploring found (its schedule given), which replays that run: its calls' results the stand-ins' it had.
	const surface = capabilitySurface(message.fileName, message.args ?? [], message.eventLoop?.schedule === undefined ? loadedRuntime : undefined, { ...message.cwd === undefined ? {} : { "cwd": message.cwd }, ...message.env === undefined ? {} : { "env": message.env } });

	programBuiltins = surface.modules;
	runtime?.clearCache();

	const loaded = createVM(message.source, { "fileName": message.fileName, "onBreakpoint": onBreakpointHook, "coverage": true, "profile": true, "observe": observeSite, "trace": traceValue, "eventLoop": eventLoop, "globals": { ...nodeGlobals, ...surface.globals }, "modules": modules });

	evaluating = loaded.vm;

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
	fileLines = new Map(Object.entries(message.files ?? {}));
	programPath = message.program ?? message.fileName;
	setHooks = new Map();

	// Each rule's hook, in the file it's placed in: the entry's, or another of the program's (the adapter places both).
	for (const hook of message.hooks ?? []) {
		const file = hook.file ?? message.fileName;
		const inFile = setHooks.get(file) ?? new Map<number, SetHook[]>();

		inFile.set(hook.line, [...inFile.get(hook.line) ?? [], hook]);
		setHooks.set(file, inFile);
	}
	// What it reads from outside, first: process.argv (the margin mocks it there).
	reportArgv(loaded.sourceFile, message.args ?? []);
	programFiles = new Map([[loaded.sourceFile.fileName, loaded.sourceFile]]);
	capabilityLines = new Map([[loaded.sourceFile.fileName, new Set(policy !== undefined ? capabilityBreakLines(loaded.sourceFile, policy) : [])]]);
	arm(loaded.vm);

	history = [];
	index = -1;
	done = false;
	await session(loaded.vm, trace);
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

			void launchProgram(message, trace);
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
			if (message.file === undefined || message.file === sourceFile?.fileName) {
				userLines = message.lines;
			} else {
				fileLines.set(message.file, message.lines);
			}

			for (const vm of history) {
				arm(vm);
			}

			break;

		case "stdin":
			// Typed in the Debug Console or the terminal it was started in: the program's input — its listeners called with
			// it (or, at its end, told so), and the run woken to go on.
			if (message.end === true) {
				stdin.emit("end");
			} else {
				stdin.emit("data", message.data);
			}

			current?.loop?.wake?.();
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
			if (message.policy !== undefined) {
				const now = message.policy;

				policy = now;
				capabilityLines = new Map([...programFiles].map(([name, file]) => [name, new Set(capabilityBreakLines(file, now))]));

				for (const vm of history) {
					arm(vm);
				}
			}

			denyNext = message.deny === true;
			giveNext = message.give === undefined ? undefined : { "value": message.give };
			// Allowed — once, this run, always, by a rule: the call asked about happens for real.
			allowNext = !denyNext && giveNext === undefined;
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
