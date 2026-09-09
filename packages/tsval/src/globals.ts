/**
 * The default global object: ECMAScript's standard global namespace and nothing else.
 *
 * A program run with no `globalObject` sees exactly the language's built-ins — `Object`, `Array`,
 * `Math`, `JSON`, `Promise`, `Symbol`, the error and typed-array constructors, `Intl` — and none of
 * the host's (`process`, `require`, `fetch`, timers, `console`): a host adds what it wants through
 * `globals`. The values come from the host realm (so results are ordinary host values), which means
 * prototype mutation by the guest reaches the host's intrinsics; a host that needs a wall there
 * passes a fresh realm's global as `globalObject` (the corpus runners do) and/or a `hostGuard`.
 *
 * `eval` is deliberately absent: direct eval cannot be modeled by an interpreter that is not the
 * host's, and code-from-string is a decision for the host (it may supply its own `eval`).
 */
const STANDARD_GLOBAL_NAMES = [
	// values
	"globalThis",
	"Infinity",
	"NaN",
	"undefined",
	// functions
	"isFinite",
	"isNaN",
	"parseFloat",
	"parseInt",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	// fundamental objects
	"Object",
	"Function",
	"Boolean",
	"Symbol",
	"Error",
	"AggregateError",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	// numbers, text, dates
	"Number",
	"BigInt",
	"Math",
	"Date",
	"String",
	"RegExp",
	// collections
	"Array",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"Iterator",
	// typed arrays and buffers
	"ArrayBuffer",
	"SharedArrayBuffer",
	"DataView",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"Atomics",
	// control abstraction and reflection
	"Promise",
	"Proxy",
	"Reflect",
	"JSON",
	// ECMA-402
	"Intl"
];

/** A fresh global object holding the standard built-ins (a new table each call: hosts may add to it). */
export function standardGlobals(): Record<string, unknown> {
	const table: Record<string, unknown> = {};

	for (const name of STANDARD_GLOBAL_NAMES) {
		if (name in globalThis) { table[name] = (globalThis as Record<string, unknown>)[name]; }
	}

	table.globalThis = table; // the guest's `globalThis` is its own global object, not the host's

	return table;
}
