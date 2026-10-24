/**
 * tsval debug worker — runs the target program under tsval's stepping VM and adds TIME TRAVEL. It speaks
 * debug-protocol.ts over the pod hub: control arrives on its session's control subject, stops and output go out on its
 * event subject.
 *
 * Pausing is ASYNC: the whole program is driven by THIS worker's own loop (`runToBreakpoint`/`stepStatement`/`step`),
 * so to "pause" the loop simply awaits the next control message. The exception is a breakpoint inside a guest call the
 * host makes synchronously (a server's handler, a library's callback): that blocks the worker on Atomics.wait until the adapter
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
import type { FsShim } from "@brianjenkins94/almostnode";
import type { Effect, LoadedPackage, TestReport } from "@brianjenkins94/editor-api";
import type { AskedWhy, RuntimeConnection, RuntimeDecision, RuntimeVerdict } from "@brianjenkins94/editor-api/runtime";
import type { Told, Traced } from "@brianjenkins94/editor-api/values";
import type { LoadedVM, ModuleLoader, TraceEvent } from "@brianjenkins94/tsval";
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages } from "@brianjenkins94/util/silo/evidence";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import type { CapabilityAsk, Control, CoverageReport, Crash, Explored, SetHook, Snapshot, ToWorker, Variable, WorkerEvent } from "./debug-protocol";
import type { SiteSums } from "./site-sums";

import { FS_ASYNC, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { policySkips, recordingKey, requestOf, triggerOf, verdictOf } from "@brianjenkins94/editor-api/gate";
import { revive } from "@brianjenkins94/editor-api/recorded";
import { connectRuntime, layered } from "@brianjenkins94/editor-api/runtime";

import { LiveRecord } from "@brianjenkins94/editor-api/values";
import { createVM, explore, runToEnd, TsvalInternalError, UNCATCHABLE } from "@brianjenkins94/tsval";
import { covers, settledReach } from "@brianjenkins94/util/silo/evidence";
import { givenResult, packageDisposition, ruleMatches } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";
import { capabilityStandins, givenAs, standinCapability } from "./canary";
import { capabilityBreakLines, classifyCall, shouldBreak } from "./capability-calls";
import { replayGuard, replayProgram } from "./replay-run";
import { addObservation, copySums, siteObservations } from "./site-sums";
import nodeTestSource from "./node-test.js?raw";

// This worker's link into the editor's runtime (editor-api's workspace runtime), the port the adapter hands over first
// thing: a server the program starts answers the preview through it, and its log and spans — a step's, its uncaught
// errors, its own requests — are the editor's, as this worker's (the top page's timeline, debug-mcp). The debug protocol
// itself is the adapter's and this worker's own: their messages (debug-protocol.ts' ToWorker / WorkerEvent).
let editorLink: RuntimeConnection | undefined;

/** This worker's log, once it's linked (always, by the time a control message comes: the link comes first). */
function workerLog(): RuntimeConnection["log"] {
	return editorLink.log;
}

type Vm = LoadedVM["vm"];

/** A span's cross-context trace context: the hub envelope of a control message that triggers work carries the
 *  adapter action's, so this worker's span continues the adapter's trace (see continueSpan). */
interface TraceContext { "traceId": string; "parentSpanId": string }

type Action = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect";
type ForwardAction = "continue" | "next" | "stepIn" | "stepOut";

/** An event for the adapter, on this session's event subject. */
function post(message: WorkerEvent): void {
	globalThis.postMessage(message);
}

let sourceFile: ts.SourceFile | undefined;
/** The session's live values (RUNTIME-EVIDENCE.md, *Live values*): what each line bound, returned or chose, told to the adapter a few times
 *  a second, and before each stop and the end — by the program file they're in (packages/tsval/README.md, *Modules*), each its own record. */
const live = new Map<ts.SourceFile, LiveRecord>();
/** The program's files whose text the adapter has been told (with their first values): the entry's it has. */
const toldSource = new Set<string>();

/** Each stop's place in each record's telling (LiveRecord.told), for a run that goes on from that stop again. */
const toldAt = new WeakMap<Vm, Map<LiveRecord, Told>>();

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

/** Where the run is: a program file and a 1-based line in it — the entry's, or another of the program's (packages/tsval/README.md, *Modules*). */
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
/** The user's breakpoints in the program's other files (packages/tsval/README.md, *Modules*), by file. */
let fileLines = new Map<string, number[]>();
/** The statements rules set something after (RUNNING.md, *A rule placed in the code*: *set variables.<name>*, *at* a
 *  place), by program file and 1-based line: armed as breakpoints that aren't stops — the statement runs, the sets are
 *  made, the run goes on. */
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
/** The call at the capability stop the user skipped (RUNTIME-EVIDENCE.md, *Capability decisions, on the line*): it isn't made, the run goes on with its inert
 *  stand-in's result. */
let skipNext = false;
/** How the call at the capability stop was decided — the person's answer there (an exception to the policy, on record in
 *  the run's effects): taken by the next capability call, the one asked about. */
let answeredNext: "once" | "always" | "refused" | undefined;
/** A live run (RUNTIME-EVIDENCE.md, *Live runs*): the file run again on a save or its interval — it stops at nothing,
 *  asks nothing (what it can't make it skips), runs its timers at once, ends at its first idle or its step budget. */
let liveRun = false;
/** What calls returned when they last ran for real, by `<capability> <resource>` (the run contract's `__recorded`): a live
 *  run, which nobody is watching, gives a call its recording where it would otherwise skip it. */
let recordedResults: Record<string, unknown> = {};
/** A live run nobody's looking at (selected after an edit: RUNNING.md, *Unattended runs*): past runs are the default — a
 *  call gets what it returned the last time it ran for real — and a call that never did halts the run there. */
let unattended = false;
/** A live run's own writable layer over the workspace's files (editor-api's `layered`): its writes go there and are
 *  thrown away with it, its reads see them. None for a run someone started. */
let runLayer: ReturnType<typeof layered> | undefined;
/** What a halted run's error carries: the call it halted before. */
const HALTED = Symbol("halted");
/** The packages whose code the run ran (almostnode tells each as its first module runs), by folder: told with its
 *  coverage, for its envelope (whether anyone ran a version later found compromised). */
const packagesRan = new Map<string, LoadedPackage>();
/** The run's effects (the run contract's `Effect`): each gated call it made, was denied, skipped or was given, by its
 *  capability and resource — told the adapter as the run ends, for the run ledger (its envelope's `effects`). */
const effects = new Map<string, Effect>();
let tallying = false;

/** A gated call, counted among the run's effects — a package's (`pkg`, its name@version) apart from the program's — with
 *  how it was decided: within the package's baseline, by the policy, or at the call (the person's answer). */
function tally(capability: string, resource: string, how: Effect["how"], pkg?: string, decided?: Effect["decided"]): void {
	if (!tallying) {
		return;
	}

	const key = `${how}\0${capability}\0${resource}\0${pkg ?? ""}\0${decided ?? ""}`;
	const known = effects.get(key);

	if (known === undefined) {
		effects.set(key, { "capability": capability, "resource": resource, "how": how, "calls": 1, ...pkg === undefined ? {} : { "package": pkg }, ...decided === undefined ? {} : { "decided": decided } });
	} else {
		known.calls += 1;
	}
}

/** The run's effects so far, told the adapter (each telling has them all; its last is the run's). */
function tellEffects(): void {
	if (effects.size > 0) {
		post({ "type": "effects", "effects": [...effects.values()].map((effect) => ({ ...effect })) });
	}
}

/** A live run's step budget: past it, the run stops there rather than running on (tsval's maxSteps). */
const LIVE_STEPS = 5_000_000;
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
 * Shared control word for the SYNCHRONOUS in-handler pause. A breakpoint reached inside a host-invoked guest call
 * (a server's request handler, a library's callback, a program file a package requires) can't pause by awaiting — the call is on a synchronous stack the worker
 * loop doesn't drive — so the onBreakpoint hook blocks the whole worker on `Atomics.wait` while the main
 * thread stays live, and the adapter resumes it via `Atomics.notify`. control[0]: 0 = waiting, 1 = go.
 */
let control: Int32Array | undefined;
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

/** A probe running (probeResource): the capability whose call it's after, and the resource that call reached. */
let probing: { "capability": string; "resource"?: string } | undefined;

