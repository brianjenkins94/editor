/**
 * gatedEvalRealm — evaluate untrusted code in a locked-down realm and get back only DATA.
 *
 * The code runs in a fresh Web Worker whose network/IO globals (fetch, XMLHttpRequest, WebSocket, EventSource,
 * importScripts, Worker, SharedWorker, navigator.sendBeacon) are redefined non-configurable to throwing stubs
 * BEFORE the code runs — so it has no capability to reach the network or spawn helpers, and no MessagePort to
 * anywhere except this parent. It can only `postMessage` the extracted result back. Capability attempts are
 * recorded and returned (the "learn what it needs" signal). This is the airtight tier of the capability plane's
 * ENFORCE stage for "code we evaluate"; a shadow-in-realm tier can be added behind the same call.
 *
 * Reusable: any caller that needs to run untrusted code and only wants serialized output (config files, codegen
 * manifests, plugin metadata, …) can use this. `imports` maps bare specifiers the code `require`s to plain data;
 * anything unlisted resolves to an inert stub so evaluation survives without granting anything. `services` are the
 * one way out a caller grants: the code calls `host(name, ...args)` and gets a promise of what the service answered,
 * across this parent's port — so what it reached is what those services saw (script-run.ts's workspace reads). An
 * exported promise is awaited, and what the code logs on its `console` is kept.
 */
import { watchWorker } from "./failures.ts";

export interface GatedEvalResult {
	/** The value the code exported (default export, else module.exports), structured-clonable only. */
	"value"?: unknown;
	/** Present when evaluation threw or timed out. */
	"error"?: string;
	/** Capability scopes the code attempted (e.g. "net:*") — denied, but recorded so callers can learn. */
	"attempts": string[];
	/** What it logged on its `console`, a line each call. */
	"logs"?: string[];
}

/** The ways out a caller grants, by name: `host(name, ...args)` in the realm. */
export type GatedServices = Record<string, (...args: unknown[]) => Promise<unknown>>;

// The realm's own source. Kept as a string so it needs no separate bundle/served file: it runs from a blob URL,
// same-origin, inheriting this context's cross-origin isolation. No imports — pure globals — so it loads anywhere.
const REALM_SOURCE = String.raw`
const attempts = [];
function deny(scope) { return function denied() { attempts.push(scope); throw new Error("sandbox: capability '" + scope + "' is not available"); }; }
const locked = { fetch: "net:*", XMLHttpRequest: "net:*", WebSocket: "net:*", EventSource: "net:*", importScripts: "eval:importScripts", Worker: "eval:worker", SharedWorker: "eval:worker" };
for (const targetObject of [self, Object.getPrototypeOf(self), globalThis]) {
	for (const name in locked) {
		try { Object.defineProperty(targetObject, name, { configurable: false, writable: false, value: deny(locked[name]) }); } catch (error) {}
	}
}
try { if (self.navigator) Object.defineProperty(self.navigator, "sendBeacon", { configurable: false, value: deny("net:beacon") }); } catch (error) {}

const stub = new Proxy(function stubbed() { return Array.prototype.slice.call(arguments).flat(Infinity).filter(function(arg) { return arg !== null && typeof arg === "object"; }); }, { get: function() { return stub; }, apply: function(target, thisArg, args) { return target.apply(thisArg, args); } });

function clone(value, seen) {
	seen = seen || new WeakSet();
	const kind = typeof value;
	if (value === null || (kind !== "object" && kind !== "function")) { return (kind === "symbol" || kind === "bigint" || kind === "function") ? undefined : value; }
	if (kind === "function" || seen.has(value)) { return undefined; }
	seen.add(value);
	if (Array.isArray(value)) { return value.map(function(item) { return clone(item, seen); }); }
	const out = {};
	for (const key in value) { try { const cloned = clone(value[key], seen); if (cloned !== undefined) out[key] = cloned; } catch (error) {} }
	return out;
}

const calls = new Map();
let callSequence = 0;

function shown(value) { if (typeof value === "string") { return value; } try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; } catch (error) { return String(value); } }

self.onmessage = function(event) {
	if (event.data.answer !== undefined) {
		const call = calls.get(event.data.answer);
		calls.delete(event.data.answer);
		if (call !== undefined) { if (event.data.error !== undefined) { call.reject(new Error(event.data.error)); } else { call.resolve(event.data.value); } }
		return;
	}

	const id = event.data.id;
	const code = event.data.code;
	const imports = event.data.imports || {};
	const logs = [];
	const from = attempts.length;
	const logged = function() { logs.push(Array.prototype.map.call(arguments, shown).join(" ")); };
	const scriptConsole = { log: logged, info: logged, warn: logged, error: logged, debug: logged };

	function require(specifier) { return Object.prototype.hasOwnProperty.call(imports, specifier) ? imports[specifier] : stub; }
	function host(name) { const args = Array.prototype.slice.call(arguments, 1); callSequence += 1; const call = callSequence; return new Promise(function(resolve, reject) { calls.set(call, { resolve: resolve, reject: reject }); self.postMessage({ id: id, call: call, name: name, args: args }); }); }
	function ended(result) { result.id = id; result.attempts = attempts.slice(from); result.logs = logs; self.postMessage(result); }

	try {
		const moduleObject = { exports: {} };
		new Function("require", "module", "exports", "host", "console", code)(require, moduleObject, moduleObject.exports, host, scriptConsole);
		const exported = moduleObject.exports.default !== undefined ? moduleObject.exports.default : moduleObject.exports;
		Promise.resolve(typeof exported === "function" ? exported() : exported).then(function(value) { ended({ value: clone(value) }); }, function(error) { ended({ error: String((error && error.message) || error) }); });
	} catch (error) {
		ended({ error: String((error && error.message) || error) });
	}
};
`;

