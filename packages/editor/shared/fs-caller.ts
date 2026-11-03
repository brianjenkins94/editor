/**
 * Who is calling the workspace's store right now, for its counts (fs-boundaries.ts) and the architecture reports
 * (architecture-zenfs.ts): a caller names itself for the length of each call it makes (`asCaller`), or hands a library
 * an fs that does (`callerFs`: isomorphic-git's, `git`). zen-fs reaches its store synchronously from the call, so the
 * name is the one set when the store's operation runs; a call that names nobody is a direct one.
 */

/** The caller now, on the realm's global: one for every bundle loaded into it (the workbench's, an extension's). */
const state = ((globalThis as Record<symbol, unknown>)[Symbol.for("editor.fs-caller")] ??= { "current": undefined }) as { "current": string | undefined };

/** The caller naming itself now, if one is. */
export function fsCaller(): string | undefined {
	return state.current;
}

/** `run` as `name`'s call: whatever store operations it makes synchronously are `name`'s. */
export function asCaller<T>(name: string, run: () => T): T {
	const before = state.current;

	state.current = name;

	try {
		return run();
	} finally {
		state.current = before;
	}
}

/** `fs` (a node-style fs, its `promises` too) whose every call is `name`'s. A promise call is answered by its synchronous
 *  twin (`promises.stat` by `statSync`) where `fs` has one: zen-fs's promise functions await before they reach the store,
 *  past where the name holds — its store is in memory, so the twin costs the thread no more. */
export function callerFs<T extends object>(fs: T, name: string): T {
	const named = <U extends object>(target: U): U => new Proxy(target, {
		"get": (object, property, receiver) => {
			const value = Reflect.get(object, property, receiver) as unknown;

			return typeof value === "function" ? (...args: unknown[]) => asCaller(name, () => (value as (...parameters: unknown[]) => unknown).apply(object, args)) : value;
		}
	});
	const { promises } = fs as { "promises"?: object };
	const twinned = promises === undefined ? undefined : new Proxy(promises, {
		"get": (object, property, receiver) => {
			const twin = typeof property === "string" ? (fs as Record<string, unknown>)[property + "Sync"] : undefined;

			if (typeof twin === "function") {
				return async (...args: unknown[]) => asCaller(name, () => (twin as (...parameters: unknown[]) => unknown).apply(fs, args));
			}

			return Reflect.get(named(object), property, receiver);
		}
	});

	return new Proxy(fs, {
		"get": (object, property, receiver) => {
			if (property === "promises" && twinned !== undefined) {
				return twinned;
			}

			return Reflect.get(named(object), property, receiver);
		}
	});
}
