/**
 * The canary (ASSIGNMENT §5) — the reason the interpreter exists.
 *
 * Run guest code in a sanitized environment where every capability surface (net, fs:read, fs:write,
 * exec, env, eval) is an injected recording shim, and hard-abort the instant runtime reaches a
 * capability the STATIC pass didn't predict. It turns "did we model every sneaky construction?"
 * (`globalThis["fe"+"tch"]`, aliasing, reflection, dynamic dispatch — impossible to enumerate) into
 * "did runtime step outside the predicted set?" (checkable).
 *
 * The capability vocabulary is exactly silo's (`lib/util/silo/detect.ts`): net, fs:read, fs:write,
 * fs (coarse), exec, env, eval. The predicted set is silo's static output — pass `detect(code)` (and,
 * for the resource axis, `findReach(code)`) in as `predicted`; this module is the dynamic complement,
 * so it does not re-implement the static analysis (and stays free of oxc / the `lib` dependency).
 *
 * Free byproduct (Axis-2 resolver): the shims capture the CONCRETE resource each call received — the
 * real URL/path/command/env-key, including ones static analysis couldn't resolve (const/template/
 * runtime) — reported in `observed`.
 */

import { UNCATCHABLE, isUncatchable } from "./errors.ts";
import { createVM, createTypedVM } from "./interpret.ts";
import type { InterpretOptions } from "./interpret.ts";
import { typeOfNode } from "./program.ts";
import type { HostGuard, VM } from "./vm.ts";

/** One capability the guest reached at runtime, shaped like silo's `Reach`. */
export interface CanaryEvent {
	capability: string;
	/** the concrete resource: URL / path / command / env key (the Axis-2 value). */
	value: string;
	/** the rendered call/receiver, e.g. `fetch`, `fs.writeFile`, `process.env`. */
	callee: string;
	/** read (net GET / fs:read / env read) vs mutation, where meaningful. */
	safe?: boolean;
	/** static type of the resource argument at the callsite (type-aware runs, ASSIGNMENT S6). */
	valueType?: string;
	/** the resource argument's type is assignable to (name-matches) a configured sensitive type. */
	sensitive?: boolean;
}

export interface CanaryReport {
	/** true iff runtime stayed within the predicted capability set. */
	ok: boolean;
	/** true iff the run was hard-aborted by a divergence. */
	aborted: boolean;
	/** the predicted capability set the run was checked against. */
	predicted: string[];
	/** every capability reach observed, in order (up to an abort) — the Axis-2 resolver output. */
	observed: CanaryEvent[];
	/** distinct capabilities observed. */
	observedCaps: string[];
	/** the reach that tripped the tripwire, if any. */
	divergence?: CanaryEvent;
	/** completion value, when the run finished without diverging. */
	completion?: unknown;
	/** a non-divergence guest error that escaped the run, if any. */
	error?: unknown;
	/** reaches whose resource argument had a sensitive static type (type-directed, S6). */
	sensitiveFlows: CanaryEvent[];
	/** async work (fibers / timers) still outstanding when the report was produced. Non-zero from the
	 *  synchronous `runCanary` is itself a failure (`ok: false`) — use `runCanaryAsync`. */
	pendingAsync: number;
}

export interface CanaryOptions {
	/** Static predicted capabilities (silo `detect(code)`). Runtime must stay within this set. */
	predicted: string[];
	/** "observe" (default): record + return benign stubs. "passthrough": also perform via `perform`. */
	mode?: "observe" | "passthrough";
	/** extra globals to expose beyond the sanitized baseline. */
	globals?: Record<string, unknown>;
	/** extra module namespaces by specifier (merged over the built-in shims). */
	modules?: Record<string, unknown>;
	/** build a `TypeChecker` and annotate each reach with its resource argument's static type. */
	useTypes?: boolean;
	/** type names to flag when a value of that type flows into a sink (implies `useTypes`). */
	sensitiveTypes?: string[];
	fileName?: string;
}

