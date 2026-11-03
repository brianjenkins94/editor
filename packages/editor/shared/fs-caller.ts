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

/** A frame of a stack as V8 hands it to `Error.prepareStackTrace`: the parts naming whose call it is. */
interface CallSite { "getTypeName": () => string | null; "getFunctionName": () => string | null }

/** VS Code's file service and the overlays between it and a provider: the asker is past these on a call's stack. */
const FILE_SERVICE = /^(?:FileService|FileServiceOverride|OverlayFileSystemProvider)$/u;

/** A class on a stack that says nothing of who's asking: a language's own, or a stack's way through a callback. */
const NOBODY = new Set(["Object", "Array", "Promise", "Map", "Set", "Function", "Generator", "AsyncGenerator", "Window", "global"]);

/** How many frames are read for the asker: VS Code's file service is a few deep, and the asker just past it. */
const STACK_FRAMES = 30;

/**
 * Who in VS Code is calling its file service, from the provider it reached: the class of the first method on the
 * stack past the file service — awaits included, as V8 keeps them — such as `WorkspaceSearch` (file search's walk) or
 * `MainThreadFileSystem` (an extension's `workspace.fs`), or `vscode` where the stack doesn't reach one (it ends at a
 * `Promise.all`). Read from the stack's call sites, not its text: about 2 µs, against a provider call's 70.
 */
export function vscodeCaller(): string {
	const prepare = Error.prepareStackTrace;
	const limit = Error.stackTraceLimit;
	let sites: CallSite[];

	Error.prepareStackTrace = (_, frames) => frames;
	Error.stackTraceLimit = STACK_FRAMES;

	try {
		sites = new Error("caller").stack as unknown as CallSite[];
	} finally {
		Error.prepareStackTrace = prepare;
		Error.stackTraceLimit = limit;
	}

	let past = false;

	for (const site of sites) {
		const type = site.getTypeName();

		if (type !== null && FILE_SERVICE.test(type)) {
			past = true;
		} else if (past && type !== null && !NOBODY.has(type)) {
			return type;
		}
	}

	return "vscode";
}
