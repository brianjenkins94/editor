import type { Encoded } from "@brianjenkins94/editor-api/recorded";
import type { Replay } from "@brianjenkins94/editor-api/recorded";
import type ts from "typescript";
import { revive } from "@brianjenkins94/editor-api/recorded";
import { isGuestFunction } from "@brianjenkins94/tsval";

export function replayProgram(source: string, [l1, c1, l2, c2]: [number, number, number, number]): string {
	const offset = (line: number, character: number): number => {
		let at = 0;

		for (let each = 0; each < line; each += 1) {
			at = source.indexOf("\n", at) + 1;
		}

		return at + character;
	};

	const [from, end] = [offset(l1, c1), offset(l2, c2)];
	const start = from + (/^export\s+(?:default\s+)?/u.exec(source.slice(from, end))?.[0].length ?? 0);
	const blank = (text: string): string => text.replace(/[^\n]/gu, " ");
	const prefix = "(__self.__replay = ";
	const suffix = ", __self.__replay(...__args));";
	let before = blank(source.slice(0, start));
	let after = blank(source.slice(end));
	const room = (text: string, length: number, last: boolean): number => {
		const runs = [...text.matchAll(new RegExp(` {${length},}`, "gu"))];
		const run = last ? runs.at(-1) : runs[0];

		if (run === undefined) {
			return -1;
		}

		return last ? run.index + run[0].length - length : run.index;
	};

	const front = room(before, prefix.length, true);
	const back = room(after, suffix.length, false);

	before = front === -1 ? prefix + before : before.slice(0, front) + prefix + before.slice(front + prefix.length);
	after = back === -1 ? after + suffix : after.slice(0, back) + suffix + after.slice(back + suffix.length);

	return before + source.slice(start, end) + after;
}

export function replayGuard(replay: Replay): { "standIn": (name: string) => (...args: unknown[]) => unknown; "hostGuard": { "beforeCall": (callee: (...args: unknown[]) => unknown, self: unknown, construct: boolean, site: { "node": ts.Node; "args": readonly unknown[] }) => (...args: unknown[]) => unknown } } {
	const standIn = (name: string): ((...args: unknown[]) => unknown) => Object.defineProperty(function standIn(): unknown {
		return undefined;
	}, "name", { "value": name });
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

				const value = time < results.length ? revive(results[time], standIn) : undefined;

				return () => value;
			}
		}
	};
}
