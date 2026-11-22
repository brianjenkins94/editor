const state = ((globalThis as Record<symbol, unknown>)[Symbol.for("editor.fs-caller")] ??= { "current": undefined }) as { "current": string | undefined };

export function fsCaller(): string | undefined {
	return state.current;
}

export function asCaller<T>(name: string, run: () => T): T {
	const before = state.current;

	state.current = name;

	try {
		return run();
	} finally {
		state.current = before;
	}
}

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

interface CallSite { "getTypeName": () => string | null; "getFunctionName": () => string | null }

const FILE_SERVICE = /^(?:FileService|FileServiceOverride|OverlayFileSystemProvider)$/u;

const NOBODY = new Set(["Object", "Array", "Promise", "Map", "Set", "Function", "Generator", "AsyncGenerator", "Window", "global"]);

const STACK_FRAMES = 30;

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