/** A divergence tripwire — thrown from a shim, uncatchable by guest `try/catch`, caught by `runCanary`. */
export class CanaryDivergenceError extends Error {
	override name = "CanaryDivergenceError";
	readonly [UNCATCHABLE] = true;
	readonly event: CanaryEvent;
	constructor(event: CanaryEvent) {
		super(`canary divergence: runtime reached '${event.capability}' (${event.callee} → ${JSON.stringify(event.value)}) outside the predicted set`);
		this.event = event;
	}
}

// Capability name lists, mirroring silo `detect.ts` CALL_DETECTORS (single vocabulary; inlined to keep
// this module free of the oxc-based `lib` dependency).
const FS_READ = ["readFile", "readFileSync", "createReadStream", "readdir", "readdirSync", "exists", "existsSync", "stat", "statSync", "lstat", "realpath", "access", "opendir"];
const FS_WRITE = ["writeFile", "writeFileSync", "createWriteStream", "mkdir", "mkdirSync", "unlink", "unlinkSync", "rm", "rmSync", "rename", "renameSync", "appendFile", "appendFileSync", "copyFile", "chmod"];
const EXEC = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

/** A predicted set "covers" a runtime capability if it lists it, or lists coarse `fs` for an `fs:*`. */
export function covers(predicted: Iterable<string>, capability: string): boolean {
	const set = predicted instanceof Set ? predicted : new Set(predicted);
	if (set.has(capability)) return true;
	if (capability.startsWith("fs:") && set.has("fs")) return true;
	return false;
}

/** Collects reaches, annotates them (types), and trips the tripwire on any unpredicted capability. */
class Recorder {
	readonly events: CanaryEvent[] = [];
	/** set the moment a divergence fires — wherever it fires (sync run, fiber, timer). */
	divergence: CanaryEvent | undefined;
	private readonly predicted: Set<string>;
	private readonly annotate: (event: CanaryEvent) => void;
	constructor(predicted: Set<string>, annotate: (event: CanaryEvent) => void) {
		this.predicted = predicted;
		this.annotate = annotate;
	}

	record(event: CanaryEvent): void {
		this.annotate(event);
		this.events.push(event);
		if (!covers(this.predicted, event.capability)) {
			this.divergence ??= event;
			throw new CanaryDivergenceError(event);
		}
	}
}

/** Outstanding async work started by the guest: async fibers and timer/microtask callbacks. */
class PendingWork {
	private readonly fibers = new Set<Promise<unknown>>();
	private timers = 0;
	private settleWaiters: (() => void)[] = [];

	get count(): number {
		return this.fibers.size + this.timers;
	}

	trackFiber(promise: Promise<unknown>): void {
		this.fibers.add(promise);
		// Observe settlement without turning a divergence into an unhandled rejection: it's already
		// recorded in the Recorder; the async runner reads it from there.
		promise.then(
			() => this.done(promise),
			() => this.done(promise),
		);
	}

	timerStarted(): void {
		this.timers++;
	}

	timerFinished(): void {
		this.timers--;
		this.notify();
	}

	private done(promise: Promise<unknown>): void {
		this.fibers.delete(promise);
		this.notify();
	}

	private notify(): void {
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const w of waiters) w();
	}

	/** Resolve once no work is outstanding (or `maxMs` elapses — e.g. a never-cleared interval). */
	async drain(maxMs: number): Promise<void> {
		const deadline = Date.now() + maxMs;
		while (this.count > 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				this.settleWaiters.push(resolve);
				setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now())));
			});
		}
	}
}

// Real globals considered safe (no capability): pure intrinsics, formatting, timing, console.
const SAFE_GLOBAL_NAMES = [
	"Object", "Array", "String", "Number", "Boolean", "BigInt", "Symbol", "Math", "JSON", "Date", "RegExp",
	"Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy", "Reflect", "Error", "TypeError",
	"RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "parseInt",
	"parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
	"console", "structuredClone", "ArrayBuffer", "SharedArrayBuffer", "Uint8Array", "Int8Array", "Uint8ClampedArray",
	"Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array",
	"BigUint64Array", "DataView", "Intl", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "atob", "btoa",
	"setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "NaN", "Infinity", "undefined",
];

