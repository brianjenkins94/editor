/**
 * Ranges of a text that ran, found again in the file as it is now — so what the notes margin places by them (a run's
 * values, its coverage, where it crashed or was stopped, a capability stop's question) follows its code through edits
 * and cosmetic changes: a reindent, a rewrap, spacing, semicolons. Each range is referred to once, against the text that
 * ran, as the BABLR span standing for it (`editor.annotations.refer`), and found by that span's id in the text as it is
 * (`editor.annotations.resolve`); one whose code is gone — edited past recognizing, or deleted — isn't found, and
 * whatever it placed goes with it.
 *
 * Runs in the workbench realm (core), with the workbench's own extension API.
 */
import type * as vscodeApi from "vscode";
import { annotations, type SpanRef } from "@brianjenkins94/run-contract/annotations";

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

		if (starts[mid]! <= at) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return low;
}

/** Each line of `before` at its line in `after`, by the lines they share — the common head and tail, and the changed
 *  middle line for line — for when `after` can't be read as code (typing paused mid-statement): what's placed follows
 *  the lines around the edit until the code parses again. */
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

	return (line) => (line < head ? line : line >= was.length - tail ? line - was.length + now.length : line - head < now.length - head - tail ? line : undefined);
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

	/** Whether BABLR reads `text` as code: only then does the whole of it refer to a span (its Program). */
	private async parses(text: string): Promise<boolean> {
		const [whole] = await annotations(this.vscode.commands).refer(text, this.file, [{ "start": 0, "end": text.length }]) ?? [];

		return whole !== undefined && whole !== null;
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
				this.refs.set(`${start}:${end}`, referred.then((all) => all?.[index]));
			}
		}

		const refs = await Promise.all(ranges.map(([start, end]) => this.refs.get(`${start}:${end}`)));
		// Only the ranges BABLR found a span for are looked for (one it couldn't — a file its grammar doesn't take — is gone).
		const known = refs.flatMap((ref, index) => (ref === undefined ? [] : [index]));
		const found = await annotations(this.vscode.commands).resolve(text, this.file, known.map((index) => refs[index]!), { "observed": true });
		const starts = lineStarts(text);
		const lines: (number | undefined)[] = ranges.map(() => undefined);

		for (const [position, index] of known.entries()) {
			const at = found?.[position]?.candidate;

			if (at?.start !== undefined && (at.file === undefined || at.file === this.file)) {
				lines[index] = lineOf(starts, at.start);
			}
		}

		// Nothing found: its code gone — or the text doesn't parse yet (typing paused mid-statement), which BABLR says by
		// referring to nothing in it (its parse cached, as resolve's). Then follow the lines around the edit instead.
		if (known.length > 0 && lines.every((line) => line === undefined) && !await this.parses(text)) {
			const map = lineMap(this.source, text);

			return ranges.map(([start]) => map(lineOf(this.sourceStarts, start)));
		}

		return lines;
	}
}
