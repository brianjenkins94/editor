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

import ts from "typescript";
// tsval — the interpreter (dev-linked via tsconfig `paths` to ../tsval until it publishes as this package).
import type { HostGuard, InterpretOptions, VM } from "@brianjenkins94/tsval";
import { createVM, isUncatchable, UNCATCHABLE } from "@brianjenkins94/tsval";
import { createTypedVM, typeOfNode } from "@brianjenkins94/tsval/typed";

/** One capability the guest reached at runtime, shaped like silo's `Reach`. */
/** Every capability the canary can record — the permissive predicted set for callers that want the complete
 *  stream rather than the tripwire (the anchors, the journal). */
export const ALL_CAPABILITIES: readonly string[] = ["net", "fs", "fs:read", "fs:write", "exec", "env", "eval"];

export interface CanaryEvent {
	"capability": string;
	/** the concrete resource: URL / path / command / env key (the Axis-2 value). */
	"value": string;
	/** the rendered call/receiver, e.g. `fetch`, `fs.writeFile`, `process.env`. */
	"callee": string;
	/** read (net GET / fs:read / env read) vs mutation, where meaningful. */
	"safe"?: boolean;
	/** static type of the resource argument at the callsite (type-aware runs, ASSIGNMENT S6). */
	"valueType"?: string;
	/** the resource argument's type is assignable to (name-matches) a configured sensitive type. */
	"sensitive"?: boolean;
	/** which exploration path reached it (`exploreCanary`); 0 for a plain run. */
	"path"?: number;
	/** source span of the callsite, for anchoring the finding to a document node (call-based capabilities —
	 *  net/fs/exec/eval; env is a member read with no reliable callsite, so it stays unstamped). */
	"start"?: number;
	"end"?: number;
}

export interface CanaryReport {
	/** true iff runtime stayed within the predicted capability set. */
	"ok": boolean;
	/** true iff the run was hard-aborted by a divergence. */
	"aborted": boolean;
	/** the predicted capability set the run was checked against. */
	"predicted": string[];
	/** every capability reach observed, in order (up to an abort) — the Axis-2 resolver output. */
	"observed": CanaryEvent[];
	/** distinct capabilities observed. */
	"observedCaps": string[];
	/** the reach that tripped the tripwire, if any. */
	"divergence"?: CanaryEvent;
	/** completion value, when the run finished without diverging. */
	"completion"?: unknown;
	/** a non-divergence guest error that escaped the run, if any. */
	"error"?: unknown;
	/** reaches whose resource argument had a sensitive static type (type-directed, S6). */
	"sensitiveFlows": CanaryEvent[];
	/** async work (fibers / timers) still outstanding when the report was produced. Non-zero from the
	 *  synchronous `runCanary` is itself a failure (`ok: false`) — use `runCanaryAsync`. */
	"pendingAsync": number;
}

export interface CanaryOptions {
	/** Static predicted capabilities (silo `detect(code)`). Runtime must stay within this set. */
	"predicted": string[];
	/** "observe" (default): record + return benign stubs. "passthrough": also perform via `perform`. */
	"mode"?: "observe" | "passthrough";
	/** extra globals to expose beyond the sanitized baseline. */
	"globals"?: Record<string, unknown>;
	/** extra module namespaces by specifier (merged over the built-in shims). */
	"modules"?: Record<string, unknown>;
	/** build a `TypeChecker` and annotate each reach with its resource argument's static type. */
	"useTypes"?: boolean;
	/** type names to flag when a value of that type flows into a sink (implies `useTypes`). */
	"sensitiveTypes"?: string[];
	"fileName"?: string;
}

