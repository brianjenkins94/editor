// Every CST node's source span [start, end), read off the agAST tree BABLR parses (treeParse, or the same parse paced:
// cstSpansAsync): an index of the tree for what it doesn't carry — source offsets, where the bridge to tsc's ranges and
// every position the editor keeps meet (../lib/util/silo/bridge in the lib repo), and a content hash per node — in a
// shape a cache can keep (the bablr worker's IndexedDB; a tree can't go there, and reading its CSTML back costs a parse).
// The CST is lossless (every source char is a token's text or a literal), so the offsets are exact; the walk checks
// that they add up to the source length.
//
// The tree's structure is BABLR's: a node's fields are its properties, in order. A field a SHIFT built (a member, a
// call, a binary, an assignment — left-recursive) holds one property per step, each later one the whole expression so
// far, its left operand inside it: the last is the field's node. Trivia is what sits under an unnamed `#` reference
// (comments, whitespace) and is flagged, so consumers can build formatting-insensitive views; a cover node (`_`) shares
// its span with the node it wraps.
//
// Every node gets a MERKLE HASH: a token hashes its production type and its text, any other node its type and its
// children's hashes in order. Trivia never enters a parent's hash, so a reindent or a comment edit leaves every hash
// alone; a node's hash changes exactly when it or something under it does. A code token keeps its text too.
import { freezeRecord } from "@bablr/agast-helpers/object";
import { LiteralTag, NullNode, Property, TreeNode } from "@bablr/agast-helpers/symbols";
import * as Tags from "@bablr/agast-helpers/tags";
import { getOpenTag, parseTag, parseTagType } from "@bablr/agast-helpers/tree";
import { m } from "@bablr/helpers/grammar";
import { streamParse, treeParse } from "bablr";
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

/** A node's parts in order: its children (a shifted field's last step only) and its own literals. */
function partsOfNode(node) {
	const parts = [];

	for (const tag of Tags.traverse(node.value.tags)) {
		if (tag.type === Property) {
			const { reference, node: child, shift } = tag.value;

			// a shift's step replaces the field's step before it: the expression so far, its left operand inside it
			if (shift !== undefined && shift !== null) {
				const at = parts.findLastIndex((part) => part.node !== undefined && !(part.reference?.type === "#" && (part.reference.name === null || part.reference.name === undefined)));

				parts[at] = { "reference": parts[at].reference, "node": child };
			} else {
				parts.push({ "reference": reference, "node": child });
			}
		} else if (parseTagType(tag) === LiteralTag) {
			parts.push({ "literal": parseTag(tag).value });
		}
	}

	return parts;
}

/** Index `node` (under `reference`) from `offset` into `spans`, children before parents; its hash and where it ends. */
function indexNode(node, reference, offset, inTrivia, spans) {
	// trivia is what the trivia hook emits under an UNNAMED `#` reference; a named `#` reference such as
	// `#separatorTokens` is a code token the grammar keeps unbound
	const trivia = inTrivia || (reference?.type === "#" && (reference.name === null || reference.name === undefined));
	const { value } = node;
	const entry = {
		"type": value.name?.description ?? null,
		"field": reference?.name ?? null,
		"start": offset,
		"token": Boolean(value.flags?.token),
		"cover": value.type === COVER,
		"trivia": trivia
	};
	const open = getOpenTag(node);
	const literalValue = open === null || open === undefined ? undefined : parseTag(open).value.literalValue;

	// a self-closing token: its text is inline
	if (literalValue !== null && literalValue !== undefined) {
		const end = offset + literalValue.length;
		const hash = trivia ? null : nodeHash(entry.type, [JSON.stringify(literalValue)]);

		spans.push({ ...entry, "text": trivia || !entry.token ? null : literalValue, "end": end, "hash": hash });

		return { "hash": hash, "end": end, "text": literalValue };
	}

	const hashed = [];
	let text = "";
	let at = offset;

	for (const part of partsOfNode(node)) {
		if (part.literal !== undefined) {
			at += part.literal.length;
			text += part.literal;

			if (!trivia) {
				hashed.push(JSON.stringify(part.literal));
			}
		} else if (part.node?.type === TreeNode) {
			const child = indexNode(part.node, part.reference, at, trivia, spans);
			const childTrivia = trivia || (part.reference?.type === "#" && (part.reference.name === null || part.reference.name === undefined));

			at = child.end;
			text += child.text;

			if (!childTrivia) {
				hashed.push(child.hash);
			}
		} else if (part.node !== undefined && part.node.type !== NullNode) {
			throw new Error(`cstSpans: a ${String(part.node.type?.description ?? part.node.type)} where a node was expected`);
		}
	}

	const hash = trivia ? null : nodeHash(entry.type, hashed);

	spans.push({ ...entry, "text": trivia || !entry.token ? null : text, "end": at, "hash": hash });

	return { "hash": hash, "end": at, "text": text };
}

/** The index of a parse's tree of `src`. */
function indexTree(tree, src) {
	const spans = [];
	const root = indexNode(tree, null, 0, false, spans);

	if (root.end !== src.length) {
		throw new Error(`cstSpans: walked ${root.end} characters of a ${src.length}-character source`);
	}

	return { "spans": spans, "length": root.end, "hash": nodeHash(null, root.hash === null ? [] : [root.hash]) };
}

/** @returns {{ spans: CstSpan[], length: number, hash: string }} spans in close order (children before parents), and the whole parse's hash */
export function cstSpans(src, production = "Program") {
	return indexTree(treeParse(TypeScript, matcherFor(production), src), src);
}

/**
 * Yielding variant of {@link cstSpans}: `streamParse` is a lazy tag generator, so pulling one tag at a time and
 * awaiting a macrotask every `budget` tags PACES THE PARSE — the BABLR VM only advances when we pull. That keeps a
 * long parse from monopolising the thread and lets the host process messages between chunks; `signal`, checked at
 * each yield, makes it cooperatively cancellable (throws AbortError) without killing the worker. The parse is
 * treeParse's (`tree: true`): the tree it returns when its stream ends is indexed as cstSpans indexes treeParse's.
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

	const parse = streamParse(TypeScript, matcherFor(production), src, undefined, freezeRecord({ "tree": true, "emitEffects": false, "spans": null, "holdShiftedNodes": false, "holdUndefinedAttributes": false }))[Symbol.iterator]();
	let step = parse.next();

	for (let seen = 1; step.done !== true; seen += 1) {
		if (seen % budget === 0) {
			if (signal?.aborted === true) {
				throw new DOMException("cstSpans aborted", "AbortError");
			}

			await new Promise((resolve) => { setTimeout(resolve, 0); });
		}

		step = parse.next();
	}

	return indexTree(step.value, src);
}
