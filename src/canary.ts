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

import { UNCATCHABLE } from "./errors.ts";
import { createVM, createTypedVM } from "./interpret.ts";
import type { InterpretOptions } from "./interpret.ts";
import { typeOfNode } from "./program.ts";
import type { VM } from "./vm.ts";

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
	private readonly predicted: Set<string>;
	private readonly annotate: (event: CanaryEvent) => void;
	constructor(predicted: Set<string>, annotate: (event: CanaryEvent) => void) {
		this.predicted = predicted;
		this.annotate = annotate;
	}

	record(event: CanaryEvent): void {
		this.annotate(event);
		this.events.push(event);
		if (!covers(this.predicted, event.capability)) throw new CanaryDivergenceError(event);
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

/** Build the shimmed capability environment (globals + module resolver) bound to a recorder. */
function capabilityEnvironment(recorder: Recorder, options: CanaryOptions): { globals: Record<string, unknown>; resolveModule: (s: string) => unknown } {
	const stubResponse = () => ({ ok: true, status: 200, statusText: "OK", headers: {}, text: async () => "", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });

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

	const globals: Record<string, unknown> = {
		...safeGlobals(),
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
	return { globals, resolveModule };
}

/**
 * Run `code` under the canary. Returns a report; when runtime reaches a capability outside `predicted`
 * it hard-aborts (`aborted: true`, `divergence` set) — route that to review.
 */
export function runCanary(code: string, options: CanaryOptions): CanaryReport {
	const predicted = new Set(options.predicted);
	const useTypes = options.useTypes === true || (options.sensitiveTypes?.length ?? 0) > 0;
	const sensitive = new Set(options.sensitiveTypes ?? []);
	const context: { vm: VM | undefined } = { vm: undefined };

	// Annotate a reach with the static type of its resource argument, read from the live callsite.
	const annotate = (event: CanaryEvent): void => {
		const site = context.vm?.callSite;
		const checker = context.vm?.typeChecker;
		if (site === undefined || checker === undefined) return;
		const valueType = typeOfNode(checker, site.arguments[0]);
		if (valueType === undefined) return;
		event.valueType = valueType;
		if ([...sensitive].some((name) => valueType === name || valueType.includes(name))) event.sensitive = true;
	};

	const recorder = new Recorder(predicted, annotate);
	const { globals, resolveModule } = capabilityEnvironment(recorder, options);
	const vmOptions: InterpretOptions = { globals, resolveModule, realGlobals: false, fileName: options.fileName };
	const report: CanaryReport = { ok: true, aborted: false, predicted: [...predicted].sort(), observed: recorder.events, observedCaps: [], sensitiveFlows: [] };

	try {
		const vm = useTypes ? createTypedVM(code, vmOptions) : createVM(code, vmOptions);
		context.vm = vm;
		report.completion = vm.run();
	} catch (error) {
		if (error instanceof CanaryDivergenceError) {
			report.ok = false;
			report.aborted = true;
			report.divergence = error.event;
		} else {
			report.error = error; // a normal guest error that escaped — not a divergence
		}
	}

	report.observedCaps = [...new Set(recorder.events.map((e) => e.capability))].sort();
	report.sensitiveFlows = recorder.events.filter((e) => e.sensitive === true);
	return report;
}