/** A divergence tripwire — thrown from a shim, uncatchable by guest `try/catch`, caught by `runCanary`. */
export class CanaryDivergenceError extends Error {
	public override name = "CanaryDivergenceError";
	public readonly [UNCATCHABLE] = true;
	public readonly event: CanaryEvent;
	public constructor(event: CanaryEvent) {
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

	if (set.has(capability)) {
		return true;
	}

	if (capability.startsWith("fs:") && set.has("fs")) {
		return true;
	}

	return false;
}

/** Collects reaches, annotates them (types), and trips the tripwire on any unpredicted capability. */
class Recorder {
	public readonly events: CanaryEvent[] = [];
	/** set the moment a divergence fires — wherever it fires (sync run, fiber, timer). */
	public divergence: CanaryEvent | undefined;
	/** the exploration path currently executing (0 for a plain run); stamped onto each event. */
	public currentPath = 0;
	/** first divergence per exploration path. */
	public readonly divergences = new Map<number, CanaryEvent>();
	private readonly predicted: Set<string>;
	private readonly annotate: (event: CanaryEvent) => void;
	public constructor(predicted: Set<string>, annotate: (event: CanaryEvent) => void) {
		this.predicted = predicted;
		this.annotate = annotate;
	}

	public record(event: CanaryEvent): void {
		this.annotate(event);
		event.path = this.currentPath;
		this.events.push(event);
		if (!covers(this.predicted, event.capability)) {
			this.divergence ??= event;
			if (!this.divergences.has(this.currentPath)) {
				this.divergences.set(this.currentPath, event);
			}

			throw new CanaryDivergenceError(event);
		}
	}
}

/** Outstanding async work started by the guest: async fibers and timer/microtask callbacks. */
class PendingWork {
	private readonly fibers = new Set<Promise<unknown>>();
	private timers = 0;
	private settleWaiters: (() => void)[] = [];

	public get count(): number {
		return this.fibers.size + this.timers;
	}

	public trackFiber(promise: Promise<unknown>): void {
		this.fibers.add(promise);
		// Observe settlement without turning a divergence into an unhandled rejection: it's already
		// recorded in the Recorder; the async runner reads it from there.
		promise.then(
			() => { this.done(promise); },
			() => { this.done(promise); }
		);
	}

	public timerStarted(): void {
		this.timers += 1;
	}

	public timerFinished(): void {
		this.timers -= 1;
		this.notify();
	}

	/** Resolve once no work is outstanding (or `maxMs` elapses — e.g. a never-cleared interval). */
	public async drain(maxMs: number): Promise<void> {
		const deadline = Date.now() + maxMs;

		while (this.count > 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				this.settleWaiters.push(resolve);
				setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now())));
			});
		}
	}

	private done(promise: Promise<unknown>): void {
		this.fibers.delete(promise);
		this.notify();
	}

	private notify(): void {
		const waiters = this.settleWaiters;

		this.settleWaiters = [];
		for (const waiter of waiters) {
			waiter();
		}
	}
}

// Real globals considered safe (no capability): pure intrinsics, formatting, timing, console.
const SAFE_GLOBAL_NAMES = [
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"BigInt",
	"Symbol",
	"Math",
	"JSON",
	"Date",
	"RegExp",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"Promise",
	"Proxy",
	"Reflect",
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"ReferenceError",
	"EvalError",
	"URIError",
	"AggregateError",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"encodeURIComponent",
	"decodeURIComponent",
	"encodeURI",
	"decodeURI",
	"console",
	"structuredClone",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"Uint8Array",
	"Int8Array",
	"Uint8ClampedArray",
	"Uint16Array",
	"Int16Array",
	"Uint32Array",
	"Int32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"DataView",
	"Intl",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"atob",
	"btoa",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"queueMicrotask",
	"NaN",
	"Infinity",
	"undefined"
];

/** A sanitized global environment: safe intrinsics only, no capability surfaces. */
export function safeGlobals(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const source = globalThis as Record<string, unknown>;

	for (const name of SAFE_GLOBAL_NAMES) {
		if (name in source) {
			out[name] = source[name];
		}
	}

	return out;
}

