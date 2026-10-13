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
 * anything unlisted resolves to an inert stub so evaluation survives without granting anything.
 */

export interface GatedEvalResult {
	/** The value the code exported (default export, else module.exports), structured-clonable only. */
	"value"?: unknown;
	/** Present when evaluation threw or timed out. */
	"error"?: string;
	/** Capability scopes the code attempted (e.g. "net:*") — denied, but recorded so callers can learn. */
	"attempts": string[];
}

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

self.onmessage = function(event) {
	const id = event.data.id;
	const code = event.data.code;
	const imports = event.data.imports || {};
	attempts.length = 0;

	function require(specifier) { return Object.prototype.hasOwnProperty.call(imports, specifier) ? imports[specifier] : stub; }

	try {
		const moduleObject = { exports: {} };
		new Function("require", "module", "exports", code)(require, moduleObject, moduleObject.exports);
		const exported = moduleObject.exports.default !== undefined ? moduleObject.exports.default : moduleObject.exports;
		const value = typeof exported === "function" ? exported() : exported;
		self.postMessage({ id: id, value: clone(value), attempts: attempts.slice() });
	} catch (error) {
		self.postMessage({ id: id, error: String((error && error.message) || error), attempts: attempts.slice() });
	}
};
`;

interface Pending { "resolve": (result: GatedEvalResult) => void; "timer": ReturnType<typeof setTimeout> }

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
	worker.onmessage = (event: MessageEvent) => {
		const data = event.data as { "id": number; "value"?: unknown; "error"?: string; "attempts"?: string[] };
		const entry = pending.get(data.id);
		if (entry === undefined) {
			return;
		}

		clearTimeout(entry.timer);
		pending.delete(data.id);
		entry.resolve({ "value": data.value, "error": data.error, "attempts": data.attempts ?? [] });
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
 * everything else resolves to an inert stub. Resolves with the code's exported value (structured-clonable only),
 * or an `error`, plus the capability `attempts` it made. A hung or runaway eval is killed after `timeoutMs`.
 */
export function gatedEvalRealm(code: string, imports: Record<string, unknown> = {}, timeoutMs = 2000): Promise<GatedEvalResult> {
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

		pending.set(id, { "resolve": resolve, "timer": timer });
		active.postMessage({ "id": id, "code": code, "imports": imports });
	});
}
