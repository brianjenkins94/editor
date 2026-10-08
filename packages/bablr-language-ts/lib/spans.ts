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
//
// The walk also gives every node a MERKLE HASH, bottom-up as the stream closes it: a token hashes its production type
// and its literal text (straight from the tags, never sliced out of the source), any other node hashes its type and its
// children's hashes in order. Trivia never enters a parent's hash, so a reindent or a comment edit leaves every hash
// alone; a node's hash changes exactly when it or something under it does. A shifted node re-adopts its left operand's
// hash where the GapTag re-adopts the operand. A code token keeps its text too — the literals it streamed, read as
// they stream rather than sliced out of the source by offset.
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
 * @property {string | null} hash  the node's Merkle hash (16 hex chars) — type + literal text or child hashes; null for trivia
 * @property {string | null} text  a code token's text, from its literals; null for any other node and for trivia
 */

/** 64 bits (two 32-bit lanes, 16 hex chars) of `text`. A content address for nodes, not a cryptographic one. */
function hash64(text) {
	let h1 = 0xDEADBEEF;
	let h2 = 0x41C6CE57;

	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);

		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** A node's hash from its type and its parts (child hashes, and JSON-quoted literal text so the two can't collide). */
function nodeHash(type, parts) {
	return hash64((type ?? "") + "\0" + parts.join("\0"));
}

/** Running state for the tag walk, mutated tag-by-tag by `walkTag` and shared by the sync + async drivers. */
function makeWalkState() {
	return {
		"spans": [],
		"stack": [],
		"root": { "parts": [] }, // the parts of whatever closes at the top, for the whole parse's hash
		"offset": 0,
		"pendingRef": null, // the ReferenceTag preceding the next open tag
		"triviaDepth": 0, // > 0 while inside a trivia subtree
		"shiftStart": null, // start for nodes opened after a ShiftTag, until the GapTag re-adopts the held node
		"lastClosed": null, // last closed non-trivia node (the one a ShiftTag refers to)
		"held": null, // the hash of that node between the ShiftTag and the GapTag that re-adopts it
		"tokens": [] // the open code tokens, whose text every literal streamed inside them (escapes' too) adds to
	};
}

/** The parts list the next child belongs to: the open node's, or the top's. */
const partsOf = (state) => (state.stack.length === 0 ? state.root : state.stack[state.stack.length - 1]).parts;

/** Add streamed source text to every open code token it falls inside. */
function addText(state, value) {
	for (const token of state.tokens) {
		token.text += value;
	}
}

/** Fold one CST tag into `state` (updates the running offset and pushes completed spans with their hashes). */
// eslint-disable-next-line complexity -- an inherently branchy dispatch over the CST tag stream; splitting it would obscure the single running-offset invariant it maintains
function walkTag(state, tag, src) {
	const kind = parseTagType(tag);

	if (kind === ReferenceTag) {
		state.pendingRef = parseTag(tag).value;
	} else if (kind === ShiftTag) {
		state.shiftStart = state.lastClosed ? state.lastClosed.start : state.offset;

		// the operand closed under the parent; it belongs to the node the shift opens
		if (state.lastClosed !== null) {
			const parts = partsOf(state);
			const at = parts.lastIndexOf(state.lastClosed.hash);

			if (at !== -1) {
				parts.splice(at, 1);
				state.held = state.lastClosed.hash;
			}
		}
	} else if (kind === GapTag) {
		state.shiftStart = null;

		if (state.held !== null) {
			partsOf(state).push(state.held);
			state.held = null;
		}
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
			"trivia": trivia,
			"text": Boolean(value.flags?.token) && !trivia ? "" : null
		};

		state.pendingRef = null;
		if (value.literalValue !== null && value.literalValue !== undefined) {
			// self-closing token: its text is inline
			const hash = trivia ? null : nodeHash(entry.type, [JSON.stringify(value.literalValue)]);

			state.offset += value.literalValue.length;
			state.spans.push({ ...entry, "end": state.offset, "hash": hash, "text": trivia ? null : value.literalValue });
			addText(state, value.literalValue);

			if (!trivia) {
				partsOf(state).push(hash);
			}
		} else {
			const open = { ...entry, "parts": [] };

			state.stack.push(open);

			if (open.text !== null) {
				state.tokens.push(open);
			}

			if (trivia) {
				state.triviaDepth += 1;
			}
		}
	} else if (kind === LiteralTag) {
		const { value } = parseTag(tag);

		state.offset += value.length;
		addText(state, value);

		if (state.triviaDepth === 0) {
			partsOf(state).push(JSON.stringify(value));
		}
	} else if (kind === CloseNodeTag) {
		const entry = state.stack.pop();

		if (entry !== undefined) {
			const { parts, ...node } = entry;

			if (entry.text !== null) {
				state.tokens.pop();
			}

			const span = { ...node, "end": state.offset, "hash": node.trivia ? null : nodeHash(node.type, parts) };

			state.spans.push(span);

			if (entry.trivia) {
				state.triviaDepth -= 1;
			} else {
				state.lastClosed = span;
				partsOf(state).push(span.hash);
			}
		}
	}
}

/** @returns {{ spans: CstSpan[], length: number, hash: string }} spans in close order (children before parents), and the whole parse's hash */
export function cstSpans(src, production = "Program") {
	const state = makeWalkState();

	for (const tag of streamParse(TypeScript, matcherFor(production), src)) {
		walkTag(state, tag, src);
	}

	if (state.offset !== src.length) {
		throw new Error(`cstSpans: walked ${state.offset} characters of a ${src.length}-character source`);
	}

	return { "spans": state.spans, "length": state.offset, "hash": nodeHash(null, state.root.parts) };
}

/**
 * Yielding variant of {@link cstSpans}: `streamParse` is a lazy tag generator, so pulling one tag at a time and
 * awaiting a macrotask every `budget` tags PACES THE PARSE — the BABLR VM only advances when we pull. That keeps a
 * long parse from monopolising the thread and lets the host process messages between chunks; `signal`, checked at
 * each yield, makes it cooperatively cancellable (throws AbortError) without killing the worker.
 * @param {string} src
 * @param {string} production
 * @param {{ signal?: AbortSignal, budget?: number }} [options]
 * @returns {Promise<{ spans: CstSpan[], length: number, hash: string }>}
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

	return { "spans": state.spans, "length": state.offset, "hash": nodeHash(null, state.root.parts) };
}