interface Pending { "resolve": (result: GatedEvalResult) => void; "timer": ReturnType<typeof setTimeout>; "services": GatedServices }

let worker: Worker | undefined;
let blobUrl: string | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
	if (worker !== undefined) {
		return worker;
	}

	blobUrl = URL.createObjectURL(new Blob([REALM_SOURCE], { "type": "text/javascript" }));
	worker = new Worker(blobUrl);
	watchWorker(worker, "gated-eval");
	worker.onmessage = (event: MessageEvent) => {
		const data = event.data as { "id": number; "call"?: number; "name"?: string; "args"?: unknown[]; "value"?: unknown; "error"?: string; "attempts"?: string[]; "logs"?: string[] };
		const entry = pending.get(data.id);

		if (entry === undefined) {
			return;
		}

		// (a call to one of the services this eval was granted, answered on the same port)
		if (data.call !== undefined) {
			const service = Object.hasOwn(entry.services, data.name ?? "") ? entry.services[data.name ?? ""] : undefined;
			const answered = service === undefined ? Promise.reject(new Error(`sandbox: no service '${String(data.name)}'`)) : service(...data.args ?? []);
			const from = worker;

			answered.then((value) => {
				from?.postMessage({ "answer": data.call, "value": value });
			}, (error: unknown) => {
				from?.postMessage({ "answer": data.call, "error": error instanceof Error ? error.message : String(error) });
			});

			return;
		}

		clearTimeout(entry.timer);
		pending.delete(data.id);
		entry.resolve({ "value": data.value, "error": data.error, "attempts": data.attempts ?? [], "logs": data.logs ?? [] });
	};

	return worker;
}

function killWorker(): void {
	if (worker !== undefined) {
		worker.terminate();
		worker = undefined;
	}

	if (blobUrl !== undefined) {
		URL.revokeObjectURL(blobUrl);
		blobUrl = undefined;
	}
}

/**
 * Evaluate `code` (CommonJS) in the locked realm. `imports` provides data for specifiers the code `require`s;
 * everything else resolves to an inert stub; `services` answer its `host(name, ...args)`. Resolves with the code's
 * exported value (awaited, structured-clonable only), or an `error`, plus the capability `attempts` it made and what it
 * logged. A hung or runaway eval is killed after `timeoutMs`. Evals running at once share the realm, so an attempt goes
 * to each eval running when it was made: a caller that needs them apart runs one at a time.
 */
export function gatedEvalRealm(code: string, imports: Record<string, unknown> = {}, timeoutMs = 2000, services: GatedServices = {}): Promise<GatedEvalResult> {
	const active = ensureWorker();

	sequence += 1;
	const id = sequence;

	return new Promise<GatedEvalResult>((resolve) => {
		const timer = setTimeout(() => {
			if (pending.delete(id)) {
				killWorker(); // a runaway eval can't be interrupted in-worker; drop the whole realm
				resolve({ "error": "timed out", "attempts": [] });
			}
		}, timeoutMs);

		pending.set(id, { "resolve": resolve, "timer": timer, "services": services });
		active.postMessage({ "id": id, "code": code, "imports": imports });
	});
}