/** A sanitized global environment: safe intrinsics only, no capability surfaces. */
export function safeGlobals(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const source = globalThis as Record<string, unknown>;
	for (const name of SAFE_GLOBAL_NAMES) if (name in source) out[name] = source[name];
	return out;
}

function httpVerbSafe(method: unknown): boolean {
	const m = String(method ?? "GET").toUpperCase();
	return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

// The real code-from-string constructors. Every real intrinsic leaks them (`[].constructor.constructor`
// is `Function`), so the sanitized environment must catch them at the host boundary, not by name.
const REAL_EVAL = globalThis.eval;
const CODE_CONSTRUCTORS = new Set<unknown>([
	Function,
	Object.getPrototypeOf(async function () {}).constructor,
	Object.getPrototypeOf(function* () {}).constructor,
	Object.getPrototypeOf(async function* () {}).constructor,
]);
const { call: FN_CALL, apply: FN_APPLY, bind: FN_BIND } = Function.prototype;
const { then: PROMISE_THEN, catch: PROMISE_CATCH, finally: PROMISE_FINALLY } = Promise.prototype;

interface Environment {
	globals: Record<string, unknown>;
	resolveModule: (s: string) => unknown;
	hostGuard: HostGuard;
	pending: PendingWork;
}

/** Build the shimmed capability environment (globals + module resolver + host guard) bound to a recorder. */
function capabilityEnvironment(recorder: Recorder, options: CanaryOptions): Environment {
	const stubResponse = () => ({ ok: true, status: 200, statusText: "OK", headers: {}, text: async () => "", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
	const pending = new PendingWork();

	// --- net ---
	const fetchShim = (input: unknown, init?: { method?: string }) => {
		recorder.record({ capability: "net", value: typeof input === "string" ? input : String((input as { url?: string })?.url ?? input), callee: "fetch", safe: httpVerbSafe(init?.method) });
		return Promise.resolve(stubResponse());
	};
	class WebSocketShim {
		constructor(url: unknown) {
			recorder.record({ capability: "net", value: String(url), callee: "WebSocket", safe: false });
		}
	}
	const httpGet = (name: string) => (url: unknown) => {
		recorder.record({ capability: "net", value: typeof url === "string" ? url : String((url as { href?: string })?.href ?? url), callee: name, safe: name.endsWith("get") });
		return { on: () => undefined, end: () => undefined, write: () => undefined };
	};
	const netModule = (prefix: string) => ({ get: httpGet(`${prefix}.get`), request: httpGet(`${prefix}.request`) });

	// --- fs ---
	const fsCall = (name: string, capability: string) => (path: unknown, ...rest: unknown[]) => {
		recorder.record({ capability, value: String(path), callee: `fs.${name}`, safe: capability === "fs:read" });
		const cb = rest[rest.length - 1];
		if (typeof cb === "function") return void (cb as (e: unknown, d: unknown) => void)(null, capability === "fs:read" ? "" : undefined);
		return capability === "fs:read" ? "" : undefined;
	};
	const buildFs = (promises: boolean) => {
		const mod: Record<string, unknown> = {};
		const wrap = (name: string, capability: string) => {
			const fn = fsCall(name, capability);
			mod[name] = promises && !name.endsWith("Sync") ? (...a: unknown[]) => Promise.resolve((fn as (...x: unknown[]) => unknown)(...a)) : fn;
		};
		for (const name of FS_READ) wrap(name, "fs:read");
		for (const name of FS_WRITE) wrap(name, "fs:write");
		return mod;
	};
	const fsModule = buildFs(false);
	(fsModule as { promises?: unknown }).promises = buildFs(true);
	(fsModule as { default?: unknown }).default = fsModule;

	// --- exec ---
	const execCall = (name: string) => (command: unknown) => {
		recorder.record({ capability: "exec", value: String(command), callee: name, safe: false });
		return { on: () => undefined, stdout: { on: () => undefined }, stderr: { on: () => undefined }, kill: () => undefined, status: 0, stdout_: "" };
	};
	const childProcess: Record<string, unknown> = {};
	for (const name of EXEC) childProcess[name] = execCall(name);
	(childProcess as { default?: unknown }).default = childProcess;

	// --- env ---
	const envProxy = new Proxy(
		{},
		{
			get: (_t, key) => {
				if (typeof key === "string") recorder.record({ capability: "env", value: key, callee: "process.env", safe: true });
				return "";
			},
			has: () => true,
		},
	);
	const processShim = { env: envProxy, platform: "linux", argv: [], cwd: () => "/", version: "v0.0.0" };

	// --- eval ---
	const evalShim = (code: unknown) => {
		recorder.record({ capability: "eval", value: typeof code === "string" ? code : "<non-string>", callee: "eval", safe: false });
		return undefined;
	};
	const FunctionShim = function (...args: unknown[]) {
		recorder.record({ capability: "eval", value: String(args[args.length - 1] ?? ""), callee: "Function", safe: false });
		return () => undefined;
	};
	const isCodeConstructor = (v: unknown): boolean => CODE_CONSTRUCTORS.has(v) || v === REAL_EVAL;
	const shimFor = (v: unknown): unknown => (v === REAL_EVAL ? evalShim : FunctionShim);

	// Promise reactions run from host land as microtasks. Wrap the callbacks so (a) a divergence inside
	// one is swallowed — it's already recorded, and letting it reject the derived promise would only
	// surface as an unhandled rejection — and (b) the reaction counts as pending work until the source
	// promise settles, so `runCanaryAsync` waits for it.
	const wrapReaction = (method: (...a: unknown[]) => unknown) =>
		function (this: Promise<unknown>, ...callbacks: unknown[]): unknown {
			let open = true;
			pending.timerStarted();
			const finish = (): void => {
				if (!open) return;
				open = false;
				pending.timerFinished();
			};
			PROMISE_THEN.call(this, finish, finish); // settle-based, whichever reaction path runs
			const wrapped = callbacks.map((cb) =>
				typeof cb !== "function"
					? cb
					: (...a: unknown[]) => {
							try {
								return (cb as (...x: unknown[]) => unknown)(...a);
							} catch (error) {
								if (error instanceof CanaryDivergenceError) return undefined;
								throw error;
							}
						},
			);
			return method.apply(this, wrapped);
		};
	const guardedReactions = new Map<unknown, (...a: unknown[]) => unknown>([
		[PROMISE_THEN, wrapReaction(PROMISE_THEN as (...a: unknown[]) => unknown)],
		[PROMISE_CATCH, wrapReaction(PROMISE_CATCH as (...a: unknown[]) => unknown)],
		[PROMISE_FINALLY, wrapReaction(PROMISE_FINALLY as (...a: unknown[]) => unknown)],
	]);

	// --- the host guard: keeps the sandbox closed at the interpreter's host boundary ---
	const hostGuard: HostGuard = {
		// Any read/return that yields a real code-from-string constructor becomes the shim.
		sanitize: (value) => (isCodeConstructor(value) ? shimFor(value) : value),
		// Vet callables at invocation, including `Function.prototype.call/apply/bind` aimed at one.
		beforeCall: (callee, thisArg) => {
			if (isCodeConstructor(callee)) return shimFor(callee) as (...a: unknown[]) => unknown;
			if ((callee === FN_CALL || callee === FN_APPLY || callee === FN_BIND) && isCodeConstructor(thisArg)) {
				const shim = shimFor(thisArg) as (...a: unknown[]) => unknown;
				if (callee === FN_BIND) return () => shim;
				return (...a: unknown[]) => (callee === FN_APPLY ? shim(...((a[1] as unknown[]) ?? [])) : shim(...a.slice(1)));
			}
			return guardedReactions.get(callee) ?? callee;
		},
	};

	// `Reflect.apply/construct` invoke from host land, bypassing the interpreter's call boundary: wrap.
	// (Reflect's methods are non-enumerable, so copy by name rather than spread.)
	const guardedReflect = Object.fromEntries(Object.getOwnPropertyNames(Reflect).map((name) => [name, (Reflect as unknown as Record<string, unknown>)[name]])) as Record<string, unknown>;
	guardedReflect.apply = (target: unknown, thisArg: unknown, args: ArrayLike<unknown>) => Reflect.apply(hostGuard.beforeCall!(target as (...a: unknown[]) => unknown, thisArg, false), thisArg, Array.from(args));
	guardedReflect.construct = (target: unknown, args: ArrayLike<unknown>, newTarget?: unknown) => {
		const vetted = hostGuard.beforeCall!(target as (...a: unknown[]) => unknown, undefined, true) as unknown as new (...a: unknown[]) => unknown;
		return Reflect.construct(vetted, Array.from(args), (newTarget ?? vetted) as new (...a: unknown[]) => unknown);
	};

	// Timers: a string callback is `eval`; a function callback is tracked as pending async work, and a
	// divergence inside it is recorded (already in the Recorder) rather than escaping as uncaught.
	const runLater = (cb: unknown, args: unknown[], name: string): (() => void) | undefined => {
		if (typeof cb !== "function") {
			recorder.record({ capability: "eval", value: String(cb), callee: name, safe: false });
			return undefined;
		}
		pending.timerStarted();
		return () => {
			try {
				(cb as (...a: unknown[]) => unknown)(...args);
			} catch (error) {
				if (!isUncatchable(error)) throw error;
				if (!(error instanceof CanaryDivergenceError)) throw error; // an interpreter bug stays loud
			} finally {
				pending.timerFinished();
			}
		};
	};
	const setTimeoutShim = (cb: unknown, ms?: number, ...args: unknown[]) => {
		const task = runLater(cb, args, "setTimeout");
		return task === undefined ? 0 : setTimeout(task, ms);
	};
	const setIntervalShim = (cb: unknown, ms?: number, ...args: unknown[]) => {
		if (typeof cb !== "function") return void runLater(cb, args, "setInterval");
		pending.timerStarted();
		return setInterval(() => {
			try {
				(cb as (...a: unknown[]) => unknown)(...args);
			} catch (error) {
				if (!(error instanceof CanaryDivergenceError)) throw error;
			}
		}, ms);
	};
	const clearIntervalShim = (id: ReturnType<typeof setInterval>) => {
		clearInterval(id);
		pending.timerFinished();
	};
	const queueMicrotaskShim = (cb: unknown) => {
		const task = runLater(cb, [], "queueMicrotask");
		if (task !== undefined) queueMicrotask(task);
	};

	const globals: Record<string, unknown> = {
		...safeGlobals(),
		Reflect: guardedReflect,
		setTimeout: setTimeoutShim,
		setInterval: setIntervalShim,
		clearInterval: clearIntervalShim,
		queueMicrotask: queueMicrotaskShim,
		fetch: fetchShim,
		WebSocket: WebSocketShim,
		process: processShim,
		eval: evalShim,
		Function: FunctionShim,
		...(options.globals ?? {}),
	};
	// Self-reference so reflection-based access — `globalThis["fe"+"tch"]`, `self.fetch` — routes through
	// the shims and is *caught* as divergence rather than silently denied (ASSIGNMENT §1 example).
	globals.globalThis = globals;
	globals.self = globals;

	const builtinModules: Record<string, unknown> = {
		fs: fsModule,
		"node:fs": fsModule,
		"fs/promises": fsModule.promises,
		"node:fs/promises": fsModule.promises,
		child_process: childProcess,
		"node:child_process": childProcess,
		http: netModule("http"),
		"node:http": netModule("http"),
		https: netModule("https"),
		"node:https": netModule("https"),
		net: netModule("net"),
		"node:net": netModule("net"),
		process: processShim,
		"node:process": processShim,
		...(options.modules ?? {}),
	};
	// `require` is a plain host global returning a module namespace.
	globals.require = (spec: string) => builtinModules[spec];

	const resolveModule = (spec: string): unknown => builtinModules[spec] ?? (options.modules ?? {})[spec];
	return { globals, resolveModule, hostGuard, pending };
}

interface CanaryRun {
	recorder: Recorder;
	pending: PendingWork;
	report: CanaryReport;
}

/** Shared by the sync and async runners: build the environment, run the synchronous part. */
function startCanary(code: string, options: CanaryOptions): CanaryRun {
	const predicted = new Set(options.predicted);
	const useTypes = options.useTypes === true || (options.sensitiveTypes?.length ?? 0) > 0;
	const sensitive = new Set(options.sensitiveTypes ?? []);
	const context: { vm: VM | undefined } = { vm: undefined };

	// Annotate a reach with the static type of its resource argument, read from the live callsite.
	const annotate = (event: CanaryEvent): void => {
		const site = context.vm?.callSite;
		const checker = context.vm?.typeChecker;
		if (site === undefined || checker === undefined) return;
		const valueType = typeOfNode(checker, site.arguments?.[0]);
		if (valueType === undefined) return;
		event.valueType = valueType;
		if ([...sensitive].some((name) => valueType === name || valueType.includes(name))) event.sensitive = true;
	};

	const recorder = new Recorder(predicted, annotate);
	const { globals, resolveModule, hostGuard, pending } = capabilityEnvironment(recorder, options);
	const vmOptions: InterpretOptions = { globals, resolveModule, hostGuard, realGlobals: false, fileName: options.fileName, onAsyncFiber: (p) => pending.trackFiber(p) };
	const report: CanaryReport = { ok: true, aborted: false, predicted: [...predicted].sort(), observed: recorder.events, observedCaps: [], sensitiveFlows: [], pendingAsync: 0 };

	try {
		const vm = useTypes ? createTypedVM(code, vmOptions) : createVM(code, vmOptions);
		context.vm = vm;
		report.completion = vm.run();
	} catch (error) {
		if (!(error instanceof CanaryDivergenceError)) report.error = error; // a normal guest error, or an interpreter bug
	}
	return { recorder, pending, report };
}

function finishReport({ recorder, pending, report }: CanaryRun): CanaryReport {
	if (recorder.divergence !== undefined) {
		report.ok = false;
		report.aborted = true;
		report.divergence = recorder.divergence;
	}
	report.pendingAsync = pending.count;
	report.observedCaps = [...new Set(recorder.events.map((e) => e.capability))].sort();
	report.sensitiveFlows = recorder.events.filter((e) => e.sensitive === true);
	return report;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as { then?: unknown })?.then === "function";

/**
 * Run `code` under the canary, **synchronously**. Returns a report; when runtime reaches a capability
 * outside `predicted` it hard-aborts (`aborted: true`, `divergence` set) — route that to review.
 *
 * A capability reached *after* an `await`, in a `.then`, or in a timer happens after this returns and
 * would be invisible here — so a run that leaves async work outstanding (or completes to a Promise)
 * is reported as a failure (`ok: false`, `pendingAsync > 0`). Use `runCanaryAsync` for such code.
 */
export function runCanary(code: string, options: CanaryOptions): CanaryReport {
	const run = startCanary(code, options);
	const report = finishReport(run);
	// Only *tracked guest work* counts (fibers, timers, promise reactions). A host promise as the
	// completion value (e.g. a bare `fetch(url)`) carries no pending guest code.
	if (report.pendingAsync > 0) {
		report.ok = false;
		report.error ??= new Error(`canary: ${report.pendingAsync} async task(s) outstanding — reaches after an await/timer would be lost; use runCanaryAsync`);
	}
	return report;
}

/**
 * Async-aware canary: awaits the program's completion (if it's a Promise), then drains every async
 * fiber and timer the guest started, so a reach that happens after an `await`, in a `.then`, or in a
 * timer callback is observed and can trip the tripwire. `maxDrainMs` bounds a never-cleared interval.
 */
export async function runCanaryAsync(code: string, options: CanaryOptions & { maxDrainMs?: number }): Promise<CanaryReport> {
	const run = startCanary(code, options);
	if (isThenable(run.report.completion)) {
		try {
			run.report.completion = await run.report.completion;
		} catch (error) {
			if (!(error instanceof CanaryDivergenceError)) run.report.error = error;
		}
	}
	await run.pending.drain(options.maxDrainMs ?? 2000);
	return finishReport(run);
}