/** tsval's `observe`: what went through a site, added to the running timeline's sums (not a probe's: it didn't run). */
function observeSite(node: ts.Node, site: Parameters<typeof addObservation>[2], value: unknown): void {
	if (probing === undefined) {
		addObservation(recording, node, site, value);
	}
}

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
		({ resource } = probing);
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
	return new Promise((resolve) => {
		awaitAction = resolve;
	});
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
		"on": (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, [...listeners.get(event) ?? [], listener]);

			return self;
		},
		"addListener": (event: string, listener: (...args: unknown[]) => void) => self.on(event, listener),
		"once": (event: string, listener: (...args: unknown[]) => void) => {
			const once = (...args: unknown[]): void => {
				self.off(event, once);
				listener(...args);
			};

			return self.on(event, once);
		},
		"off": (event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, (listeners.get(event) ?? []).filter((each) => each !== listener));

			return self;
		},
		"removeListener": (event: string, listener: (...args: unknown[]) => void) => self.off(event, listener),
		"removeAllListeners": (event?: string) => {
			if (event === undefined) {
				listeners.clear();
			} else {
				listeners.delete(event);
			}

			return self;
		},
		"emit": (event: string, ...args: unknown[]) => {
			const each = listeners.get(event) ?? [];

			each.forEach((listener) => {
				listener(...args);
			});

			return each.length > 0;
		},
		"listenerCount": (event: string) => listeners.get(event)?.length ?? 0,
		"setEncoding": () => self,
		"resume": () => self,
		"pause": () => self,
		"setRawMode": () => self
	};

	return self;
})();

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
	// environment (a terminal's — RUNNING.md, *Output goes where it was started*), and its stdin — nothing it can do.
	// (Its version is the one almostnode's process reports, packages/almostnode/shims/process.ts, so a run reads the same
	// version whichever runtime it's in.)
	const process = { "argv": ["node", fileName, ...args], "env": { ...where.env }, "platform": "browser", "version": "v20.0.0", "versions": { "node": "20.0.0" }, "cwd": () => where.cwd ?? "/workspace", "stdin": stdin };

	return { "globals": { ...standins.globals, "console": guestConsole(), "process": process }, "modules": standins.modules };
}

/** The program's module system (packages/tsval/README.md, *Modules*): almostnode on the shared workspace — resolution, the module graph, the
 *  cache — with tsval evaluating the program's own files (programModules). A package's built-ins are almostnode's, its
 *  writes refused (a library's effects aren't stepped or asked about); the program's are its stand-ins (programBuiltins:
 *  what a capability stop is about). Loaded at a run's start. */
let runtime: Runtime | undefined;
/** The program's own `fs` for a run in `cwd`: almostnode's over the editor's runtime files (runtime-vfs.ts) — each of
 *  its calls on a workspace file the editor's to decide, make and keep among the run's effects, as any debugger's
 *  program's are. Undefined outside the editor (no runtime link): the program's `fs` is then the runtime's own. */
let programFsFor: ((cwd: string) => FsShim) | undefined;
/** The globals the program has on Node beyond ECMAScript's (workspace-runtime.ts' programGlobals), once the runtime's up. */
let nodeGlobals: Record<string, unknown> = {};
/** The built-ins the program's code gets (the run's capability stand-ins, by name) — set as a run starts. */
let programBuiltins: Record<string, unknown> = {};
/** The machine evaluating the program: a program file a package requires is evaluated on it (a nested run). */
let evaluating: Vm | undefined;

type Runtime = InstanceType<typeof import("@brianjenkins94/almostnode").Runtime>;

/** What a package's call through its `fs` or `child_process` is: each method by its capability. */
const PACKAGE_CALLS: Record<string, Record<string, string>> = {
	"fs": Object.fromEntries([...Object.entries(FS_SYNC), ...Object.entries(FS_ASYNC)].map(([method, op]) => [method, "fs:" + op])),
	"fs/promises": Object.fromEntries(Object.entries(FS_ASYNC).map(([method, op]) => [method, "fs:" + op])),
	"child_process": Object.fromEntries(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"].map((method) => [method, "exec"])),
	// (almostnode's http and https reach the network through the global fetch — counted here as the package's, by URL)
	"http": { "request": "net", "get": "net" },
	"https": { "request": "net", "get": "net" }
};
/** A call that didn't happen because it may not: refused (a write: beforeFs), or not possible here (a command). */
const refused = (error: unknown): boolean => ["EACCES", "EPERM", "ENOSYS"].includes((error as { "code"?: unknown } | undefined)?.code as string);
/** Each package's own `fs`, `fs/promises` and `child_process`, by module and package folder. */
const packageBuiltins = new Map<string, unknown>();
/** almostnode's `packageDirOf`, once the runtime's loaded. */
let packageDirOf: ((filename: string) => string | undefined) | undefined;

/** The package installed in `dir`, as an effect names it: name@version (packagesRan), or its folder's name. */
function packageOf(dir: string): string {
	const ran = packageIn(dir);

	return ran.version === undefined ? ran.name : `${ran.name}@${ran.version}`;
}

/** The dependency baseline (`.silo/baseline.json`, read as a run starts): what the part of each package the code uses
 *  could reach when it began to (the join, its `consumer`), and what each package's own code could do when the library
 *  was added (its `packages`) — what grew since isn't settled: it asks, unless the policy allows it. Undefined when
 *  there's none (the editor makes it as a project opens, unless `silo.baseline` is off): the policy decides every
 *  package's call. */
let baseline: { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages } | undefined;

/** The baseline as it is now, through the editor's runtime (read as the debugger's own: neither decided nor counted). */
function readBaseline(): typeof baseline {
	try {
		const text = new TextDecoder().decode(editorLink?.fs.readFile("/workspace/.silo/baseline.json", { "load": true }));

		return JSON.parse(text) as typeof baseline;
	} catch {
		return undefined;
	}
}

/** The version the editor pins of each package (`.silo/versions.json`, read as a run starts): what's installed. */
let pins: Record<string, string> = {};

/** Where a package nothing in the workspace's node_modules has is installed: this worker's own memory (its root, which
 *  almostnode looks in last) — the workspace's filesystem is a fixed-size shared buffer, too small for node_modules. */
const MEMORY_MODULES = "/node_modules";

/** What's installed there, by name: its version. */
const installed = new Map<string, string>();

/** The pinned versions as they are now, through the editor's runtime (the debugger's own read). */
function readPins(): Record<string, string> {
	try {
		const text = new TextDecoder().decode(editorLink?.fs.readFile("/workspace/.silo/versions.json", { "load": true }));
		const { packages } = JSON.parse(text) as { "packages"?: Record<string, { "version": string }> };

		return Object.fromEntries(Object.entries(packages ?? {}).map(([name, { version }]) => [name, version]));
	} catch {
		return {};
	}
}

/**
 * A package nothing in node_modules has (almostnode's `install`): its tarball, at the version the editor pins, unpacked
 * into this worker's memory — the run waits on the fetch. A package the policy bans is never fetched: its load fails as
 * a banned package's does (onPackage). False when nothing pins it (it's no dependency).
 */
function installPackage(name: string): boolean {
	const version = pins[name];

	if (version === undefined || editorLink === undefined || runtime === undefined) {
		return false;
	}

	const dir = `${MEMORY_MODULES}/${name}`;

	if (policy !== undefined && packageDisposition(policy, { "name": name, "version": version }) === "deny") {
		tally("load", `${name}@${version}`, "denied", `${name}@${version}`, "policy");

		throw Object.assign(new Error(`EACCES: ${name}@${version} may not run — the policy bans it`), { "code": "EACCES" });
	}

	const vfs = runtime.getVFS();

	for (const [path, bytes] of unpack(editorLink.tarball(name, version))) {
		const file = `${dir}/${path}`;

		vfs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { "recursive": true });
		vfs.writeFileSync(file, bytes);
	}

	installed.set(name, version);

	return true;
}

/** What's installed whose pin has changed since, removed — installed again, at its new version, as it's required. */
function dropUnpinned(): void {
	const vfs = runtime?.getVFS();
	const remove = (path: string): void => {
		if (vfs?.statSync(path).isDirectory() === true) {
			for (const entry of vfs.readdirSync(path)) {
				remove(`${path}/${entry}`);
			}

			vfs.rmdirSync(path);
		} else {
			vfs?.unlinkSync(path);
		}
	};

	for (const [name, version] of installed) {
		if (pins[name] !== version) {
			remove(`${MEMORY_MODULES}/${name}`);
			installed.delete(name);
		}
	}
}

/** The package installed in `dir`, by name and version (packagesRan). */
function packageIn(dir: string): { "name": string; "version"?: string } {
	return packagesRan.get(dir) ?? { "name": dir.slice(dir.lastIndexOf("/node_modules/") + "/node_modules/".length) };
}

/**
 * How the package in `dir` calling `capability` goes: trusted by the policy (an org's contract, say) — made, no question;
 * within what its baseline settled of the version that runs — the join of the code's use of it (what the members it
 * imports reach), else the whole package's — made (the baseline spot-checked at the call: an entry of another version
 * says nothing of this one); else the policy decides, at the call — redline, the policy, then the
 * person, asked, blocking until it's answered (the editor's decide). Where nobody can be asked — a live run (retyping
 * mustn't prompt), no editor, a failure to decide — the policy decides alone, a call it would ask about refused. Every
 * call is counted with how it was decided.
 */
