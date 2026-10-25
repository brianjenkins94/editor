/**
 * almostnode's `timers` and `timers/promises` (builtins.ts), as Node's behave — there's no port of Node's on npm (its
 * timers are libuv's). unenv's bound the realm's timers as it loaded, before the runtime gives them Node's Timeout
 * objects (runtime.ts: `.unref()` and the rest), and its promises resolved at once, whatever the delay. Here each is the
 * realm's own when it's called, and a promise waits.
 */

/** The realm's timers as they are now: the runtime's, once it has made them Node's. */
const timers = (): typeof globalThis => globalThis;

export const setTimeout = (...args: Parameters<typeof globalThis.setTimeout>): ReturnType<typeof globalThis.setTimeout> => timers().setTimeout(...args);
export const setInterval = (...args: Parameters<typeof globalThis.setInterval>): ReturnType<typeof globalThis.setInterval> => timers().setInterval(...args);
export const clearTimeout = (timeout?: Parameters<typeof globalThis.clearTimeout>[0]): void => {
	timers().clearTimeout(timeout);
};
export const clearInterval = (interval?: Parameters<typeof globalThis.clearInterval>[0]): void => {
	timers().clearInterval(interval);
};
export const setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]): unknown => ((timers() as { "setImmediate"?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => unknown }).setImmediate ?? ((fn: (...args: unknown[]) => void, ...rest: unknown[]) => timers().setTimeout(fn, 0, ...rest)))(callback, ...args);
export const clearImmediate = (immediate: unknown): void => {
	((timers() as { "clearImmediate"?: (immediate: unknown) => void }).clearImmediate ?? ((id: unknown) => timers().clearTimeout(id as number)))(immediate);
};

/** Node's AbortError: what a promise rejects with when its signal aborts. */
class AbortError extends Error {
	public readonly code = "ABORT_ERR";

	public constructor(cause?: unknown) {
		super("The operation was aborted", cause === undefined ? undefined : { "cause": cause });
		this.name = "AbortError";
	}
}

interface Options { "signal"?: AbortSignal; "ref"?: boolean }

/** A promise that settles with `value` once `start` calls back — or rejects, its signal aborted (before, or while it waits). */
function waited<T>(value: T, options: Options | undefined, start: (done: () => void) => unknown, stop: (handle: unknown) => void): Promise<T> {
	const signal = options?.signal;

	if (signal?.aborted === true) {
		return Promise.reject(new AbortError(signal.reason));
	}

	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			stop(handle);
			reject(new AbortError(signal?.reason));
		};
		const handle = start(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		});

		signal?.addEventListener("abort", onAbort, { "once": true });
	});
}

/** `timers/promises`, as Node's. */
export const promises = {
	"setTimeout": <T = void>(delay?: number, value?: T, options?: Options): Promise<T> => waited(value as T, options, (done) => setTimeout(done, delay), (handle) => {
		clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
	}),
	"setImmediate": <T = void>(value?: T, options?: Options): Promise<T> => waited(value as T, options, (done) => setImmediate(done), clearImmediate),
	"setInterval": async function* <T = void>(delay?: number, value?: T, options?: Options): AsyncGenerator<T> {
		const signal = options?.signal;
		let ticks = 0;
		let wake: (() => void) | undefined;
		const interval = setInterval(() => {
			ticks += 1;
			wake?.();
		}, delay);
		const aborted = (): void => {
			wake?.();
		};
		const nextTick = (): Promise<void> => new Promise<void>((resolve) => {
			wake = resolve;
		});

		signal?.addEventListener("abort", aborted);

		try {
			while (true) {
				if (signal?.aborted === true) {
					throw new AbortError(signal.reason);
				}

				if (ticks === 0) {
					await nextTick();
					wake = undefined;
					continue;
				}

				ticks -= 1;
				yield value as T;
			}
		} finally {
			clearInterval(interval);
			signal?.removeEventListener("abort", aborted);
		}
	},
	"scheduler": {
		"wait": (delay: number, options?: Options): Promise<void> => promises.setTimeout(delay, undefined, options),
		"yield": (): Promise<void> => promises.setImmediate()
	}
};