function httpVerbSafe(method: string | undefined): boolean {
	const verb = (method ?? "GET").toUpperCase();

	return verb === "GET" || verb === "HEAD" || verb === "OPTIONS";
}

/** `String(value)` for a recorded resource argument of statically-unknown shape (a URL, a path, a command, a
 *  Buffer, …). The cast only tells the type-checker the value stringifies to a string — which every resource we
 *  record does — so at runtime this is exactly `String(value)` and the recorded diagnostic value is unchanged. */
function asResourceString(value: unknown): string {
	// Bind through an assertion so the checker knows the value stringifies to a string — true of every resource we
	// record — then `String` produces exactly `String(value)` at runtime, unchanged.
	const stringable = value as { "toString": () => string };

	return String(stringable);
}

// The real code-from-string constructors. Every real intrinsic leaks them (`[].constructor.constructor`
// is `Function`), so the sanitized environment must catch them at the host boundary, not by name.
// eslint-disable-next-line no-eval -- capturing the real eval by reference to gate code-from-string at the host boundary, not to call it
const REAL_EVAL = globalThis.eval;
const CODE_CONSTRUCTORS = new Set<unknown>([
	Function,
	Object.getPrototypeOf(async function() { /* probe: only its constructor (AsyncFunction) is read */ }).constructor,
	Object.getPrototypeOf(function *() { /* probe: only its constructor (GeneratorFunction) is read */ }).constructor,
	Object.getPrototypeOf(async function *() { /* probe: only its constructor (AsyncGeneratorFunction) is read */ }).constructor
]);
const { "call": FN_CALL, "apply": FN_APPLY, "bind": FN_BIND } = Function.prototype;
const { "then": PROMISE_THEN, "catch": PROMISE_CATCH, "finally": PROMISE_FINALLY } = Promise.prototype;

interface Environment {
	"globals": Record<string, unknown>;
	"resolveModule": (s: string) => unknown;
	"hostGuard": HostGuard;
	"pending": PendingWork;
}