function packageVerdict(dir: string, capability: string, call: Omit<RuntimeDecision, "package">): RuntimeVerdict {
	const pkg = packageIn(dir);

	if (policy !== undefined && packageDisposition(policy, pkg) === "allow") {
		return { "allow": true, "decided": "policy" };
	}

	// (spot-checked: the baseline's version of the package is the one that runs; then what it settled — the join of the
	// code's use of it, else, for a package only a dependency uses, the whole package's)
	const recorded = baseline?.packages?.[pkg.name]?.version;
	const reach = baseline === undefined || (recorded !== undefined && pkg.version !== undefined && recorded !== pkg.version) ? undefined : settledReach(baseline, pkg.name);

	if (reach !== undefined && covers(reach, capability)) {
		return { "allow": true, "decided": "baseline" };
	}

	const alone = (): RuntimeVerdict => ({ "allow": verdictOf(policy, capability, call.args[0] ?? "", liveRun) === "allow", "decided": "policy" });

	if (liveRun || editorLink === undefined) {
		return alone();
	}

	try {
		return editorLink.decide({ ...call, "package": packageOf(dir), "why": askedWhy(pkg, capability) });
	} catch {
		return alone();
	}
}

/** Why `pkg`'s call of `capability` is asked about, from what the baseline says of it — said at the prompt, so whoever
 *  answers knows whether the package changed, the code's use of it did, or the analysis missed the call. */
function askedWhy(pkg: { "name": string; "version"?: string }, capability: string): AskedWhy {
	if (baseline === undefined) {
		return { "reason": "no-baseline" };
	}

	const recorded = baseline.packages?.[pkg.name]?.version;

	if (recorded !== undefined && pkg.version !== undefined && recorded !== pkg.version) {
		return { "reason": "other-version", "recorded": recorded };
	}

	const whole = baseline.packages?.[pkg.name];

	// (never read: not a dependency, or one that couldn't be — the code's use of it has no join, only its members)
	if (whole === undefined) {
		return { "reason": "unread" };
	}

	// (what the gate decided against: the code's use of it, else, for a package only a dependency uses, the whole package)
	const uses = Object.values(baseline.consumer ?? {}).flatMap((workspace) => Object.entries(workspace).filter(([spec, entry]) => entry.kind === "package" && (spec === pkg.name || spec.startsWith(pkg.name + "/"))).map(([, entry]) => entry));
	const entries: { "grew"?: Record<string, string> }[] = uses.length > 0 ? uses : [whole];

	for (const entry of entries) {
		for (const [grown, origin] of Object.entries(entry.grew ?? {})) {
			if (covers([grown], capability)) {
				// (a version's origin is the version; the code's, the members it started using, or `*`)
				return { "reason": "grew", "by": /^\d/u.test(origin) ? "version" : "code", "origin": origin };
			}
		}
	}

	return { "reason": "unpredicted" };
}

/** Each package's own `fetch`, by package folder. */
const packageFetches = new Map<string, typeof fetch>();

/**
 * The package whose module is in folder `from` gets the real `fetch`, each call decided (packageVerdict) and counted among
 * the run's effects as that package's (`net`, by URL), as its fs and child_process calls are (packageBuiltin). A package
 * that reaches for `globalThis.fetch` itself isn't told apart. Undefined for anything that isn't a package's.
 */
