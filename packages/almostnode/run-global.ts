/**
 * A run's global object: what a program's packages see as `globalThis` (and as their free names), as a Node process has
 * a global of its own — apart from the host's, which almostnode shares a realm with (the editor's debugger, say).
 *
 * It's the host's global as far as reading goes — a name the run hasn't set is the host's, and a host function that
 * needs the global as its receiver (`setTimeout`, `fetch`, `performance`'s are on their own object) comes bound to it,
 * as a browser's insists — and what the run sets, defines or deletes is the run's: a package that puts a Proxy over
 * `performance` (just-bash's sandbox) or a polyfill over `fetch` does it to the run's global, not the host's.
 *
 * Not the run's: the intrinsics every global shares — `Object.prototype`, `Math`, `JSON` and their like are one object
 * whichever global they're reached from, so freezing one, or changing a prototype, reaches the host too.
 */

/** A run's global (`global`), the names it set (`own`), and what a module's code resolves its free names in first
 *  (`scope`: `with`, runtime.ts — only what the run set, so the rest stays the host's ordinary global lookup). */
export interface RunGlobal {
	"global": typeof globalThis;
	"own": Record<PropertyKey, unknown>;
	"scope": object;
}

/** The names that are the global itself: the run's. */
const ITSELF = new Set<PropertyKey>(["globalThis", "global", "self", "window"]);

/** Whether `value` is a host function called on the global (`setTimeout`, `fetch`, `atob`): not a constructor or a
 *  namespace's, so binding it changes nothing but its receiver. */
const onTheGlobal = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function" && !Object.hasOwn(value, "prototype") && /^[a-z]/u.test(value.name);

export function createRunGlobal(host: typeof globalThis = globalThis): RunGlobal {
	const own: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>;
	// (each bound once, so a function read twice is the same function)
	const bound = new Map<PropertyKey, (...args: unknown[]) => unknown>();
	const global = new Proxy(own, {
		"get": (_target, key) => {
			if (Object.hasOwn(own, key)) {
				return own[key];
			}

			if (ITSELF.has(key) && key in host) {
				return global;
			}

			const value = Reflect.get(host, key);

			if (!onTheGlobal(value)) {
				return value;
			}

			let fn = bound.get(key);

			if (fn === undefined) {
				fn = Object.assign(value.bind(host), value);
				bound.set(key, fn);
			}

			return fn;
		},
		"set": (_target, key, value) => {
			own[key] = value;

			return true;
		},
		"has": (_target, key) => Object.hasOwn(own, key) || key in host,
		"deleteProperty": (_target, key) => delete own[key],
		"defineProperty": (_target, key, descriptor) => Reflect.defineProperty(own, key, descriptor),
		// (a host's own property is reported configurable: the run may redefine it on its own global)
		"getOwnPropertyDescriptor": (_target, key) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(own, key) ?? Reflect.getOwnPropertyDescriptor(host, key);

			return descriptor === undefined || Object.hasOwn(own, key) ? descriptor : { ...descriptor, "configurable": true };
		},
		"ownKeys": () => [...new Set([...Reflect.ownKeys(own), ...Reflect.ownKeys(host)])],
		"getPrototypeOf": () => Reflect.getPrototypeOf(host)
	}) as unknown as typeof globalThis;
	// A module's free names: the run's where it set them (and `with`'s @@unscopables, none), the host's lookup otherwise.
	const scope = new Proxy(own, {
		"has": (_target, key) => typeof key === "string" && Object.hasOwn(own, key),
		"get": (_target, key) => (key === Symbol.unscopables ? undefined : own[key]),
		"set": (_target, key, value) => {
			own[key] = value;

			return true;
		}
	});

	return { "global": global, "own": own, "scope": scope };
}

/**
 * An `eval` for a run whose host interprets its program (the tsval debugger, which leaves code from strings to its host:
 * tsval/src/globals.ts): `source` evaluated as global code, natively, its completion value returned — seeing the globals
 * the program sees. Its free names are the program's global object's (`program()`, the interpreter's: what
 * `globalThis` is to the program), then the run's own (what packages set there), and nothing of the host's beyond
 * them; `this` and `globalThis` are the program's global object; a name assigned is set where the program's would be,
 * or made on its global object, as sloppy code makes one. Without a program, the run's global stands for it. A direct
 * eval's caller's own scope isn't the host's to give: either kind is global code here. Anything but a string is
 * returned as it is, as eval does.
 */
export function runEval(run: RunGlobal, program: () => Record<PropertyKey, unknown> | undefined = () => undefined): (source: unknown) => unknown {
	// (`eval` and `arguments` stay the wrapper's: the eval inside is a direct one, given the source as its argument)
	const WRAPPER = new Set<PropertyKey>(["eval", "arguments"]);
	const names = (global: Record<PropertyKey, unknown>): object => new Proxy(Object.create(null) as object, {
		"has": (_target, key) => typeof key === "string" && !WRAPPER.has(key),
		"get": (_target, key) => (key === Symbol.unscopables ? undefined : key in global ? global[key] : Object.hasOwn(run.own, key) ? run.own[key] : undefined),
		"set": (_target, key, value) => {
			if (!(key in global) && Object.hasOwn(run.own, key)) {
				run.own[key] = value;
			} else {
				global[key] = value;
			}

			return true;
		}
	});
	// eslint-disable-next-line no-eval -- code from strings, given to a run on purpose (packages/editor/RUNNING.md): its wrapper compiled once
	const compile = (0, eval)("(function($names) { return function() { with ($names) { return eval(arguments[0]); } }; })") as (scope: object) => (this: unknown, source: string) => unknown;
	const evaluate = (source: unknown): unknown => {
		if (typeof source !== "string") {
			return source;
		}

		const global = program() ?? (run.global as unknown as Record<PropertyKey, unknown>);

		return compile(names(global)).call(global, source);
	};

	return Object.defineProperty(evaluate, "name", { "value": "eval" });
}
