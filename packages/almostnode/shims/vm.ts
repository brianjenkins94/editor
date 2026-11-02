/* eslint-disable no-eval, no-new-func, ts/no-implied-eval, ts/class-literal-property-style, ts/no-unsafe-function-type -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
/**
 * vm shim. A browser can't make a realm of its own here, so a context is its object over the host's realm: the code's
 * `globalThis` (and `global`, `self`, its top-level `this`) is the context object, and its free names are the
 * context's — what the context has, and any name the host's global hasn't, read and assigned there — while the
 * built-ins (`Object`, `Math`, …) are the host's (Node's context has its own). Two of Node's left out: reading a name
 * neither has is `undefined` rather than a ReferenceError, and a top-level `var` stays the code's rather than becoming
 * the context's property.
 */

/** The names that are the global itself: in a context, the context. */
const ITSELF = new Set<PropertyKey>(["globalThis", "global", "self", "window"]);

/** inContext's own names: its, not the context's. */
const OWN = new Set<PropertyKey>(["__almostnodeVmCode", "__almostnodeVmContext"]);

/** What `code`'s free names resolve in (a `with` over it): the context, and the names the host's global doesn't have. */
function scopeOf(context: Record<PropertyKey, unknown>): object {
	return new Proxy(context, {
		"has": (_target, key) => typeof key === "string" && !OWN.has(key) && (key in context || ITSELF.has(key) || !(key in globalThis)),
		"get": (_target, key) => (key === Symbol.unscopables ? undefined : !(key in context) && ITSELF.has(key) ? context : context[key]),
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

		return inContext(scopeOf(context), context, this.code);
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