function packageFetch(from: string): typeof fetch | undefined {
	const dir = packageDirOf?.(from);

	if (dir === undefined) {
		return undefined;
	}

	if (!packageFetches.has(dir)) {
		packageFetches.set(dir, async (input, init) => {
			const resource = reachedBy(input);
			const verdict = packageVerdict(dir, "net", { "kind": "net", "args": [resource] });

			if (!verdict.allow) {
				tally("net", resource, "denied", packageOf(dir), verdict.decided);

				throw Object.assign(new TypeError(`EACCES: ${packageOf(dir)} may not reach ${resource} (${verdict.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
			}

			tally("net", resource, "made", packageOf(dir), verdict.decided);

			return globalThis.fetch(input, init);
		});
	}

	return packageFetches.get(dir);
}

/**
 * The package asking from folder `from` gets almostnode's own `id` — what it does is what it did — with each gated call
 * counted among the run's effects as that package's, by name@version (packagesRan): a read made, a write refused
 * (beforeFs), a command not possible here. Undefined for anything else (the program's code, a module with no gated calls).
 */
function packageBuiltin(id: string, from: string): unknown {
	const calls = PACKAGE_CALLS[id];
	const dir = calls === undefined ? undefined : packageDirOf?.(from);

	if (calls === undefined || dir === undefined || runtime === undefined) {
		return undefined;
	}

	const key = id + "\0" + dir;

	if (!packageBuiltins.has(key)) {
		const pkg = packageOf(dir);
		const real = runtime.require(id, "/workspace", "package") as Record<string, unknown>;
		const counted = (methods: Record<string, string>, target: Record<string, unknown>): Record<string, unknown> => new Proxy(target, {
			"get": (object, property, receiver) => {
				const value = Reflect.get(object, property, receiver) as unknown;

				// fs.promises: the same, its methods the async ones
				if (property === "promises" && id === "fs" && typeof value === "object" && value !== null) {
					return counted(PACKAGE_CALLS["fs/promises"], value as Record<string, unknown>);
				}

				const capability = typeof property === "string" && typeof value === "function" ? methods[property] : undefined;

				if (capability === undefined) {
					return value;
				}

				return function(this: unknown, ...args: unknown[]): unknown {
					const resource = reachedBy(args[0]);
					let kind: RuntimeDecision["kind"] = "net";

					if (capability.startsWith("fs:")) {
						kind = "fs";
					} else if (capability === "exec") {
						kind = "exec";
					}

					const verdict = packageVerdict(dir, capability, { "kind": kind, "method": property as string, ...kind === "fs" ? { "op": capability === "fs:write" ? "write" : "read" } : {}, "args": [resource] });

					if (!verdict.allow) {
						tally(capability, resource, "denied", pkg, verdict.decided);

						throw Object.assign(new Error(`EACCES: ${pkg} may not ${capability} ${resource} (${verdict.decided === "policy" ? "the policy" : "refused at the call"})`), { "code": "EACCES" });
					}

					// (a write decided here is let through the runtime's guard, as a program's allowed one is: madeFor)
					const writing = verdict.allow && capability === "fs:write";

					if (writing) {
						allowingWrites += 1;
					}

					try {
						const result = (value as (...rest: unknown[]) => unknown).apply(this, args);

						if (typeof (result as { "then"?: unknown } | null)?.then === "function") {
							return (result as Promise<unknown>).then((settled) => {
								tally(capability, resource, "made", pkg, verdict.decided);

								return settled;
							}, (error: unknown) => {
								tally(capability, resource, refused(error) ? "denied" : "made", pkg, verdict.decided);

								throw error;
							});
						}

						tally(capability, resource, "made", pkg, verdict.decided);

						return result;
					} catch (error) {
						tally(capability, resource, refused(error) ? "denied" : "made", pkg, verdict.decided);

						throw error;
					} finally {
						if (writing) {
							allowingWrites -= 1;
						}
					}
				};
			}
		});

		packageBuiltins.set(key, counted(calls, real));
	}

	return packageBuiltins.get(key);
}

/** The runtime, loaded once per worker: the shared workspace (the launch's — the pod holds it) attached, its servers
 *  answering the preview. */
function runtimeReady(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	return runtime === undefined ? loadRuntime(workspace) : Promise.resolve(runtime);
}

/** Load the runtime (runtimeReady): the first time a run asks for it. */
async function loadRuntime(workspace: SharedArrayBuffer | undefined): Promise<Runtime> {
	const [{ createFsShim, getServerBridge, "packageDirOf": dirOf }, { answerServer, programGlobals, serverOn, workspaceRuntime }, zenfs, { RuntimeVfs }] = await Promise.all([import("@brianjenkins94/almostnode"), import("../../shared/workspace-runtime"), import("../../shared/zenfs-vfs.js"), import("@brianjenkins94/editor-api/runtime-vfs")]);

	// (its files answered once the editor has the worker's mailbox — without it, the runtime's own)
	if (editorLink !== undefined) {
		const link = editorLink;

		await link.ready.then(() => {
			programFsFor = (cwd) => createFsShim(new RuntimeVfs(runLayer ?? link.fs), () => cwd);
		}, () => undefined);
	}

	if (workspace !== undefined) {
		zenfs.attachSharedWorkspace(workspace);
	}

	packageDirOf = dirOf;

	const write = (method: string, path: string): never => {
		throw Object.assign(new Error(`EACCES: a library can't write in a debug run (${method} ${path})`), { "code": "EACCES" });
	};

	runtime = workspaceRuntime(await zenfs.createZenfsVFS(), {
		// (A program's own allowed write is let through while it's made: madeFor.)
		"beforeFs": (op, method, path) => {
			if (op === "write" && allowingWrites === 0) {
				write(method, path);
			}
		},
		// A package the policy bans (an org's contract: one known to be bad) doesn't run at all: its first module fails to
		// load, and the run's effects say so.
		"onPackage": (ran) => {
			packagesRan.set(ran.dir, ran);

			if (policy !== undefined && packageDisposition(policy, ran) === "deny") {
				tally("load", packageOf(ran.dir), "denied", packageOf(ran.dir), "policy");

				throw Object.assign(new Error(`EACCES: ${packageOf(ran.dir)} may not run — the policy bans it`), { "code": "EACCES" });
			}
		},
		// A package nothing in node_modules has (the editor serves packages from a CDN; type acquisition writes only their
		// types): installed in this worker's memory, at the version the editor pins.
		"install": (name) => installPackage(name),
		// The program's code gets its stand-ins (`fs`, `child_process`); a package, almostnode's own — its calls counted as its.
		"builtinFor": (id, requester, from) => {
			if (requester === "package") {
				return packageBuiltin(id, from);
			}

			return Object.hasOwn(programBuiltins, id) ? programBuiltins[id] : undefined;
		},
		// …and its own `fetch`, its calls counted as its (the program's `fetch` is its stand-in, as its built-ins are).
		"globalFor": (_name, requester, from) => (requester === "package" ? packageFetch(from) : undefined),
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
	// main stack — a breakpoint in it pauses there, as in any host-invoked handler: onBreakpointHook).
	getServerBridge({ "onServerReady": (port: number) => {
		// (a live run's server isn't served, or announced: no preview opens as you type)
		if (listening.has(port) || liveRun) {
			return;
		}

		listening.add(port);
		// (the runtime link records each request and its answer as this server's traffic)
		editorLink?.serve(port, async (request) => {
			const server = serverOn(port);

			if (server === undefined) {
				return { "status": 502, "statusText": "Bad Gateway", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`nothing listens on ${port} any more`) };
			}

			// As the program's server answers it: the preview's taps are put in by the dev-server worker, as for any
			// debugger's server.
			return answerServer(server, request);
		});
		post({ "type": "listening", "port": port });
	} });

	nodeGlobals = programGlobals(runtime);

	return runtime;
}

/** The runtime as tsval's module loader (VMOptions.modules): it resolves; tsval evaluates the program's files; what isn't
 *  the program's, almostnode loads — asked for by the program, so its built-ins are the stand-ins. */
/** Where `node:test` is served from (node-test.js): a program file in no folder of the workspace's, so tsval runs it
 *  as the program's code — a test's awaits on the run's event loop — and nothing tells it as one of the program's files
 *  (its coverage, values and evidence aren't the program's). */
const NODE_TEST = "/__editor__/node-test.js";

/** The tests a test file's run ran, as each ended (node-test.js tells each start and end). */
let testsRan: TestReport[] = [];
/** Each running test's coverage counts as it started, by its titles (JSON): what ran since is that test's. */
const testStarts = new Map<string, Map<ts.SourceFile, number[]>>();
/** How many tests failed, as node-test.js tells at the end: a run with one fails, as `node --test` does. */
let testsFailed = 0;

/** node-test.js's `__editorTest`: a test started (`titles`), ended (and how: `outcome`, what it threw), or the file's
 *  tests are done (`titles` then the count that failed). Called from the program's code, with strings only. */
function testTold(kind: string, titles?: string, outcome?: string, error?: string): void {
	if (kind === "start" && titles !== undefined) {
		testStarts.set(titles, new Map([...current?.coverage ?? []].map(([file, entry]) => [file, [...entry.counts]])));
	} else if (kind === "end" && titles !== undefined) {
		const started = testStarts.get(titles);

		testStarts.delete(titles);
		testsRan.push({ "titles": JSON.parse(titles) as string[], "outcome": outcome as TestReport["outcome"], ...error === undefined ? {} : { "error": error }, "files": started === undefined ? [] : ranSince(started) });
	} else if (kind === "done") {
		testsFailed = Number(titles ?? 0);
	}
}

/** The statements that ran since `started` (each file's counts then), in each of the program's files. */
function ranSince(started: Map<ts.SourceFile, number[]>): TestReport["files"] {
	return [...current?.coverage ?? []].filter(([file]) => file.fileName !== NODE_TEST).flatMap(([file, entry]) => {
		const before = started.get(file) ?? [];
		const at = (offset: number): [number, number] => {
			const { line, character } = file.getLineAndCharacterOfPosition(offset);

			return [line, character];
		};
		const statements = entry.statements.flatMap((node, index): [[number, number], [number, number]][] => (entry.counts[index] > (before[index] ?? 0) ? [[at(node.getStart(file)), at(node.getEnd())]] : []));

		return statements.length === 0 ? [] : [{ "file": file.fileName, "statements": statements }];
	});
}

function programModules(loaded: Runtime): ModuleLoader {
	const vfs = loaded.getVFS();

	return {
		// (`node:test` is node-test.js, run as the program's own code: NODE_TEST)
		"resolve": (specifier, fromDir) => (specifier === "node:test" ? { "kind": "program", "filename": NODE_TEST } : loaded.resolve(specifier, fromDir)),
		"require": (specifier, fromDir) => loaded.require(specifier, fromDir, "program"),
		"source": (filename) => (filename === NODE_TEST ? nodeTestSource : vfs.readFileSync(filename, "utf8")),
		"cached": (filename) => loaded.cached(filename),
		"register": (filename, module) => {
			// Another of the program's files, about to run: its capability stops armed first.
			if (filename !== NODE_TEST) {
				noteProgramFile(filename, () => vfs.readFileSync(filename, "utf8"));
			}

			loaded.register(filename, module as Parameters<Runtime["register"]>[1]);
		},
		"forget": (filename) => { loaded.forget(filename); }
	};
}

/** Whether the program waits on its stdin. */
const readsStdin = (): boolean => stdin.listenerCount("data") + stdin.listenerCount("readable") > 0;

/** What holds a debug run open — almostnode's keep-alive hook (`__nodeKeepAlive`): a server is held from the moment
 *  it's told to listen (its port is known a microtask later), let go when it closes or is unref'd. */
const held = new Set<unknown>();

Object.assign(globalThis, { "__nodeKeepAlive": {
	"retain": (handle: unknown) => { held.add(handle); },
	"release": (handle: unknown) => { held.delete(handle); }
} });

/** What a capability call's argument names: a path, or a URL's href — else undefined. */
function pathOrUrl(argument: unknown): string | undefined {
	if (typeof argument === "string") {
		return argument;
	}

	return argument instanceof URL ? argument.href : undefined;
}

/** The resource a capability call reaches, by its argument: a path, a URL, a request's url — else none (""). */
function reachedBy(argument: unknown): string {
	const named = pathOrUrl(argument);

	if (named !== undefined) {
		return named;
	}

	if (typeof argument === "object" && argument !== null && "url" in argument) {
		const { url } = argument as { "url": string | URL };

		return String(url);
	}

	// http.request's options: where they reach
	if (typeof argument === "object" && argument !== null && ("hostname" in argument || "host" in argument)) {
		const { protocol = "http:", hostname, host, port, path = "" } = argument as { "protocol"?: string; "hostname"?: string; "host"?: string; "port"?: number | string; "path"?: string };

		return `${protocol}//${hostname ?? host}${port === undefined ? "" : ":" + String(port)}${path}`;
	}

	return "";
}

/** A call on a probe's fork (probeResource): the one it's after records what it reaches and ends the fork; any other is
 *  its inert self. */
function probeCall(probe: NonNullable<typeof probing>, fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
	const tagged = standinCapability(fn);

	if (tagged?.capability === probe.capability) {
		probe.resource = pathOrUrl(args[tagged.resourceArg]);

		throw PROBED;
	}

	return fn.apply(self, args);
}

/** A call's arguments as it's made: a relative path the program's directory's (`cwd`), as node resolves it. */
function madeArgs(capability: string, args: unknown[], resourceArg: number, cwd: string): unknown[] {
	const argument = args[resourceArg];

	return capability.startsWith("fs:") && typeof argument === "string" && !argument.startsWith("/") ? args.map((each, index) => (index === resourceArg ? `${cwd}/${argument}` : each)) : args;
}

/** `path`, absolute and with `.` and `..` resolved — as the run's layer keys its files. */
function normalPath(path: string): string {
	const parts: string[] = [];

	for (const part of path.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	return "/" + parts.join("/");
}

/** Whether a call on `path` is on a workspace file — one the editor makes, and keeps among the run's effects itself. */
function editorKeeps(capability: string, path: unknown): boolean {
	return capability.startsWith("fs:") && typeof path === "string" && (path === "/workspace" || path.startsWith("/workspace/"));
}

/** The program's capabilities (RUNNING.md, *Effects are real, decided per call*): its `fs`, `child_process` and
 *  `fetch`, each gated call decided as it's made — a probe's fork gets the stand-in; a call the user denied at its stop
 *  (`denyNext`) fails with node's EACCES; a call a rule gives the result of (RUNNING.md, *A call's result*), or the
 *  user gave it at the stop (`giveNext`), gets that; a call the policy allows, or the user allowed at its stop
 *  (`allowNext`), happens for real through almostnode (`real`) — what it read recorded — and any other fails as a
 *  denied one would. With no `real` (exploring orderings: a run many times over), every call is its inert stand-in, as
 *  before. A module's other members are almostnode's own. (A module object shared under several names stays one
 *  object.) */
function gated(standins: ReturnType<typeof capabilityStandins>, real?: Runtime, cwd = "/workspace"): ReturnType<typeof capabilityStandins> {
	const wrapped = new Map<unknown, unknown>();
	const programFs = real === undefined ? undefined : programFsFor?.(cwd);

	// (only a run that can make calls has effects to tell: exploring orderings, every call is its stand-in)
	tallying = real !== undefined;
	const gate = (fn: (...args: unknown[]) => unknown, effect?: (...args: unknown[]) => unknown) => function(this: unknown, ...args: unknown[]): unknown {
		// A probe's fork (probeResource): the call it's after records what it reaches, and ends the fork there; any other
		// call on the way is its inert self — neither touches what the run itself was given (denyNext, giveNext).
		if (probing !== undefined) {
			return probeCall(probing, fn, this, args);
		}

		const tagged = standinCapability(fn);

		if (tagged === undefined) {
			return fn.apply(this, args);
		}

		const argument = args[tagged.resourceArg];
		const resource = reachedBy(argument);
		// How it's decided: the person's answer at its stop, when it was stopped at — else the policy.
		const decided: Effect["decided"] = answeredNext ?? "policy";

		answeredNext = undefined;

		const denied = (why: string): never => {
			tally(tagged.capability, resource, "denied", undefined, decided);

			throw Object.assign(new Error(why), { "code": "EACCES" });
		};

		if (denyNext) {
			denyNext = false;
			denied("EACCES: permission denied (denied at its capability stop)");
		}

		const given = giveNext ?? (policy === undefined ? undefined : givenResult(policy, { "trigger": triggerOf(liveRun), "capability": tagged.capability, "resource": resource }));

		giveNext = undefined;

		if (given !== undefined) {
			tally(tagged.capability, resource, "given", undefined, decided);

			return givenAs(tagged.capability, fn.apply(this, args), given.value);
		}

		if (skipNext) {
			skipNext = false;

			return skipped(tagged.capability, resource, fn.apply(this, args), decided);
		}

		if (effect === undefined) {
			return fn.apply(this, args);
		}

		// Skipped (by the policy, or a live run's: not made, the run going on — as at its stop), made, or refused — as any
		// debugger's calls through the runtime's files are (gate.ts).
		const verdict = verdictOf(policy, tagged.capability, resource, liveRun);
		// A live run's write to a workspace file goes into its own layer (thrown away when it ends) instead of not happening,
		// and a read of what it wrote reads it there — but for a call a rule itself skips.
		const target = madeArgs(tagged.capability, args, tagged.resourceArg, cwd)[tagged.resourceArg];
		const intoLayer = verdict === "skip" && runLayer !== undefined && programFs !== undefined && editorKeeps(tagged.capability, target) && !policySkips(policy, tagged.capability, resource, liveRun) && (tagged.capability !== "fs:read" || runLayer.holds(normalPath(String(target))));

		if (verdict === "skip" && !intoLayer) {
			// A live run's skip (not the policy's): what the call returned when it last ran for real, given back, if it did —
			// the same request's (a POST's recording isn't a GET's).
			const key = recordingKey(tagged.capability, resource, requestOf(tagged.capability, args));

			if (liveRun && Object.hasOwn(recordedResults, key) && !policySkips(policy, tagged.capability, resource, liveRun)) {
				return replayed(tagged.capability, resource, givenAs(tagged.capability, fn.apply(this, args), recordedResults[key]));
			}

			// Nobody's looking and it never ran for real: nothing to give it, so the run ends before it (but for a call the
			// policy itself says to skip).
			if (unattended && !policySkips(policy, tagged.capability, resource, liveRun)) {
				halted(tagged.capability, resource);
			}

			return skipped(tagged.capability, resource, fn.apply(this, args), decided);
		}

		if (verdict === "deny" && !allowNext) {
			denied(`EACCES: permission denied — ${tagged.capability} ${resource} isn't allowed (the policy decides it, and it wasn't asked)`);
		}

		if (verdict === "deny") {
			allowNext = false;
		}

		// A relative path is the program's directory's (its process.cwd(): a terminal's), as node resolves it.
		const made = madeArgs(tagged.capability, args, tagged.resourceArg, cwd);

		// (a workspace file's call the editor makes, and keeps among the run's effects itself — but one into the run's own
		// layer, which the editor never sees)
		if (intoLayer) {
			tally(tagged.capability, resource, "made", undefined, "layer");
		} else if (!(programFs !== undefined && editorKeeps(tagged.capability, made[tagged.resourceArg]))) {
			tally(tagged.capability, resource, "made", undefined, decided);
		}

		return madeFor(tagged.capability, resource, () => effect(...made), requestOf(tagged.capability, args));
	};

	// almostnode's own module (or the network) a stand-in module stands for: its members, the gated ones made real.
	const realOf = (key: string): Record<string, unknown> | undefined => {
		if (real === undefined) {
			return undefined;
		}

		const id = key.replace(/^node:/u, "");

		// The program's `fs`: its workspace files through the editor.
		if (programFs !== undefined && (id === "fs" || id === "fs/promises")) {
			return (id === "fs" ? programFs : programFs.promises) as unknown as Record<string, unknown>;
		}

		return (id === "fs/promises" ? (real.require("fs", "/workspace", "package") as { "promises": Record<string, unknown> }).promises : real.require(id, "/workspace", "package")) as Record<string, unknown>;
	};

	const wrap = (value: unknown, key: string): unknown => {
		if (wrapped.has(value)) {
			return wrapped.get(value);
		}

		let made: unknown;

		if (typeof value === "function") {
			made = gate(value as (...args: unknown[]) => unknown, real !== undefined && key === "fetch" ? (...args: unknown[]) => (fetch as (...fetchArgs: unknown[]) => unknown)(...args) : undefined);
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

/** The most of a read's result recorded (RUNNING.md, *A call's result*: what a call returned, to give back in a
 *  debugger). */
const RECORD_MAX = 256 * 1024;

/** What a read returned, as text: a string, or bytes decoded — else undefined. */
function textOf(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

/** Make `call` — a program's capability call, allowed — for real: a write let through the runtime's refusal while it's
 *  made, what a read returned recorded (text, not too much of it). */
function madeFor(capability: string, resource: string, call: () => unknown, request?: string): unknown {
	const record = (value: unknown): void => {
		const text = textOf(value);

		if (text !== undefined && text !== "" && text.length <= RECORD_MAX) {
			post({ "type": "recorded", "capability": capability, "resource": resource, "value": text, ...request === undefined ? {} : { "request": request } });
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

/** A call that wasn't made (skipped: at its stop, or by a live run) — its stand-in's `result` — told on its line, as a
 *  value of its own, so the margin says what didn't happen there. */
function skipped(capability: string, resource: string, result: unknown, decided?: Effect["decided"]): unknown {
	const node = evaluating?.currentNode;

	tally(capability, resource, "skipped", undefined, decided);

	if (evaluating !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();
		const { call, turns } = whereNow(evaluating);

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "skipped", "value": resource === "" ? capability : `${capability} ${resource}`, "kind": "skip", "call": call, "turns": turns, "step": evaluating.statements, "at": rangeOf(node) });
	}

	return result;
}

/** An unattended run ends before a call that never ran for real — told on its line (its *Rule…* and *Pin…* there),
 *  then thrown past the program's own catches, to end the run where it is. */
function halted(capability: string, resource: string): never {
	const node = evaluating?.currentNode;
	const what = resource === "" ? capability : `${capability} ${resource}`;

	if (evaluating !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();
		const { call, turns } = whereNow(evaluating);

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "halted", "value": what, "kind": "halt", "call": call, "turns": turns, "step": evaluating.statements, "at": rangeOf(node) });
	}

	throw Object.assign(new Error(`halted before ${what}`), { [UNCATCHABLE]: true, [HALTED]: what });
}

/** A call a live run gave its recording in place of (`result`: the stand-in answering with it) — told on its line, as a
 *  skip is, so the margin says the value came from the last real run. */
function replayed(capability: string, resource: string, result: unknown): unknown {
	const node = evaluating?.currentNode;

	tally(capability, resource, "given", undefined, "recorded");

	if (evaluating !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();
		const { call, turns } = whereNow(evaluating);

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "replayed", "value": resource === "" ? capability : `${capability} ${resource}`, "kind": "given", "call": call, "turns": turns, "step": evaluating.statements, "at": rangeOf(node) });
	}

	return result;
}

/** Where `vm` is, as a trace event would place it (tsval's `traced`): the call it's in (the nearest call frame's number;
 *  0, the top level) and the turn of each loop around it in that call, outermost first. */
function whereNow(vm: Vm): { "call": number; "turns": number[] } {
	const turns: number[] = [];

	for (let index = vm.frames.length - 1; index >= 0; index--) {
		const frame = vm.frames[index] as { "kind"?: string; "call"?: number; "isLoop"?: boolean; "turn"?: number };

		if (frame.kind === "call" || frame.kind === "construct") {
			return { "call": frame.call ?? 0, "turns": turns.toReversed() };
		}

		if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
			turns.push(frame.turn);
		}
	}

	return { "call": 0, "turns": turns.toReversed() };
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
	capabilityLines.set(filename, new Set(policy === undefined || liveRun ? [] : capabilityBreakLines(file, policy)));

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

		if (ruleMatches(rule, { "program": typeof file === "string" ? file : programPath, "at": place, "variables": variables })) {
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
		} else if (!capabilityAt(place) || userStopAt(place) || askAt(base, place) !== undefined) {
			// (A capability line whose calls the policy now lets pass — allowed always since it was armed, or its resource
			// allowed once known — isn't a stop: go on, unless the user has a breakpoint there too.)
			return;
		}
	}
}

/** The file `place` is in: as the run has it (the stop's own node's), else as it was read to arm it. */
function fileAt(vm: Vm, place: Place): ts.SourceFile | undefined {
	const here = vm.currentNode?.getSourceFile();

	if (here?.fileName === place.file) {
		return here;
	}

	return place.file === sourceFile?.fileName ? sourceFile : programFiles.get(place.file);
}

/** What the capability stop at `place` asks: the first call on its line the policy gates, with the resource it would
 *  reach as far as it's known before the line runs — undefined when the policy now lets every call on it pass. */
function askAt(vm: Vm, place: Place): CapabilityAsk | undefined {
	const file = fileAt(vm, place);
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
		return JSON.stringify(value) ?? asString(value);
	} catch {
		return asString(value); // circular, or a BigInt
	}
}

/** `value` as String renders it: what's left to say of a value JSON can't take (undefined, a symbol, a cycle, a BigInt). */
function asString(value: unknown): string {
	// eslint-disable-next-line ts/no-base-to-string -- any value at all reaches here: String's own rendering ("[object Object]" for a cycle) is the one node's console prints
	return String(value);
}

/** The program's console: what it logs goes to the Debug Console (warn/error as stderr), and nothing else happens. */
/**
 * Every ordering of the program's events (tsval's explore): each run fresh, with the stand-ins a debug run has — so
 * every host call answers at once, and which answer comes first, or whether one comes before a timer, is the choice —
 * no breakpoints, no stops. Each distinct ending: what it printed (a crash too — a throw, or a rejection nothing
 * handled), a schedule that gets there, and the events chosen along it.
 */
async function exploreOrderings(message: Extract<Control, { "type": "explore" }>): Promise<Explored> {
	({ policy } = message);
	const loaded = await runtimeReady(message.workspace);

	const found = await explore(async (schedule) => {
		const output: string[] = [];
		const surface = capabilitySurface(message.fileName, message.args ?? []);

		// Each run from scratch: its own modules (the program's evaluated again), its own stand-ins.
		loaded.clearCache();
		programBuiltins = surface.modules;
		const write = (...args: unknown[]): void => {
			output.push(args.map(formatLogArg).join(" "));
		};

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
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
			globalThis.removeEventListener("unhandledrejection", unhandled);
		}

		return { "outcome": { "output": output, ...crash === undefined ? {} : { "crash": crash } }, "choices": vm.choices };
	}, { "maxRuns": message.maxRuns ?? 100 });

	return {
		"runs": found.runs,
		"complete": found.complete,
		"eventLoop": message.eventLoop,
		"outcomes": found.outcomes.map(({ outcome, schedule, choices, runs }) => ({ ...outcome, "schedule": schedule, "path": choices.map((choice) => choice.candidates[choice.picked].label), "runs": runs }))
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
			if (value === null) {
				return "null";
			}

			try {
				return Array.isArray(value) ? `Array(${value.length})` : "{…}";
			} catch {
				return "{…}";
			}

		case "bigint":
		case "boolean":
		case "number":
		case "symbol":
		case "undefined": return String(value);
		// no default
	}
}

function typeName(value: unknown): string {
	if (value === null) {
		return "null";
	}

	if (Array.isArray(value)) {
		return "array";
	}

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

	for (let level: typeof scope | undefined = scope; level !== undefined; level = level.parent) {
		for (const [name, binding] of level.bindings) {
			// (an inner binding shadows an outer one of the same name)
			if (!seen.has(name)) {
				seen.add(name);
				rows.push({
					"name": name,
					"value": binding.initialized ? format(binding.value) : "<uninitialized>",
					"type": typeName(binding.value),
					"variablesReference": 0
				});
			}
		}
	}

	return {
		"frames": [{ "id": 1, "name": functionName(vm.currentNode), "line": (loc?.line ?? 0) + 1, "column": (loc?.character ?? 0) + 1, ...vm.currentNode === null ? {} : { "at": rangeOf(vm.currentNode) }, ...loc === null || loc.file === sourceFile?.fileName ? {} : { "file": loc.file, "code": vm.currentNode?.getSourceFile().text.split("\n")[loc.line]?.trim() } }],
		"scopes": { "1": [{ "name": "Locals", "variablesReference": 1000, "expensive": false }, ...vm.loop === undefined ? [] : [{ "name": "Event loop", "variablesReference": 2000, "expensive": false }]] },
		"variables": { "1000": rows, ...vm.loop === undefined ? {} : { "2000": loopRows(vm.loop) } }
	};
}

/** What set a timer: setInterval, setImmediate (no delay) or setTimeout. */
function timerKind(timer: { "interval": boolean; "delay": number }): string {
	if (timer.interval) {
		return "setInterval";
	}

	return timer.delay === 0 ? "setImmediate" : "setTimeout";
}

/** The event loop at a stop, as the Variables view shows it: the virtual clock (since the run started, and its date),
 *  the pace, each timer pending and when it's due, each host call's result the program is owed — in, or not yet — and
 *  how many choices were made. */
function loopRows(loop: NonNullable<Vm["loop"]>): Variable[] {
	const since = (ms: number): string => `+${ms - loopStart}ms`;
	const row = (name: string, value: string, type: string): Variable => ({ "name": name, "value": value, "type": type, "variablesReference": 0 });
	const timers = [...loop.timers.values()].sort((left, right) => left.due - right.due || left.seq - right.seq);

	return [
		row("time", `${since(loop.clock)} · ${new Date(loop.clock).toISOString()}`, "virtual clock"),
		row("pace", loop.pace === "fast" ? "skipping waits" : "real time", ""),
		...timers.slice(0, 20).map((timer) => row(`${timerKind(timer)} ${timer.delay}ms`, `due ${since(timer.due)}${timer.ref ? "" : " · unref'd"}`, "timer")),
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

/** Each traced node's file, line and range, read once: a node is traced each time it runs. */
const tracedAt = new WeakMap<ts.Node, { "file": ts.SourceFile; "line": number; "at": [number, number] }>();
/** Each call's function as the live values name it, read once. */
const calleeAt = new WeakMap<ts.Node, NonNullable<Traced["callee"]>>();
/** The turns of a trace's loops, read once: tsval shares one loops array among a turn's events. */
const loopTurns = new WeakMap<TraceEvent["loops"], number[]>();

/** `node`'s file, line and range (tracedAt). */
function tracedPlace(node: ts.Node): { "file": ts.SourceFile; "line": number; "at": [number, number] } {
	let place = tracedAt.get(node);

	if (place === undefined) {
		// Each in its own file: the entry's, or another of the program's (packages/tsval/README.md, *Modules*).
		const file = node.getSourceFile();

		place = { "file": file, "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "at": rangeOf(node) };
		tracedAt.set(node, place);
	}

	return place;
}

/** A call's function by name and line (calleeAt). */
function calleeOf(node: ts.Node): NonNullable<Traced["callee"]> {
	let callee = calleeAt.get(node);

	if (callee === undefined) {
		const { line, at } = tracedPlace(node);

		callee = { "name": calleeName(node), "line": line, "at": at };
		calleeAt.set(node, callee);
	}

	return callee;
}

/** A trace's loops' turns (loopTurns). */
function turnsOf(loops: TraceEvent["loops"]): number[] {
	let turns = loopTurns.get(loops);

	if (turns === undefined) {
		turns = loops.map((loop) => loop.turn);
		loopTurns.set(loops, turns);
	}

	return turns;
}

/** What tsval's trace told, into the session's live values: its line, and its call's function by name and line. */
function traceValue(event: TraceEvent): void {
	if (sourceFile === undefined || probing !== undefined) {
		return; // (a probe's fork didn't run)
	}

	const place = tracedPlace(event.node);
	const traced: Traced = { "line": place.line, "name": event.name, "value": "", "raw": event.value, "kind": event.kind, "call": event.call, "turns": turnsOf(event.loops), "step": event.step, "at": place.at };

	if (event.callee !== undefined) {
		traced.callee = calleeOf(event.callee);
	}

	lastTraced = traced;
	liveIn(place.file).add(traced);
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

/** A function's, a class's or a method's own name, if it's one of those and has one. */
function declaredName(node: ts.Node): ts.Node | undefined {
	return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node) ? node.name : undefined;
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

	const name = declaredName(node);

	if (name !== undefined) {
		return name;
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

		if (batch !== undefined && file.fileName !== NODE_TEST) {
			// Another of the program's files: which, and its text the first time (what its values' ranges are in).
			const other = file === sourceFile ? {} : { "file": file.fileName, ...toldSource.has(file.fileName) ? {} : { "source": file.text } };

			toldSource.add(file.fileName);
			post({ "type": "values", "batch": batch, ...other });
		}
	}
}

function emitStopped(vm: Vm, reason: string, traveled = false, ask?: CapabilityAsk): void {
	denyNext = false;
	allowNext = false;
	skipNext = false;
	flushLive();
	post({ "type": "stopped", "reason": reason, "snapshot": { ...snapshot(vm), "traveled": traveled }, ...ask === undefined ? {} : { "ask": ask } });
}

/**
 * Pause hook for a breakpoint reached inside a synchronous host-invoked guest call (a server handler, an array
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

	for (const file of current?.coverage?.keys() ?? []) {
		others.add(file);
	}

	others.delete(sourceFile);

	for (const file of others) {
		if (file.fileName === NODE_TEST) {
			others.delete(file);
		}
	}

	const files = [...others].map((file) => ({ ...fileCoverage(file), "source": file.text }));

	return { ...fileCoverage(sourceFile), ...files.length === 0 ? {} : { "files": files }, ...packagesRan.size === 0 ? {} : { "packages": [...packagesRan.values()] } };
}

/** One program file's coverage, its observed sites and its top-level statements' profile. */
function fileCoverage(file: ts.SourceFile): CoverageReport {
	// (tsval's statements of the file and a count for each, in source order — or, for a file nothing ran in yet, its
	// statements found the same way, each at 0)
	const covered = current?.coverage?.get(file);
	const nodes: ts.Node[] = covered === undefined ? [] : [...covered.statements];

	if (covered === undefined) {
		const visit = (node: ts.Node): void => {
			if (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement) {
				nodes.push(node);
			}

			node.forEachChild(visit);
		};

		file.forEachChild(visit);
	}

	const statements: CoverageReport["statements"] = nodes.map((node, index) => {
		const start = file.getLineAndCharacterOfPosition(node.getStart(file));
		const end = file.getLineAndCharacterOfPosition(node.getEnd());

		return { "start": [start.line, start.character], "end": [end.line, end.character], "count": covered?.counts[index] ?? 0, "anchor": rangeOf(node) };
	});

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

	tellEffects();

	// (a test file's tests, each with what it ran — before the coverage, which ends what the editor keeps of the run)
	if (testsRan.length > 0) {
		post({ "type": "tests", "tests": testsRan });
	}

	post({ "type": "coverage", "report": coverageReport(), "final": true });
	post({ "type": "terminated", "exitCode": exitCode === 0 && testsFailed > 0 ? 1 : exitCode, ...crash === undefined ? {} : { "crash": crash } });
}

/** Where `vm` is stopped: its file, and the 1-based line in it. */
function placeOf(vm: Vm): Place | undefined {
	const location = vm.location();

	return location === null ? undefined : { "file": location.file, "line": location.line + 1 };
}

/** Where `error` was thrown, for the margin's mark: by now the frames have unwound, so tsval's note of it, not the
 *  current node. Best-effort — the run ends whatever this finds. */
function crashOf(vm: Vm, error: unknown, message?: string): Crash | undefined {
	try {
		const site = vm.throwSite(error);
		const at = vm.location(site);
		// (an Error, else whatever was thrown — a primitive)
		const thrown = error as Error | string | number | boolean | null | undefined;

		return at === null || site === null ? undefined : { "line": at.line, "at": rangeOf(site), "message": message ?? String(thrown), ...at.file === sourceFile?.fileName ? {} : { "file": at.file } };
	} catch {
		return undefined;
	}
}

/** Where `vm` is now, as a stopped run's end (`message`, the reason): the margin's ■ on that line. */
function stoppedAt(vm: Vm, message: string): Crash | undefined {
	const node = vm.currentNode;
	const at = vm.location(node);

	return at === null || node === null ? undefined : { "line": at.line, "at": rangeOf(node), "message": message, "stopped": true, ...at.file === sourceFile?.fileName ? {} : { "file": at.file } };
}

/** What a run that stopped on something the debugger can't run says, loudly and as itself — not as the program's own
 *  error, and without naming the interpreter: what it met (marked on its line, as a crash is). Undefined for any other
 *  error. (RUNNING.md: no fallback — a gap is a bug to fix, shown where it was met.) */
function unrunnable(error: unknown): string | undefined {
	if (!(error instanceof TsvalInternalError)) {
		return undefined;
	}

	const unimplemented = /^unimplemented: (?<what>[\s\S]*)$/u.exec(error.message)?.groups?.what;

	return unimplemented === undefined ? `The debugger failed here: ${error.message}` : `Can't run this yet — the debugger doesn't support ${unimplemented}`;
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
		case "continue":
			runOn(base);
			break;
		case "next": {
			const from = placeOf(base);

			base.stepStatement();

			// Stepped over a statement a rule sets after: its sets, as a run through it makes them.
			if (from !== undefined && hooksAt(from).length > 0) {
				applySets(base, from);
			}

			break;
		}

		case "stepIn":
			base.step();
			break;
		case "stepOut":
			stepOut(base);
			break;
		default: break;
	}
}

/** Why a forward action stopped where it did: a continue (or a step-out a breakpoint cut short) at a breakpoint — a
 *  capability line's, a capability stop — else a step. */
function stopReason(base: Vm, action: ForwardAction, stop: Place | undefined): "capability" | "breakpoint" | "step" {
	if (action === "continue" || (action === "stepOut" && base.atBreakpoint())) {
		return stop !== undefined && capabilityAt(stop) ? "capability" : "breakpoint";
	}

	return "step";
}

async function advanceFrom(base: Vm, action: ForwardAction, trace?: TraceContext): Promise<void> {
	current = base;
	evaluating = base; // (a program file a package requires is evaluated on the machine running)
	const span = trace !== undefined ? workerLog().continueSpan(trace, "step", { "action": action }) : workerLog().span("step", { "action": action });

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
			// An unattended run halted before a call that never ran for real: it stops there, saying why — not a crash.
			if (typeof error === "object" && error !== null && HALTED in error) {
				finish(0, stoppedAt(base, `halted before ${String((error as { [HALTED]: unknown })[HALTED])}: it never ran for real, so there's nothing to give it — Rule… or Pin… on its line`));
				done = true;

				return;
			}

			// A live run past its budget stops where it got to — saying so, not as a crash.
			if (liveRun && error instanceof TsvalInternalError && error.message.startsWith("step budget exceeded")) {
				finish(0, stoppedAt(base, "too long to run live — Run to finish"));
				done = true;

				return;
			}

			const unsupported = unrunnable(error);

			post({ "type": "output", "text": unsupported ?? "Uncaught " + String(error), "stream": "stderr" });
			finish(1, crashOf(base, error, unsupported));
			done = true;

			return;
		}

		if (base.finished) {
			if (base.completion !== undefined) {
				// (the Debug Console shows it, as a REPL would; node doesn't print it, so a terminal doesn't either)
				post({ "type": "output", "text": "→ " + format(base.completion), "stream": "console" });
			}

			finish();
			done = true;

			return;
		}

		// Branch: drop any redo tail, then record this stop. The stored fork is only ever forked from, never
		// stepped, so it stays a pristine snapshot we can return to.
		history = history.slice(0, index + 1);
		history.push(base);
		toldAt.set(base, new Map([...live.values()].map((record) => [record, record.told()])));
		index = history.length - 1;
		// A "continue" that landed on a capability line is a capability stop (the policy gated it); steps stay "step".
		const stop = placeOf(base);
		// A step-out cut short by a breakpoint reports it as one, like a continue would.
		const reason = stopReason(base, action, stop);

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

		case "continue":
		case "next":
		case "stepIn":
		case "stepOut": {
			// Forward: fork the current stop and advance a copy (honors the action even after a step-back), its
			// observations going on from a copy of that stop's.
			const next = history[index].fork();

			if (next.loop !== undefined) {
				next.loop.pace = pace;
			}

			record(next, copySums(sumsOf.get(history[index])));

			// (its values told from where they were at this stop: after a step back, the ones told already are replays)
			for (const each of live.values()) {
				each.resume(toldAt.get(history[index])?.get(each));
			}

			await advanceFrom(next, action, actionTrace);
			break;
		}

		// no default
	}
}

async function session(initial: Vm, launchTrace?: TraceContext): Promise<void> {
	await advanceFrom(initial, "continue", launchTrace); // run to the first breakpoint (or completion)

	while (!done) {
		const action = await nextAction();

		await handle(action);
	}
}

/** Where a launch's program runs: its directory and environment, as the launch gives them. */
function whereOf(message: Extract<Control, { "type": "launch" }>): { "cwd"?: string; "env"?: Record<string, string> } {
	return { ...message.cwd === undefined ? {} : { "cwd": message.cwd }, ...message.env === undefined ? {} : { "env": message.env } };
}

/** Whether `file`'s text doesn't parse (yet): saved, or run on the interval, mid-statement. */
function unparsed(file: ts.SourceFile): boolean {
	return ((file as unknown as { "parseDiagnostics"?: readonly unknown[] }).parseDiagnostics?.length ?? 0) > 0;
}

/** Each rule's hook, in the file it's placed in: the entry's (`entry`), or another of the program's (the adapter places
 *  both) — by file and line. */
function hooksByFile(hooks: readonly SetHook[], entry: string): Map<string, Map<number, SetHook[]>> {
	const byFile = new Map<string, Map<number, SetHook[]>>();

	for (const hook of hooks) {
		const file = hook.file ?? entry;
		const inFile = byFile.get(file) ?? new Map<number, SetHook[]>();

		inFile.set(hook.line, [...inFile.get(hook.line) ?? [], hook]);
		byFile.set(file, inFile);
	}

	return byFile;
}

/** A program launched for debugging: its module system ready first (almostnode: packages/tsval/README.md, *Modules*), then its machine — the entry
 *  a module of the program's, its files tsval's — armed and run to its first stop. */
async function launchProgram(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Promise<void> {
	// tsval's event loop (steppedAsync with timers, a virtual clock and a seeded random): async code and timers run
	// on the stack the debugger steps — its breakpoints, capability stops, rules — and the same way every time, so a
	// step forward from any stop it travelled back to goes the way it went. Its start is logged, to run it again; a
	// launch can give one (an ordering explore found: its clock, seed and schedule).
	// A server it starts keeps it alive: out of work, it idles, serving.
	liveRun = message.live === true;
	recordedResults = liveRun && message.recorded !== undefined ? message.recorded : {};
	unattended = liveRun && message.unattended === true;
	// (a fresh layer for each live run: what the last one wrote is gone)
	runLayer = liveRun && editorLink !== undefined ? layered(editorLink.fs) : undefined;

	// (a live run's timers at once — its waits skipped — and nothing keeps it alive past its first idle)
	const eventLoop = { "now": Date.now(), "seed": Math.floor(Math.random() * 2 ** 32), ...message.eventLoop, "pace": liveRun ? "fast" as const : "real" as const, "keepAlive": () => !liveRun && (held.size > 0 || readsStdin()) };
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

	// Its capabilities real (RUNNING.md, *Effects are real, decided per call*): each gated call decided as it's made — but
	// for a run of an ordering exploring found (its schedule given), which replays that run: its calls' results the
	// stand-ins' it had.
	const surface = capabilitySurface(message.fileName, message.args ?? [], message.eventLoop?.schedule === undefined ? loadedRuntime : undefined, whereOf(message));

	programBuiltins = surface.modules;
	runtime?.clearCache();
	packagesRan.clear();
	baseline = readBaseline();
	pins = readPins();
	dropUnpinned();

	testsRan = [];
	testStarts.clear();
	testsFailed = 0;

	const loaded = createVM(message.source, { "fileName": message.fileName, "onBreakpoint": onBreakpointHook, "coverage": true, "profile": true, "observe": observeSite, "trace": traceValue, "eventLoop": eventLoop, "globals": { ...nodeGlobals, ...surface.globals, "__editorTest": testTold }, "modules": modules, ...liveRun ? { "maxSteps": LIVE_STEPS } : {} });

	evaluating = loaded.vm;

	// A live run of text that doesn't parse yet (saved mid-statement) runs nothing and tells nothing: the margin
	// keeps what the last run that parsed did.
	if (liveRun && unparsed(loaded.sourceFile)) {
		post({ "type": "terminated", "exitCode": 0, "quiet": true });

		return;
	}

	loopStart = eventLoop.now;
	pace = liveRun ? "fast" : "real";
	workerLog().info("event loop", { "now": eventLoop.now, "seed": eventLoop.seed, ...eventLoop.schedule === undefined ? {} : { "schedule": eventLoop.schedule } });

	liveTimer = setInterval(flushLive, 250);

	({ sourceFile } = loaded);
	record(loaded.vm, new Map());
	// Capability breakpoints: pre-arm a breakpoint at every capability call the policy won't let pass, so a
	// gated call hard-stops at its line with the debugger's normal step / step-back, and asks there (RUNTIME-EVIDENCE.md,
	// *Capability decisions, on the line*). No policy → every undecided dangerous call breaks (firewall default).
	({ policy } = message);
	// (a live run stops at nothing: no breakpoints, no capability lines — what it can't make, it skips)
	userLines = liveRun ? [] : message.lines;
	fileLines = liveRun ? new Map() : new Map(Object.entries(message.files ?? {}));
	programPath = message.program ?? message.fileName;
	setHooks = hooksByFile(message.hooks ?? [], message.fileName);

	// What it reads from outside, first: process.argv (the margin mocks it there).
	reportArgv(loaded.sourceFile, message.args ?? []);
	programFiles = new Map([[loaded.sourceFile.fileName, loaded.sourceFile]]);
	capabilityLines = new Map([[loaded.sourceFile.fileName, new Set(policy !== undefined && !liveRun ? capabilityBreakLines(loaded.sourceFile, policy) : [])]]);
	arm(loaded.vm);

	history = [];
	index = -1;
	done = false;
	await session(loaded.vm, trace);
}

/** A recorded call replayed for the debugger: the function run on what it read in the page — its free names its globals,
 *  revived — each call to something it couldn't record (a page's function, a DOM method, the network) handed the result
 *  it had there, by where it was made and how many times; a call with a function of the program's among its arguments
 *  (`items.map(fn)`) made for real, so the debugger steps into it. Its breakpoints are the file's, the stop among them. */
async function launchReplay(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): Promise<void> {
	const { replay } = message;
	const { standIn, hostGuard } = replayGuard(replay);
	const self = revive(replay.self, standIn);
	const eventLoop = { "now": Date.now(), "seed": 1, "pace": "fast" as const };
	const loaded = createVM(replayProgram(message.source, replay.fn), {
		"fileName": message.fileName,
		"onBreakpoint": onBreakpointHook,
		"coverage": true,
		"profile": true,
		"observe": observeSite,
		"trace": traceValue,
		"eventLoop": eventLoop,
		"hostGuard": hostGuard,
		"globals": {
			...nodeGlobals,
			"__self": typeof self === "object" && self !== null ? self : {},
			"__args": replay.args.map((arg) => revive(arg, standIn)),
			"console": guestConsole()
		}
	});

	// What it read from outside itself, as the scope around it: bindings the debugger shows (and the call assigns to).
	for (const [name, value] of Object.entries(replay.free)) {
		loaded.vm.rootScope.bindings.set(name, { "value": revive(value, standIn), "kind": "let", "initialized": true });
	}

	evaluating = loaded.vm;
	loopStart = eventLoop.now;
	pace = "fast";
	liveTimer = setInterval(flushLive, 250);
	({ sourceFile } = loaded);
	record(loaded.vm, new Map());
	policy = undefined;
	userLines = message.lines;
	fileLines = new Map();
	programPath = message.program ?? message.fileName;
	setHooks = new Map();
	programFiles = new Map([[loaded.sourceFile.fileName, loaded.sourceFile]]);
	capabilityLines = new Map();
	arm(loaded.vm);
	history = [];
	index = -1;
	done = false;
	await session(loaded.vm, trace);
}

/** Launch a run: its program's, or a recorded call's replay. */
function launch(message: Extract<Control, { "type": "launch" }>, trace: TraceContext | undefined): void {
	// Absent without cross-origin isolation: then a breakpoint inside a host-invoked handler can't pause (onBreakpointHook).
	control = message.control === undefined ? undefined : new Int32Array(message.control);
	workerLog().info("launch", { "file": message.fileName, "breakpoints": message.lines.length, "replay": message.replay !== undefined });
	void (message.replay === undefined ? launchProgram(message, trace) : launchReplay(message, trace));
}

function setBreakpoints(message: Extract<Control, { "type": "setBreakpoints" }>): void {
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
}

function typed(message: Extract<Control, { "type": "stdin" }>): void {
	// Typed in the Debug Console or the terminal it was started in: the program's input — its listeners called with
	// it (or, at its end, told so), and the run woken to go on.
	if (message.end === true) {
		stdin.emit("end");
	} else {
		stdin.emit("data", message.data);
	}

	current?.loop?.wake?.();
}

function setPace(message: Extract<Control, { "type": "pace" }>): void {
	// From the next wait on — the machine running now, and every stop it may go on from.
	({ pace } = message);

	for (const vm of [...history, current]) {
		if (vm?.loop !== undefined) {
			vm.loop.pace = pace;
		}
	}
}

function decide(message: Extract<Control, { "type": "decide" }>): void {
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
	skipNext = message.skip === true;
	answeredNext = message.decided;
	giveNext = message.give === undefined ? undefined : { "value": message.give };
	// Allowed — once, this run, always, by a rule: the call asked about happens for real.
	allowNext = !denyNext && !skipNext && giveNext === undefined;
}

globalThis.addEventListener("message", (event: MessageEvent<ToWorker>): void => {
	if (event.data.kind === "runtime") {
		editorLink = connectRuntime(event.data.port, { "name": "debug-worker" });

		return;
	}

	const message = event.data.control;
	const { trace } = event.data;

	switch (message.type) {
		case "explore":
			void exploreOrderings(message).then((explored) => {
				post({ "type": "explored", "explored": explored });
			});
			break;

		case "launch": {
			launch(message, trace);
			break;
		}

		case "coverage":
			// (asked as a session stops, too: its effects so far go with it)
			tellEffects();
			post({ "type": "coverage", "report": coverageReport() });
			break;

		case "setBreakpoints":
			setBreakpoints(message);
			break;

		case "stdin":
			typed(message);
			break;

		case "pace":
			setPace(message);
			break;

		case "setValue":
			// The stop's own machine (the pristine snapshot a continue forks from), so the run goes on with the value.
			post(done || history[index] === undefined ? { "type": "valueSet", "ok": false, "error": "not stopped" } : setValue(history[index], message.name, message.value));
			break;

		case "decide":
			decide(message);
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
