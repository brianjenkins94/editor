// Cosmetic vs semantic change classification, on BABLR's lossless CST.
//
// A change is COSMETIC when it touches only trivia — whitespace, line breaks, indentation, comments — leaving the
// code's structure and tokens identical. Anything else (a changed value, a renamed identifier, added/removed
// syntax) is SEMANTIC. We decide it STRUCTURALLY, not by diffing text: parse both versions with `cstSpans` and
// compare the whole parse's Merkle hash — every node's type over its tokens' text and its children's hashes, with
// trivia never entering one. Equal hashes ⇒ only trivia moved ⇒ cosmetic.
//
// This is the BABLR payoff a text-based git diff can't give: it distinguishes "reindented / recommented" from "the
// meaning changed". Language-agnostic in principle (any BABLR grammar); TS/JS today via lib/grammar.
import { cstSpans, cstSpansAsync } from "./spans";

/** @typedef {"cosmetic" | "semantic" | "unparsable"} ChangeKind */

/**
 * Classify the change from `before` to `after`:
 *   "cosmetic"   — only whitespace/comments differ (structure + tokens identical)
 *   "semantic"   — structure or a token changed
 *   "unparsable" — a side couldn't be parsed (grammar gap or invalid source); the caller should fall back to a
 *                  plain text diff rather than trust a structural verdict.
 * @param {string} before
 * @param {string} after
 * @param {string} production
 * @returns {ChangeKind}
 */
export function classifyChange(before, after, production = "Program") {
	if (before === after) {
		return "cosmetic";
	}

	let a;
	let b;

	try {
		a = cstSpans(before, production).hash;
		b = cstSpans(after, production).hash;
	} catch {
		return "unparsable";
	}

	return a === b ? "cosmetic" : "semantic";
}

/**
 * Yielding variant of {@link classifyChange} for slow parses: paces the BABLR VM (via {@link cstSpansAsync}) so it
 * doesn't monopolise the thread, and is cooperatively cancellable through `options.signal` — on abort the promise
 * rejects with an AbortError (distinct from "unparsable", which the caller should still treat as a real verdict).
 * @param {string} before
 * @param {string} after
 * @param {string} production
 * @param {{ signal?: AbortSignal, budget?: number }} [options]
 * @returns {Promise<ChangeKind>}
 */
export async function classifyChangeAsync(before, after, production = "Program", options = {}) {
	if (before === after) {
		return "cosmetic";
	}

	let a;
	let b;

	try {
		a = (await cstSpansAsync(before, production, options)).hash;
		b = (await cstSpansAsync(after, production, options)).hash;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error; // cancellation is not a verdict — let the caller drop it
		}

		return "unparsable";
	}

	return a === b ? "cosmetic" : "semantic";
}
