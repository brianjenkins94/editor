// Every CST node's source span [start, end), computed by walking the parse tag stream with a running offset. The
// CST is lossless (every source char is a LiteralTag or a self-closing token's literalValue), so the offsets are
// exact; the walk checks that they add up to the source length. This is the CST side of the CST↔tsc span bridge
// (../lib/util/silo/bridge in the lib repo).
//
// Two stream details matter here. (1) A node produced by a SHIFT (member, call, binary, assignment, …) opens in
// the stream AFTER its left operand has already streamed, and re-adopts it through a GapTag at the first field
// reference; its start is therefore the start of the node that closed just before the ShiftTag, not the current
// offset. (2) Trivia is introduced by a `#` reference; everything under it (comments, whitespace) is flagged so
// consumers can build formatting-insensitive views.
import { CloseNodeTag, GapTag, LiteralTag, OpenNodeTag, ReferenceTag, ShiftTag } from "@bablr/agast-helpers/symbols";
import { parseTag, parseTagType } from "@bablr/agast-helpers/tree";
import { m } from "@bablr/helpers/grammar";
import { streamParse } from "bablr";
import TypeScript from "./grammar";

const COVER = Symbol.for("_");

function matcherFor(production) {
	if (production === "Expression") {
		return m`<Expression />`;
	}

	if (production === "Statement") {
		return m`<Statement />`;
	}

	return m`<Program />`;
}

/**
 * @typedef {object} CstSpan
 * @property {string | null} type   production name (`CallExpression`, `Identifier`, …); null for an anonymous token
 * @property {string | null} field  the reference the node was emitted under (`callee`, `openArgumentsToken`, …)
 * @property {number} start  source offset where the node begins (inclusive)
 * @property {number} end    source offset where the node ends (exclusive)
 * @property {boolean} token   a token node (its text is a literal)
 * @property {boolean} cover   a cover node (`<_Expression>` …) — shares its span with the node it wraps
 * @property {boolean} trivia  whitespace/comment (anything under an unnamed `#` reference; `#separatorTokens` are code)
 */

/** Running state for the tag walk, mutated tag-by-tag by `walkTag` and shared by the sync + async drivers. */
function makeWalkState() {
	return {
		"spans": [],
		"stack": [],
		"offset": 0,
		"pendingRef": null, // the ReferenceTag preceding the next open tag
		"triviaDepth": 0, // > 0 while inside a trivia subtree
		"shiftStart": null, // start for nodes opened after a ShiftTag, until the GapTag re-adopts the held node
		"lastClosed": null // last closed non-trivia node (the one a ShiftTag refers to)
	};
}

/** Fold one CST tag into `state` (updates the running offset and pushes completed spans). */
// eslint-disable-next-line complexity -- an inherently branchy dispatch over the CST tag stream; splitting it would obscure the single running-offset invariant it maintains
function walkTag(state, tag, src) {
	const kind = parseTagType(tag);

	if (kind === ReferenceTag) {
		state.pendingRef = parseTag(tag).value;
	} else if (kind === ShiftTag) {
		state.shiftStart = state.lastClosed ? state.lastClosed.start : state.offset;
	} else if (kind === GapTag) {
		state.shiftStart = null;
	} else if (kind === OpenNodeTag) {
		const { value } = parseTag(tag);
		// trivia is what the trivia hook emits under an UNNAMED `#` reference; a named `#` reference such as
		// `#separatorTokens` is a code token the grammar keeps unbound
		const trivia = state.triviaDepth > 0 || (state.pendingRef?.type === "#" && (state.pendingRef.name === null || state.pendingRef.name === undefined));
		const entry = {
			"type": value.name?.description ?? null,
			"field": state.pendingRef?.name ?? null,
			"start": state.shiftStart ?? state.offset,
			"token": Boolean(value.flags?.token),
			"cover": value.type === COVER,
			"trivia": trivia
		};

		state.pendingRef = null;
		if (value.literalValue !== null && value.literalValue !== undefined) {
			// self-closing token: its text is inline
			state.offset += value.literalValue.length;
			state.spans.push({ ...entry, "end": state.offset });
		} else {
			state.stack.push(entry);

			if (trivia) {
				state.triviaDepth += 1;
			}
		}
	} else if (kind === LiteralTag) {
		state.offset += parseTag(tag).value.length;
	} else if (kind === CloseNodeTag) {
		const entry = state.stack.pop();

		if (entry !== undefined) {
			const span = { ...entry, "end": state.offset };

			state.spans.push(span);

			if (entry.trivia) {
				state.triviaDepth -= 1;
			} else {
				state.lastClosed = span;
			}
		}
	}
}

/** @returns {{ spans: CstSpan[], length: number }} spans in close order (children before parents) */
export function cstSpans(src, production = "Program") {
	const state = makeWalkState();

	for (const tag of streamParse(TypeScript, matcherFor(production), src)) {
		walkTag(state, tag, src);
	}

	if (state.offset !== src.length) {
		throw new Error(`cstSpans: walked ${state.offset} characters of a ${src.length}-character source`);
	}

	return { "spans": state.spans, "length": state.offset };
}

/**
 * Yielding variant of {@link cstSpans}: `streamParse` is a lazy tag generator, so pulling one tag at a time and
 * awaiting a macrotask every `budget` tags PACES THE PARSE — the BABLR VM only advances when we pull. That keeps a
 * long parse from monopolising the thread and lets the host process messages between chunks; `signal`, checked at
 * each yield, makes it cooperatively cancellable (throws AbortError) without killing the worker.
 * @param {string} src
 * @param {string} production
 * @param {{ signal?: AbortSignal, budget?: number }} [options]
 * @returns {Promise<{ spans: CstSpan[], length: number }>}
 */
export async function cstSpansAsync(src, production = "Program", options = {}) {
	const { signal, budget = 1500 } = options;

	if (signal?.aborted === true) {
		throw new DOMException("cstSpans aborted", "AbortError");
	}

	const state = makeWalkState();
	let seen = 0;

	for (const tag of streamParse(TypeScript, matcherFor(production), src)) {
		walkTag(state, tag, src);
		seen += 1;

		if (seen % budget === 0) {
			if (signal?.aborted === true) {
				throw new DOMException("cstSpans aborted", "AbortError");
			}

			await new Promise((resolve) => { setTimeout(resolve, 0); });
		}
	}

	if (state.offset !== src.length) {
		throw new Error(`cstSpans: walked ${state.offset} characters of a ${src.length}-character source`);
	}

	return { "spans": state.spans, "length": state.offset };
}