/** Build the shimmed capability environment (globals + module resolver + host guard) bound to a recorder. */
function capabilityEnvironment(recorder: Recorder, options: CanaryOptions): Environment {
	const stubResponse = () => ({ "ok": true, "status": 200, "statusText": "OK", "headers": {}, "text": () => Promise.resolve(""), "json": () => Promise.resolve({}), "arrayBuffer": () => Promise.resolve(new ArrayBuffer(0)) });
	const pending = new PendingWork();

	// --- net ---
	const fetchShim = (input: unknown, init?: { "method"?: string }) => {
		recorder.record({ "capability": "net", "value": typeof input === "string" ? input : asResourceString((input as { "url"?: string })?.url ?? input), "callee": "fetch", "safe": httpVerbSafe(init?.method) });

		return Promise.resolve(stubResponse());
	};

	class WebSocketShim {
		public constructor(url: unknown) {
			recorder.record({ "capability": "net", "value": asResourceString(url), "callee": "WebSocket", "safe": false });
		}
	}
	const httpGet = (name: string) => (url: unknown) => {
		recorder.record({ "capability": "net", "value": typeof url === "string" ? url : asResourceString((url as { "href"?: string })?.href ?? url), "callee": name, "safe": name.endsWith("get") });

		return { "on": () => undefined, "end": () => undefined, "write": () => undefined };
	};

	const netModule = (prefix: string) => ({ "get": httpGet(`${prefix}.get`), "request": httpGet(`${prefix}.request`) });

	// --- fs ---
	const fsCall = (name: string, capability: string) => (path: unknown, ...rest: unknown[]) => {
		recorder.record({ "capability": capability, "value": asResourceString(path), "callee": `fs.${name}`, "safe": capability === "fs:read" });
		const cb = rest[rest.length - 1];

		if (typeof cb === "function") {
			(cb as (e: unknown, d: unknown) => void)(null, capability === "fs:read" ? "" : undefined);

			return;
		}

		return capability === "fs:read" ? "" : undefined;
	};

	const buildFs = (promises: boolean) => {
		const mod: Record<string, unknown> = {};
		const wrap = (name: string, capability: string) => {
			const fn = fsCall(name, capability);

			mod[name] = promises && !name.endsWith("Sync") ? (...args: unknown[]) => Promise.resolve((fn as (...callArgs: unknown[]) => unknown)(...args)) : fn;
		};

		for (const name of FS_READ) {
			wrap(name, "fs:read");
		}

		for (const name of FS_WRITE) {
			wrap(name, "fs:write");
		}

		return mod;
	};

	const fsModule = buildFs(false);

	(fsModule as { "promises"?: unknown }).promises = buildFs(true);
	(fsModule as { "default"?: unknown }).default = fsModule;

	// --- exec ---
	const execCall = (name: string) => (command: unknown) => {
		recorder.record({ "capability": "exec", "value": asResourceString(command), "callee": name, "safe": false });

		return { "on": () => undefined, "stdout": { "on": () => undefined }, "stderr": { "on": () => undefined }, "kill": () => undefined, "status": 0, "stdout_": "" };
	};

	const childProcess: Record<string, unknown> = {};

	for (const name of EXEC) {
		childProcess[name] = execCall(name);
	}

	(childProcess as { "default"?: unknown }).default = childProcess;

	// --- env ---
	const envProxy = new Proxy(
		{},
		{
			"get": (_t, key) => {
				if (typeof key === "string") {
					recorder.record({ "capability": "env", "value": key, "callee": "process.env", "safe": true });
				}

				return "";
			},
			"has": () => true
		}
	);
	const processShim = { "env": envProxy, "platform": "linux", "argv": [], "cwd": () => "/", "version": "v0.0.0" };

	// --- eval ---
	const evalShim = (code: unknown) => {
		recorder.record({ "capability": "eval", "value": typeof code === "string" ? code : "<non-string>", "callee": "eval", "safe": false });

		return undefined;
	};

	function FunctionShim(...args: unknown[]) {
		recorder.record({ "capability": "eval", "value": asResourceString(args[args.length - 1] ?? ""), "callee": "Function", "safe": false });

		return () => undefined;
	}

	const isCodeConstructor = (value: unknown): boolean => CODE_CONSTRUCTORS.has(value) || value === REAL_EVAL;
	const shimFor = (value: unknown): unknown => (value === REAL_EVAL ? evalShim : FunctionShim);

	// Promise reactions run from host land as microtasks. Wrap the callbacks so (a) a divergence inside
	// one is swallowed — it's already recorded, and letting it reject the derived promise would only
	// surface as an unhandled rejection — and (b) the reaction counts as pending work until the source
	// promise settles, so `runCanaryAsync` waits for it.
	const wrapReaction = (method: (...args: unknown[]) => unknown) => function(this: Promise<unknown>, ...callbacks: unknown[]): unknown {
		let open = true;

		pending.timerStarted();
		const finish = (): void => {
			if (!open) {
				return;
			}

			open = false;
			pending.timerFinished();
		};

		// settle-based, whichever reaction path runs; the no-op catch handles the never-rejecting derived promise
		PROMISE_THEN.call(this, finish, finish).catch(() => undefined);
		const wrapped = callbacks.map((cb) => (typeof cb !== "function"
			? cb
			: (...args: unknown[]) => {
					try {
						return (cb as (...callArgs: unknown[]) => unknown)(...args);
					} catch (error) {
						if (error instanceof CanaryDivergenceError) {
							return undefined;
						}

						throw error;
					}
				}));

		return method.apply(this, wrapped);
	};

	const guardedReactions = new Map<unknown, (...args: unknown[]) => unknown>([
		[PROMISE_THEN, wrapReaction(PROMISE_THEN as (...args: unknown[]) => unknown)],
		[PROMISE_CATCH, wrapReaction(PROMISE_CATCH as (...args: unknown[]) => unknown)],
		[PROMISE_FINALLY, wrapReaction(PROMISE_FINALLY as (...args: unknown[]) => unknown)]
	]);

	// --- the host guard: keeps the sandbox closed at the interpreter's host boundary ---
	const hostGuard: HostGuard = {
		// Any read/return that yields a real code-from-string constructor becomes the shim.
		"sanitize": (value) => (isCodeConstructor(value) ? shimFor(value) : value),
		// Vet callables at invocation, including `Function.prototype.call/apply/bind` aimed at one.
		"beforeCall": (callee, thisArg) => {
			if (isCodeConstructor(callee)) {
				return shimFor(callee) as (...args: unknown[]) => unknown;
			}

			if ((callee === FN_CALL || callee === FN_APPLY || callee === FN_BIND) && isCodeConstructor(thisArg)) {
				const shim = shimFor(thisArg) as (...args: unknown[]) => unknown;

				if (callee === FN_BIND) {
					return () => shim;
				}

				return (...args: unknown[]) => (callee === FN_APPLY ? shim(...((args[1] as unknown[]) ?? [])) : shim(...args.slice(1)));
			}

			return guardedReactions.get(callee) ?? callee;
		}
	};

	// `Reflect.apply/construct` invoke from host land, bypassing the interpreter's call boundary: wrap.
	// (Reflect's methods are non-enumerable, so copy by name rather than spread.)
	const guardedReflect = Object.fromEntries(Object.getOwnPropertyNames(Reflect).map((name) => [name, (Reflect as unknown as Record<string, unknown>)[name]])) as Record<string, unknown>;

	guardedReflect.apply = (target: unknown, thisArg: unknown, args: ArrayLike<unknown>) => Reflect.apply(hostGuard.beforeCall(target as (...callArgs: unknown[]) => unknown, thisArg, false), thisArg, Array.from(args));
	guardedReflect.construct = (target: unknown, args: ArrayLike<unknown>, newTarget?: unknown) => {
		const vetted = hostGuard.beforeCall(target as (...callArgs: unknown[]) => unknown, undefined, true) as unknown as new (...callArgs: unknown[]) => unknown;

		return Reflect.construct(vetted, Array.from(args), (newTarget ?? vetted) as new (...callArgs: unknown[]) => unknown);
	};

	// Timers: a string callback is `eval`; a function callback is tracked as pending async work, and a
	// divergence inside it is recorded (already in the Recorder) rather than escaping as uncaught.
	const runLater = (cb: unknown, args: unknown[], name: string): (() => void) | undefined => {
		if (typeof cb !== "function") {
			recorder.record({ "capability": "eval", "value": asResourceString(cb), "callee": name, "safe": false });

			return undefined;
		}

		pending.timerStarted();

		return () => {
			try {
				(cb as (...callArgs: unknown[]) => unknown)(...args);
			} catch (error) {
				if (!isUncatchable(error)) {
					throw error;
				}

				if (!(error instanceof CanaryDivergenceError)) {
					throw error; // an interpreter bug stays loud
				}
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
		if (typeof cb !== "function") {
			runLater(cb, args, "setInterval");

			return undefined;
		}

		pending.timerStarted();

		return setInterval(() => {
			try {
				(cb as (...callArgs: unknown[]) => unknown)(...args);
			} catch (error) {
				if (!(error instanceof CanaryDivergenceError)) {
					throw error;
				}
			}
		}, ms);
	};

	const clearIntervalShim = (id: ReturnType<typeof setInterval>) => {
		clearInterval(id);
		pending.timerFinished();
	};

	const queueMicrotaskShim = (cb: unknown) => {
		const task = runLater(cb, [], "queueMicrotask");

		if (task !== undefined) {
			queueMicrotask(task);
		}
	};

	const globals: Record<string, unknown> = {
		...safeGlobals(),
		"Reflect": guardedReflect,
		"setTimeout": setTimeoutShim,
		"setInterval": setIntervalShim,
		"clearInterval": clearIntervalShim,
		"queueMicrotask": queueMicrotaskShim,
		"fetch": fetchShim,
		"WebSocket": WebSocketShim,
		"process": processShim,
		"eval": evalShim,
		"Function": FunctionShim,
		...(options.globals ?? {})
	};

	// Self-reference so reflection-based access — `globalThis["fe"+"tch"]`, `self.fetch` — routes through
	// the shims and is *caught* as divergence rather than silently denied (ASSIGNMENT §1 example).
	globals.globalThis = globals;
	globals.self = globals;

	const builtinModules: Record<string, unknown> = {
		"fs": fsModule,
		"node:fs": fsModule,
		"fs/promises": fsModule.promises,
		"node:fs/promises": fsModule.promises,
		"child_process": childProcess,
		"node:child_process": childProcess,
		"http": netModule("http"),
		"node:http": netModule("http"),
		"https": netModule("https"),
		"node:https": netModule("https"),
		"net": netModule("net"),
		"node:net": netModule("net"),
		"process": processShim,
		"node:process": processShim,
		...(options.modules ?? {})
	};

	// `require` is a plain host global returning a module namespace.
	globals.require = (spec: string) => builtinModules[spec];

	const resolveModule = (spec: string): unknown => builtinModules[spec] ?? options.modules?.[spec];

	return { "globals": globals, "resolveModule": resolveModule, "hostGuard": hostGuard, "pending": pending };
}

interface CanaryRun {
	"recorder": Recorder;
	"pending": PendingWork;
	"report": CanaryReport;
}

interface PreparedCanary extends CanaryRun {
	"vm": VM;
	/** point the type-annotation context at the VM currently executing (forks, during exploration). */
	"setCurrentVM": (vm: VM) => void;
}

/** Build the environment and a VM seated on `code`, without running it. */
function prepareCanary(code: string, options: CanaryOptions): PreparedCanary {
	const predicted = new Set(options.predicted);
	const useTypes = options.useTypes === true || (options.sensitiveTypes?.length ?? 0) > 0;
	const sensitive = new Set(options.sensitiveTypes ?? []);
	const context: { "vm": VM | undefined; "checker": ts.TypeChecker | undefined } = { "vm": undefined, "checker": undefined };

	// Annotate a reach with the static type of its resource argument, read from the live callsite (the
	// checker comes from tsval's opt-in typed layer; the VM itself carries none).
	const annotate = (event: CanaryEvent): void => {
		const site = context.vm?.callSite;

		if (site !== undefined && event.capability !== "env") {
			try {
				event.start = site.getStart(site.getSourceFile());
				event.end = site.getEnd();
			} catch {
				// a synthesized/unattached node has no source position — leave the event positionless
			}
		}

		const { checker } = context;

		if (site === undefined || checker === undefined) {
			return;
		}

		const valueType = typeOfNode(checker, site.arguments?.[0]);

		if (valueType === undefined) {
			return;
		}

		event.valueType = valueType;
		if ([...sensitive].some((name) => valueType === name || valueType.includes(name))) {
			event.sensitive = true;
		}
	};

	const recorder = new Recorder(predicted, annotate);
	const { globals, resolveModule, hostGuard, pending } = capabilityEnvironment(recorder, options);
	const vmOptions: InterpretOptions = { "globals": globals, "resolveModule": resolveModule, "hostGuard": hostGuard, "realGlobals": false, "fileName": options.fileName, "onAsyncFiber": pending.trackFiber.bind(pending) };
	const report: CanaryReport = { "ok": true, "aborted": false, "predicted": [...predicted].sort(), "observed": recorder.events, "observedCaps": [], "sensitiveFlows": [], "pendingAsync": 0 };
	const typed = useTypes ? createTypedVM(code, vmOptions) : undefined;
	const vm = typed?.vm ?? createVM(code, vmOptions).vm;

	context.vm = vm;
	context.checker = typed?.checker;

	const setCurrentVM = (value: VM): void => {
		context.vm = value;
	};

	return { "vm": vm, "recorder": recorder, "pending": pending, "report": report, "setCurrentVM": setCurrentVM };
}

/** Shared by the sync and async runners: build the environment, run the synchronous part. */
function startCanary(code: string, options: CanaryOptions): CanaryRun {
	const prepared = prepareCanary(code, options);

	try {
		prepared.report.completion = prepared.vm.run();
	} catch (error) {
		if (!(error instanceof CanaryDivergenceError)) {
			prepared.report.error = error; // a normal guest error, or an interpreter bug
		}
	}

	return prepared;
}

function finishReport({ recorder, pending, report }: CanaryRun): CanaryReport {
	if (recorder.divergence !== undefined) {
		report.ok = false;
		report.aborted = true;
		report.divergence = recorder.divergence;
	}

	report.pendingAsync = pending.count;
	report.observedCaps = [...new Set(recorder.events.map((event) => event.capability))].sort();
	report.sensitiveFlows = recorder.events.filter((event) => event.sensitive === true);

	return report;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as { "then"?: unknown })?.then === "function";

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

// ---------------------------------------------------------------------------------------------------
// Multi-path exploration (ASSIGNMENT §3 "Fork beats the canary's one-run-one-path limit")
// ---------------------------------------------------------------------------------------------------

/** One decision an explored path took at a branch point. */
export interface PathDecision {
	/** 0-based source line of the `if` / `?:`. */
	"line": number;
	"pos": number;
	/** the branch's real condition value on this path (before any forcing). */
	"observed": boolean;
	/** true if this path was forked here and forced down the *other* branch. */
	"forced": boolean;
}

export interface PathReport {
	"id": number;
	/** the path this one was forked from, and the branch point where — root has neither. */
	"parent"?: number;
	"decisions": PathDecision[];
	"aborted": boolean;
	"divergence"?: CanaryEvent;
	"completion"?: unknown;
	"error"?: unknown;
	"steps": number;
}

export interface ExplorationReport {
	/** true iff no explored path diverged. */
	"ok": boolean;
	"predicted": string[];
	"paths": PathReport[];
	/** every reach across all paths, each stamped with its `path`. */
	"observed": CanaryEvent[];
	"observedCaps": string[];
	/** true if the path budget (`maxPaths`) cut exploration short. */
	"truncated": boolean;
}

export interface ExploreOptions extends CanaryOptions {
	/** how many paths to explore at most (each branch point forks one more). Default 16. */
	"maxPaths"?: number;
	/** per-path step budget, so a forced branch that loops forever can't hang the explorer. */
	"maxStepsPerPath"?: number;
}

/** `if` / `?:` — the branch points exploration forks at (loop conditions are deliberately not). */
const isConditionalNode = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.IfStatement || node.kind === ts.SyntaxKind.ConditionalExpression;

/**
 * Explore more than one path through `code`: run it stepwise and, at every `if` / `?:` whose
 * condition has just been evaluated, **fork** the machine and force the fork down the other branch.
 * Each path runs to completion (or abort) under the same shims; reaches are stamped with their path.
 * This finds a capability that a single run's data never steers into — e.g. a `fetch` behind
 * `if (mode === "danger")` — without needing to guess the input that would.
 *
 * Synchronous paths only (async work started on a path is not drained here); loop conditions are not
 * forced (forcing them is how you manufacture infinite loops), only `if` and `?:`.
 */
export function exploreCanary(code: string, options: ExploreOptions): ExplorationReport {
	const maxPaths = options.maxPaths ?? 16;
	const maxSteps = options.maxStepsPerPath ?? 200_000;
	const prepared = prepareCanary(code, options);
	const { recorder } = prepared;

	interface Path {
		"id": number;
		"vm": VM;
		"parent"?: number;
		"decisions": PathDecision[];
		/** a fork starts *at* the branch point it was created from; it must not fork there again. */
		"bornAtBranch": boolean;
	}
	const queue: Path[] = [{ "id": 0, "vm": prepared.vm, "decisions": [], "bornAtBranch": false }];
	const reports: PathReport[] = [];
	let nextId = 1;
	let truncated = false;

	while (queue.length > 0) {
		const path = queue.shift();
		const { vm } = path;

		prepared.setCurrentVM(vm);
		recorder.currentPath = path.id;
		const report: PathReport = { "id": path.id, "parent": path.parent, "decisions": path.decisions, "aborted": false, "steps": 0 };
		const startSteps = vm.steps;

		try {
			while (!vm.finished) {
				if (vm.steps - startSteps > maxSteps) {
					throw new Error(`exploration: path ${path.id} exceeded ${maxSteps} steps`);
				}

				const { top } = vm;

				if (top !== undefined && top.kind === undefined && top.node !== null && top.phase === 1 && isConditionalNode(top.node)) {
					if (path.bornAtBranch) {
						path.bornAtBranch = false; // this is the branch we were forked at; its decision is already recorded
					} else {
						// The condition value sits on top of the operand stack, about to be consumed.
						const observed = Boolean(vm.values[vm.values.length - 1]);
						const loc = vm.location(top.node);
						const decision: PathDecision = { "line": loc?.line ?? -1, "pos": loc?.pos ?? top.node.pos, "observed": observed, "forced": false };

						path.decisions.push(decision);
						if (nextId < maxPaths) {
							const fork = vm.fork();

							fork.values[fork.values.length - 1] = !observed; // steer the fork down the other branch
							const forkId = nextId;

							nextId += 1;
							queue.push({ "id": forkId, "vm": fork, "parent": path.id, "decisions": [...path.decisions.slice(0, -1), { ...decision, "forced": true }], "bornAtBranch": true });
						} else {
							truncated = true;
						}
					}
				}

				vm.step();
				if (vm.paused) {
					throw new Error("exploration: top-level await is not supported (synchronous paths only)");
				}
			}

			report.completion = vm.completion;
		} catch (error) {
			if (error instanceof CanaryDivergenceError) {
				report.aborted = true;
			} else {
				report.error = error;
			}
		}

		report.divergence = recorder.divergences.get(path.id);
		if (report.divergence !== undefined) {
			report.aborted = true;
		}

		report.steps = vm.steps - startSteps;
		reports.push(report);
	}

	return {
		"ok": recorder.divergences.size === 0,
		"predicted": [...new Set(options.predicted)].sort(),
		"paths": reports,
		"observed": recorder.events,
		"observedCaps": [...new Set(recorder.events.map((event) => event.capability))].sort(),
		"truncated": truncated
	};
}

/**
 * Async-aware canary: awaits the program's completion (if it's a Promise), then drains every async
 * fiber and timer the guest started, so a reach that happens after an `await`, in a `.then`, or in a
 * timer callback is observed and can trip the tripwire. `maxDrainMs` bounds a never-cleared interval.
 */
export async function runCanaryAsync(code: string, options: CanaryOptions & { "maxDrainMs"?: number }): Promise<CanaryReport> {
	const run = prepareCanary(code, options);

	try {
		run.report.completion = await run.vm.runAsync(); // drives top-level await
		if (isThenable(run.report.completion)) {
			run.report.completion = await run.report.completion;
		}
	} catch (error) {
		if (!(error instanceof CanaryDivergenceError)) {
			run.report.error = error;
		}
	}

	await run.pending.drain(options.maxDrainMs ?? 2000);

	return finishReport(run);
}
