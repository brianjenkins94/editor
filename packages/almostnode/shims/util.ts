/**
 * What almostnode's `util` has over unenv's (builtins.ts): two functions unenv only says it doesn't implement, which
 * tooling running here calls — `callbackify` (a promise-returning function as a callback-taking one) and
 * `stripVTControlCharacters` (terminal escapes taken out of a string, as loggers do before measuring or writing it).
 */

/** `fn`, which returns a promise, as a function taking a callback last: `(error, result)`, as Node's does. */
export function callbackify<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => void {
	return (...args: any[]) => {
		const callback = args.pop() as (error: Error | null, result?: T) => void;

		fn(...args).then((result) => {
			callback(null, result);
		}, (error: unknown) => {
			callback(error instanceof Error ? error : Object.assign(new Error("Promise was rejected with a falsy value"), { "reason": error }));
		});
	};
}

/** `text` without its terminal escape sequences (colors, cursor moves, OSC titles). */
export function stripVTControlCharacters(text: string): string {
	// eslint-disable-next-line no-control-regex -- the escapes are what's matched
	return text.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][A-Z0-9]|\x1B[#=]|\x1B./gu, "");
}
