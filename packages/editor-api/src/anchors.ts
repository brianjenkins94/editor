/**
 * Ranges of a text that ran, found again in the file as it is now — so what's placed by them (the Margin's run values,
 * coverage, where a run crashed or was stopped, a capability stop's question; a pane view's `ran` items) follows its
 * code through edits and cosmetic changes: a reindent, a rewrap, spacing, semicolons. Each range is referred to once, against the text that
 * ran, as the BABLR span standing for it (`editor.annotations.refer`), and found by that span's id in the text as it is
 * (`editor.annotations.resolve`); one whose code is gone — edited past recognizing, or deleted — isn't found, and
 * whatever it placed goes with it.
 *
 * Core's pane and any extension alike, each with its own VS Code API (it runs `editor.annotations.*`).
 */
import type * as vscodeApi from "vscode";
import type { SpanRef } from "./annotations.ts";
import { annotations } from "./annotations.ts";

/** A range of offsets, `[start, end)`. */
export type Range = [number, number];

/** Each line's first offset in `text`, for offset → line. */
function lineStarts(text: string): number[] {
	const starts = [0];

	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
		starts.push(at + 1);
	}

	return starts;
}

/** The line (0-based) offset `at` is on. */
function lineOf(starts: number[], at: number): number {
	let low = 0;
	let high = starts.length - 1;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);

		if (starts[mid] <= at) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return low;
}

/** How many line pairs the changed middle's matching may weigh (its lines times the edit's): past it, the middle is
 *  followed line for line alone. */
const MATCH_CELLS = 250_000;

/** Each line of `was[from, to)` paired with an equal one of `now[at, until)`, in order and as many as can be (their longest
 *  common subsequence): by index in `was`, its index in `now`. */
function pairs(was: string[], from: number, to: number, now: string[], at: number, until: number): Map<number, number> {
	const rows = to - from;
	const columns = until - at;
	const paired = new Map<number, number>();

	if (rows === 0 || columns === 0 || rows * columns > MATCH_CELLS) {
		return paired;
	}

	// (lengths of the common subsequences of each pair of suffixes, a row a line of `was`)
	const lengths = Array.from({ "length": rows + 1 }, () => new Uint32Array(columns + 1));

	for (let row = rows - 1; row >= 0; row -= 1) {
		for (let column = columns - 1; column >= 0; column -= 1) {
			lengths[row][column] = was[from + row] === now[at + column] ? lengths[row + 1][column + 1] + 1 : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
		}
	}

	for (let row = 0, column = 0; row < rows && column < columns;) {
		if (was[from + row] === now[at + column]) {
			paired.set(from + row, at + column);
			row += 1;
			column += 1;
		} else if (lengths[row + 1][column] >= lengths[row][column + 1]) {
			row += 1;
		} else {
			column += 1;
		}
	}

	return paired;
}

/** Each line of `before` at its line in `after`, by the lines they share — the common head and tail, the lines of the
 *  changed middle that are still there, and the rest of it line for line between those — for when `after` can't be read
 *  as code (typing paused mid-statement): what's placed follows the lines around the edit until the code parses again. */
function lineMap(before: string, after: string): (line: number) => number | undefined {
	const was = before.split("\n");
	const now = after.split("\n");
	let head = 0;
	let tail = 0;

	while (head < was.length && head < now.length && was[head] === now[head]) {
		head += 1;
	}

	while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) {
		tail += 1;
	}

	// (a line still there in the middle — one a fix on save moved, say — is where it is now)
	const kept = pairs(was, head, was.length - tail, now, head, now.length - tail);

	return (line) => {
		if (line < head) {
			return line;
		}

		if (line >= was.length - tail) {
			return line - was.length + now.length;
		}

		const paired = kept.get(line);

		if (paired !== undefined) {
			return paired;
		}

		// (one that isn't: line for line from the kept line before it, if that's still before the kept line after it)
		let previous = line - 1;

		while (previous >= head && !kept.has(previous)) {
			previous -= 1;
		}

		let next = line + 1;

		while (next < was.length - tail && !kept.has(next)) {
			next += 1;
		}

		const at = (previous < head ? head - 1 : kept.get(previous)!) + line - previous;

		return at < (next < was.length - tail ? kept.get(next)! : now.length - tail) ? at : undefined;
	};
}

/** Offset of `[line, character]` (0-based) in `text`. */
export function offsetOf(text: string, [line, character]: [number, number]): number {
	return (lineStarts(text)[line] ?? text.length) + character;
}

export class Anchors {
	private readonly vscode: typeof vscodeApi;
	private readonly file: string;
	private readonly source: string;
	private readonly sourceStarts: number[];
	/** Each range's reference, by `start:end`, referred to in batches as ranges are first asked about. */
	private readonly refs = new Map<string, Promise<SpanRef | undefined>>();

	/** `path`'s ranges in `source`, the text that ran. */
	public constructor(vscode: typeof vscodeApi, path: string, source: string) {
		this.vscode = vscode;
		this.file = vscode.workspace.asRelativePath(vscode.Uri.file(path), false);
		this.source = source;
		this.sourceStarts = lineStarts(source);
	}

	/** The text that ran. */
	public get text(): string {
		return this.source;
	}

	/** The line (0-based) each range starts on in `text`, the file as it is now: undefined for one whose code is gone. */
	public async lines(text: string, ranges: Range[]): Promise<(number | undefined)[]> {
		if (text === this.source) {
			return ranges.map(([start]) => lineOf(this.sourceStarts, start));
		}

		const unseen = [...new Map(ranges.filter(([start, end]) => !this.refs.has(`${start}:${end}`)).map((range) => [`${range[0]}:${range[1]}`, range])).values()];

		if (unseen.length > 0) {
			const referred = annotations(this.vscode.commands).refer(this.source, this.file, unseen.map(([start, end]) => ({ "start": start, "end": end })));

			for (const [index, [start, end]] of unseen.entries()) {
				this.refs.set(`${start}:${end}`, referred.then((answer) => ("value" in answer ? answer.value[index] : undefined)));
			}
		}

		const refs = await Promise.all(ranges.map(async ([start, end]) => this.refs.get(`${start}:${end}`)));
		// Only the ranges BABLR found a span for are looked for (one it couldn't — a file its grammar doesn't take — is gone).
		const known = refs.flatMap((ref, index) => (ref === undefined ? [] : [index]));
		const answer = await annotations(this.vscode.commands).resolve(text, this.file, known.map((index) => refs[index]), { "observed": true });

		// The text as it is doesn't parse (typing paused mid-statement): follow the lines around the edit instead.
		if ("unparsable" in answer) {
			const map = lineMap(this.source, text);

			return ranges.map(([start]) => map(lineOf(this.sourceStarts, start)));
		}

		const found = "value" in answer ? answer.value : [];
		const starts = lineStarts(text);
		const lines: (number | undefined)[] = ranges.map(() => undefined);

		for (const [position, index] of known.entries()) {
			const at = found[position]?.candidate;

			if (at?.start !== undefined && (at.file === undefined || at.file === this.file)) {
				lines[index] = lineOf(starts, at.start);
			}
		}

		return lines;
	}
}
