/**
 * Span annotations: placing something on code so it stays on that code through edits, reformatting, a branch switch and
 * a move to another file (SPAN-ANNOTATIONS.md in brianjenkins94/editor). The editor's BABLR does the work — one worker,
 * its parses cached by content — and an extension reaches it through three commands the bridge registers, which these
 * call:
 *
 * - `spans(source)`: the spans of a text an annotation can attach to — each one's id (a content-addressed hash, so it
 *   survives edits around it and moves with its code) and offsets; punctuation left out.
 * - `refer(source, file, ranges)`: a reference to the span standing for each `[start, end)` range of `source` — what an
 *   annotation keeps (silo's `SpanRef`: the span's id, its shape and neighbours, the commit it was made against).
 *   `undefined` for a range no span stands for.
 * - `resolve(source, file, refs, options)`: where each reference's span is in `source` now, in the order given.
 *
 * Each answers an `Answer`, one of three — tell them apart, because they mean different things to an annotation:
 *
 * - `{ value }`: the answer;
 * - `{ unparsable }`: BABLR's grammar doesn't take the text as it is (why) — often a file mid-edit. Nothing can be
 *   placed or found in it, but nothing is lost either: keep what's placed where it last was, and look again when the
 *   text changes. (The editor already says so, on the file, in the Problems view.)
 * - `{ unavailable }`: there's no editor BABLR to ask (why): no bridge, as on a desktop build today, or it failed.
 *
 * Batch them: one call for every range or reference in a text, not one each — each call is a round trip to the worker.
 *
 * What `resolve` answers for each reference (silo's `Resolution`), by `status`:
 *
 * - `attached`: on its own span, at `candidate`;
 * - `moved`: on its own span in another file (`candidate.file`) — the code was moved there;
 * - `re-placed`: its span is gone (edited), and the best match was sure enough to take: `candidate`, with `ref` the
 *   reference as it would be made there now — store it, so the next resolve finds it by its id;
 * - `uncertain`: the best match, `candidate`, is weak, or too close to a second (`alternatives`) — show it there, marked,
 *   and let the person confirm or re-place it;
 * - `orphaned`: lost — its code is gone. Nothing is placed; keep the annotation (its code may come back on another branch)
 *   and let the person re-place or dismiss it.
 *
 * A lost reference is looked for further before it's orphaned: in the other files that differ from the last commit, and
 * followed from the commit it was made against. `options.texts` adds texts the file went through that the caller knows
 * (an edit history), each followed the same way. `options.observed` is for references to what ran (runtime evidence):
 * found by their id alone — one that's lost fades rather than being looked for. `options.types` — by span id, its
 * TypeScript type and the types seen at run time — lets a match prefer spans of the same type.
 */

import type { Resolution, SpanRef } from "@brianjenkins94/util/silo/annotations";

export type { Resolution, SpanRef, Status } from "@brianjenkins94/util/silo/annotations";

/** A span of a text an annotation can attach to: its id, and its `[start, end)` offsets. */
export interface Span { "id": string; "start": number; "end": number }

/** Where a reference's span is now, and — when it was found other than by its id — the reference as made there now. */
export type Resolved = Resolution & { "ref"?: SpanRef };

/** How `resolve` looks (see above). */
export interface ResolveOptions { "observed"?: boolean; "types"?: Record<string, { "inferred"?: string; "observed"?: string[] }>; "texts"?: string[] }

/** What a call answers (see above): the answer, or why there's none — the text can't be parsed, or there's no BABLR. */
export type Answer<T> = { "value": T } | { "unparsable": string } | { "unavailable": string };

/** What runs the commands: an extension's `vscode.commands`. */
export interface Commands { "executeCommand": <T>(command: string, ...rest: unknown[]) => PromiseLike<T> }

/** The editor's span annotations, through `commands` (an extension's `vscode.commands`). The bridge's commands answer
 *  `{ value }` or `{ unparsable }`; a command that's missing, fails or answers anything else is `{ unavailable }`. */
export function annotations(commands: Commands) {
	const run = async <T>(command: string, ...rest: unknown[]): Promise<Answer<T>> => {
		try {
			const answer = await commands.executeCommand<unknown>(command, ...rest);

			if (answer !== null && typeof answer === "object" && ("value" in answer || (("unparsable" in answer) && typeof answer.unparsable === "string"))) {
				return answer as Answer<T>;
			}

			return { "unavailable": `${command} answered nothing usable` };
		} catch (error) {
			return { "unavailable": error instanceof Error ? error.message : `${command} failed` };
		}
	};

	return {
		"spans": async (source: string): Promise<Answer<Span[]>> => (source === "" ? { "value": [] } : run<Span[]>("editor.annotations.spans", source)),
		"refer": async (source: string, file: string, ranges: { "start": number; "end": number }[]): Promise<Answer<(SpanRef | undefined)[]>> => (ranges.length === 0 ? { "value": [] } : run<(SpanRef | undefined)[]>("editor.annotations.refer", source, file, ranges)),
		"resolve": async (source: string, file: string, refs: SpanRef[], options: ResolveOptions = {}): Promise<Answer<Resolved[]>> => (refs.length === 0 ? { "value": [] } : run<Resolved[]>("editor.annotations.resolve", source, file, refs, options))
	};
}
