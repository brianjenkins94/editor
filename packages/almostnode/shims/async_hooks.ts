/* eslint-disable ts/no-explicit-any -- vendored fork of macaly/almostnode — upstream/runtime idioms kept close to source, not restyled to this repo rules */
/**
 * async_hooks shim. A browser has no async hooks, so the async context is carried by hand: one immutable map, each
 * AsyncLocalStorage's store, that a continuation resumes in as Node's does —
 *
 *   - a package's `await` (runtime.ts rewrites it to resume in the context it was in: `resume(capture(), await x)`, and
 *     its async function's `catch`, `finally` and `for await` bodies too);
 *   - a promise's callbacks and a timer's, in the context they were handed over in (installed with the first
 *     AsyncLocalStorage: `Promise.prototype.then`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`);
 *   - the program's own (tsval's, which interprets it, through its `asyncContext` option).
 */

type Context = ReadonlyMap<object, unknown>;

let current: Context = new Map();

/** `fn` run in `context`, and the context as it was after. */
function within<R>(context: Context, fn: (...args: any[]) => R, thisArg: unknown, args: unknown[]): R {
	const before = current;

	current = context;

	try {
		return fn.apply(thisArg, args);
	} finally {
		current = before;
	}
}

/** `fn`, to be called later in the context it's bound in now (or as it is, when it's not a function). */
function bound<F>(fn: F): F {
	if (typeof fn !== "function") {
		return fn;
	}

	const context = current;

	return function(this: unknown, ...args: unknown[]) { return within(context, fn as (...args: any[]) => unknown, this, args); } as F;
}

/** What carries the context through an `await` and an interpreter's jobs: the context now, and resuming in one. */
export const asyncContext = {
	"capture": (): Context => current,
	"enter": (context: unknown): void => { current = context as Context; },
	/** Resume in `context`, passing `value` through: what runtime.ts makes a package's `await x` (an argument is
	 *  evaluated before the next, so `resume(capture(), await x)` captures before it suspends, resumes after). */
	"resume": <T>(context: unknown, value: T): T => { current = context as Context; return value; }
};

let carrying = false;

/** Promise callbacks and timers carry the context they're handed over in — once, when something first keeps a store. */
function carryThroughCallbacks(): void {
	if (carrying) {
		return;
	}

	carrying = true;

	const { then } = Promise.prototype;

	// (`catch` and `finally` call `then`)
	// eslint-disable-next-line no-extend-native -- a browser has no promise hook: wrapping `then` is how a callback keeps its context
	Promise.prototype.then = function(this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown) {
		return then.call(this, bound(onFulfilled) as never, bound(onRejected) as never);
	} as typeof then;

	const scope = globalThis as unknown as Record<string, unknown>;

	for (const name of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
		const schedule = scope[name];

		if (typeof schedule === "function") {
			// (on the global, whatever it's called on: a browser's throws "Illegal invocation" called on anything else, as a
			// library that keeps it on an object of its own calls it)
			scope[name] = Object.assign((callback: unknown, ...rest: unknown[]) => (schedule as (...args: unknown[]) => unknown).call(globalThis, bound(callback), ...rest), schedule);
		}
	}
}

export class AsyncResource {
	private readonly context: Context = current;

	constructor(_type: string, _options?: object) {}
	runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T {
		return within(this.context, fn, thisArg, args);
	}

	bind<F extends (...args: any[]) => any>(fn: F, thisArg?: unknown): F {
		const run = (called: unknown, args: unknown[]): unknown => this.runInAsyncScope(fn, thisArg ?? called, ...args);

		return function(this: unknown, ...args: unknown[]) { return run(this, args); } as F;
	}

	emitDestroy(): this { return this; }
	asyncId(): number { return 0; }
	triggerAsyncId(): number { return 0; }
	static bind<T extends (...args: any[]) => any>(fn: T, _type?: string, thisArg?: unknown): T {
		return new AsyncResource("bound").bind(fn, thisArg);
	}
}

export class AsyncLocalStorage<T> {
	constructor() {
		carryThroughCallbacks();
	}

	/** `fn`, to be called later in the context now. */
	static bind<F extends (...args: any[]) => any>(fn: F): F {
		return bound(fn);
	}

	/** What runs a function later in the context now. */
	static snapshot(): <R>(fn: (...args: any[]) => R, ...args: any[]) => R {
		const context = current;

		return (fn, ...args) => within(context, fn, undefined, args);
	}

	disable(): void {
		this.enterWith(undefined);
	}

	getStore(): T | undefined {
		return current.get(this) as T | undefined;
	}

	run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
		return within(new Map(current).set(this, store), callback, undefined, args);
	}

	exit<R>(callback: (...args: any[]) => R, ...args: any[]): R {
		const context = new Map(current);

		context.delete(this);

		return within(context, callback, undefined, args);
	}

	enterWith(store: T | undefined): void {
		current = new Map(current).set(this, store);
	}
}

export interface AsyncHook {
	enable(): this;
	disable(): this;
}

export function createHook(_callbacks: object): AsyncHook {
	return {
		"enable": function(): AsyncHook { return this; },
		"disable": function(): AsyncHook { return this; }
	};
}

export function executionAsyncId(): number {
	return 0;
}

export function executionAsyncResource(): object {
	return {};
}

export function triggerAsyncId(): number {
	return 0;
}

export default {
	"AsyncResource": AsyncResource,
	"AsyncLocalStorage": AsyncLocalStorage,
	"createHook": createHook,
	"executionAsyncId": executionAsyncId,
	"executionAsyncResource": executionAsyncResource,
	"triggerAsyncId": triggerAsyncId
};
