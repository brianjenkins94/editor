/**
 * A recorded call, run again (RUNNING.md: stepping a recorded handler): the program a replay runs, and what stands in for
 * the calls it can't make. Pure — the debug worker runs it (debug-worker.ts `launchReplay`), node tests it.
 */
import type ts from "typescript";
import type { Replay } from "../worker-pod/page-evidence";
import type { Encoded } from "../worker-pod/snapshot";
import { isGuestFunction } from "@brianjenkins94/tsval";
import { revive } from "../worker-pod/snapshot";

/** The program a replay runs (RUNNING.md: stepping a recorded handler): the recorded version's text with everything but
 *  the function blanked (newlines kept, so every line and column is the file's), the function made the callee of a call
 *  with its recorded `this` and arguments — `(__self.__replay = <fn>, __self.__replay(...__args))` — on the stack the
 *  debugger steps (a call through `.call` would run nested, unstepped). What goes in front sits in the blank before it,
 *  what goes after in the blank after; with no room, in front of everything. */
export function replayProgram(source: string, [l1, c1, l2, c2]: [number, number, number, number]): string {
	const offset = (line: number, character: number): number => {
		let at = 0;

		for (let each = 0; each < line; each += 1) {
			at = source.indexOf("\n", at) + 1;
		}

		return at + character;
	};
	const [start, end] = [offset(l1, c1), offset(l2, c2)];
	const blank = (text: string): string => text.replace(/[^\n]/gu, " ");
	const prefix = "(__self.__replay = ";
	const suffix = ", __self.__replay(...__args));";
	let before = blank(source.slice(0, start));
	let after = blank(source.slice(end));
	const room = (text: string, length: number, last: boolean): number => {
		const runs = [...text.matchAll(new RegExp(` {${length},}`, "gu"))];
		const run = last ? runs.at(-1) : runs[0];

		return run === undefined ? -1 : last ? run.index + run[0].length - length : run.index;
	};
	const front = room(before, prefix.length, true);
	const back = room(after, suffix.length, false);

	before = front === -1 ? prefix + before : before.slice(0, front) + prefix + before.slice(front + prefix.length);
	after = back === -1 ? after + suffix : after.slice(0, back) + suffix + after.slice(back + suffix.length);

	return before + source.slice(start, end) + after;
}

/** What stands in for what a replay couldn't record (`standIn`: a named function), and the host guard (tsval's
 *  `hostGuard`) that hands each call to something outside the program — a page's function, a DOM method, a builtin —
 *  the result it had, by where it was made and how many times there; a call with a function of the program's among its
 *  arguments (`items.map(fn)`) is made for real, so the debugger steps into it. */
export function replayGuard(replay: Replay): { "standIn": (name: string) => (...args: unknown[]) => unknown; "hostGuard": { "beforeCall": (callee: (...args: unknown[]) => unknown, self: unknown, construct: boolean, site: { "node": ts.Node; "args": readonly unknown[] }) => (...args: unknown[]) => unknown } } {
	const standIn = (name: string): ((...args: unknown[]) => unknown) => Object.defineProperty(function standIn(): unknown { return undefined; }, "name", { "value": name });
	const recorded = new Map<string, Encoded[]>();
	const made = new Map<string, number>();

	for (const [line, character, value] of replay.calls) {
		recorded.set(`${line}:${character}`, [...recorded.get(`${line}:${character}`) ?? [], value]);
	}

	return {
		"standIn": standIn,
		"hostGuard": {
			"beforeCall": (callee, _self, _construct, site) => {
				const file = site.node.getSourceFile();
				const { line, character } = file.getLineAndCharacterOfPosition(site.node.getStart(file));
				const key = `${line}:${character}`;
				const results = recorded.get(key);

				if (results === undefined || site.args.some((arg) => isGuestFunction(arg))) {
					return callee;
				}

				const time = made.get(key) ?? 0;

				made.set(key, time + 1);

				const value = time < results.length ? revive(results[time]!, standIn) : undefined;

				return () => value;
			}
		}
	};
}
