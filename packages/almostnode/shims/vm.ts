/* eslint-disable no-eval, no-new-func, ts/no-implied-eval, ts/class-literal-property-style, ts/no-unsafe-function-type -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
/**
 * vm shim. A browser can't make a realm of its own here, so a context is its object over the host's realm: the code's
 * `globalThis` (and `global`, `self`, its top-level `this`) is the context's global — the context object, with the
 * language's built-ins on it as a new context of Node's has them (`globalThis.Array`, which code copying its
 * intrinsics off the global reads), the host's — and its free names are the context's: what the context has, and any
 * name the host's global hasn't, read and assigned there. Two of Node's left out: reading a name neither has is
 * `undefined` rather than a ReferenceError, and a top-level `var` stays the code's rather than becoming the context's
 * property.
 */

/** The names that are the global itself: in a context, the context. */
const ITSELF = new Set<PropertyKey>(["globalThis", "global", "self", "window"]);

/** What a new context of Node's has on its global: the language's built-ins (and V8's console). */
const BUILT_INS = new Set<PropertyKey>(["Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined", "Boolean", "String", "Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "JSON", "Math", "Intl", "ArrayBuffer", "Atomics", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "BigUint64Array", "BigInt64Array", "Uint8ClampedArray", "Float32Array", "Float64Array", "DataView", "Map", "BigInt", "Set", "Iterator", "WeakMap", "WeakSet", "Proxy", "Reflect", "FinalizationRegistry", "WeakRef", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN", "console", "SuppressedError", "DisposableStack", "AsyncDisposableStack", "Float16Array", "SharedArrayBuffer", "WebAssembly"]);

/** A built-in `key` the context hasn't, as the host has it: what the context's global reads there. */
const builtIn = (context: Record<PropertyKey, unknown>, key: PropertyKey): boolean => !(key in context) && BUILT_INS.has(key) && key in globalThis;

/** The context's global: `context`, and the built-ins it hasn't (BUILT_INS); what's set, defined or deleted is
 *  the context's. */
function globalOf(context: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> {
	const global: Record<PropertyKey, unknown> = new Proxy(context, {
		"get": (_target, key) => (builtIn(context, key) ? Reflect.get(globalThis, key) : !(key in context) && ITSELF.has(key) ? global : context[key]),
		"has": (_target, key) => key in context || builtIn(context, key),
		"getOwnPropertyDescriptor": (_target, key) => (builtIn(context, key) ? { ...Reflect.getOwnPropertyDescriptor(globalThis, key), "configurable": true } : Reflect.getOwnPropertyDescriptor(context, key)),
		"ownKeys": () => [...new Set([...Reflect.ownKeys(context), ...[...BUILT_INS].filter((key) => key in globalThis)])]
	});

	return global;
}

/** inContext's own names: its, not the context's. */
const OWN = new Set<PropertyKey>(["__almostnodeVmCode", "__almostnodeVmContext"]);

/** What `code`'s free names resolve in (a `with` over it): the context, and the names the host's global doesn't have. */
function scopeOf(context: Record<PropertyKey, unknown>, global: Record<PropertyKey, unknown>): object {
	return new Proxy(context, {
		"has": (_target, key) => typeof key === "string" && !OWN.has(key) && (key in context || ITSELF.has(key) || !(key in globalThis)),
		"get": (_target, key) => (key === Symbol.unscopables ? undefined : !(key in context) && ITSELF.has(key) ? global : context[key]),
		"set": (_target, key, value) => {
			context[key] = value;

			return true;
		}
	});
}

/** `code` run with `context` as its global (see above). */
const inContext = new Function("$scope", "__almostnodeVmContext", "__almostnodeVmCode", "with ($scope) { return (function() { return eval(__almostnodeVmCode); }).call(__almostnodeVmContext); }") as (scope: object, context: object, code: string) => unknown;

export class Script {
	private readonly code: string;

	constructor(code: string, _options?: object) {
		this.code = code;
	}

	runInThisContext(_options?: object): unknown {
		return (0, eval)(this.code); // (indirect: the global scope's, as Node's — not this module's)
	}

	runInNewContext(contextObject?: object, _options?: object): unknown {
		const context = (contextObject ?? {}) as Record<PropertyKey, unknown>;
		const global = globalOf(context);

		return inContext(scopeOf(context, global), global, this.code);
	}

	runInContext(_context: object, _options?: object): unknown {
		return this.runInNewContext(_context, _options);
	}

	createCachedData(): Buffer {
		return Buffer.from("");
	}
}

export function createContext(contextObject?: object, _options?: object): object {
	return contextObject || {};
}

export function isContext(_sandbox: object): boolean {
	return true;
}

export function runInThisContext(code: string, _options?: object): unknown {
	return new Script(code).runInThisContext();
}

export function runInNewContext(code: string, contextObject?: object, _options?: object): unknown {
	const script = new Script(code);

	return script.runInNewContext(contextObject);
}

export function runInContext(code: string, context: object, _options?: object): unknown {
	return runInNewContext(code, context);
}

export function compileFunction(code: string, params?: string[], _options?: object): Function {
	return new Function(...(params || []), code);
}

export class Module {
	constructor(_code: string, _options?: object) {}
	link(_linker: unknown): Promise<void> { return Promise.resolve(); }
	evaluate(_options?: object): Promise<unknown> { return Promise.resolve(); }
	get status(): string { return "unlinked"; }
	get identifier(): string { return ""; }
	get context(): object { return {}; }
	get namespace(): object { return {}; }
}

export class SourceTextModule extends Module {}
export class SyntheticModule extends Module {
	setExport(_name: string, _value: unknown): void {}
}

export default {
	"Script": Script,
	"createContext": createContext,
	"isContext": isContext,
	"runInThisContext": runInThisContext,
	"runInNewContext": runInNewContext,
	"runInContext": runInContext,
	"compileFunction": compileFunction,
	"Module": Module,
	"SourceTextModule": SourceTextModule,
	"SyntheticModule": SyntheticModule
};
