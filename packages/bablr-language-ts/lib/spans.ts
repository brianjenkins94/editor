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

/** @returns {{ spans: CstSpan[], length: number }} spans in close order (children before parents) */
// eslint-disable-next-line complexity -- an inherently branchy dispatch over the CST tag stream; splitting it would obscure the single running-offset invariant it maintains
export function cstSpans(src, production = "Program") {
	const spans = [];
	const stack = [];
	let offset = 0;
	let pendingRef = null; // the ReferenceTag preceding the next open tag
	let triviaDepth = 0; // > 0 while inside a trivia subtree
	let shiftStart = null; // start to give nodes opened after a ShiftTag, until the GapTag re-adopts the held node
	let lastClosed = null; // last closed non-trivia node (the one a ShiftTag refers to)

	for (const tag of streamParse(TypeScript, matcherFor(production), src)) {
		const kind = parseTagType(tag);

		if (kind === ReferenceTag) {
			pendingRef = parseTag(tag).value;
		} else if (kind === ShiftTag) {
			shiftStart = lastClosed ? lastClosed.start : offset;
		} else if (kind === GapTag) {
			shiftStart = null;
		} else if (kind === OpenNodeTag) {
			const { value } = parseTag(tag);
			// trivia is what the trivia hook emits under an UNNAMED `#` reference; a named `#` reference such as
			// `#separatorTokens` is a code token the grammar keeps unbound
			const trivia = triviaDepth > 0 || (pendingRef?.type === "#" && (pendingRef.name === null || pendingRef.name === undefined));
			const entry = {
				"type": value.name?.description ?? null,
				"field": pendingRef?.name ?? null,
				"start": shiftStart ?? offset,
				"token": Boolean(value.flags?.token),
				"cover": value.type === COVER,
				"trivia": trivia
			};

			pendingRef = null;
			if (value.literalValue !== null && value.literalValue !== undefined) {
				// self-closing token: its text is inline
				offset += value.literalValue.length;
				spans.push({ ...entry, "end": offset });
			} else {
				stack.push(entry);

				if (trivia) {
					triviaDepth += 1;
				}
			}
		} else if (kind === LiteralTag) {
			offset += parseTag(tag).value.length;
		} else if (kind === CloseNodeTag) {
			const entry = stack.pop();

			if (entry !== undefined) {
				const span = { ...entry, "end": offset };

				spans.push(span);

				if (entry.trivia) {
					triviaDepth -= 1;
				} else {
					lastClosed = span;
				}
			}
		}
	}

	if (offset !== src.length) {
		throw new Error(`cstSpans: walked ${offset} characters of a ${src.length}-character source`);
	}

	return { "spans": spans, "length": offset };
}
