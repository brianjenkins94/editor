// Durable, content-addressed identity for CST SPANS — the anchor annotations attach to.
//
// A span's id is its Merkle hash from the parse (cstSpans): its node type over its literal text or its children's
// hashes, trivia left out. That is:
//  - MOVE-STABLE: it depends only on the span's own subtree, not its position, its file, a base, or history — so the
//    same span moved to another file keeps its id (proven against content-defined chunking, which folds in context and
//    loses this), and two peers derive it identically with no coordination and no full history.
//  - SHIFT-RESISTANT: edits ELSEWHERE don't change a span's subtree, so its id is untouched.
//  - SELF-EDIT AWARE: editing the span itself changes its subtree → new hash → the annotation orphans (which is exactly
//    the "semantic change, flag for review" signal — the cosmetic/semantic interest and durability are one mechanism).
//
// The one inherent weakness of any pure content-address — genuine DUPLICATES (identical subtrees) collide — is
// patched with the MINIMAL possible tie-breaker: a span whose hash is unique keeps it bare (so it tracks moves
// perfectly); only when the same hash occurs more than once do the occurrences get a `#<ordinal>` suffix in document
// order. Unique content (the overwhelming common case) is never disambiguated, so nothing is paid for the common path.
import { cstSpans } from "./spans";

interface Span { "type": string | null; "trivia": boolean; "start": number; "end": number; "hash": string | null }

/** A CST span with its content-addressed, move-stable id. */
export interface SpanAnchor { "type": string | null; "start": number; "end": number; "id": string }

/**
 * The content-addressed anchor id for every non-trivia CST span in `src`, in CST (close) order. Feed a span's `id` to
 * the annotation store; on open, re-derive `spanAnchors(current)` and look the id up to re-attach — no baseline, no
 * base, no history. `cst` is `src`'s parse (cstSpans), when the caller has it already — a cache's, say.
 */
export function spanAnchors(src: string, production = "Program", cst: { "spans": unknown[] } = cstSpans(src, production)): SpanAnchor[] {
	const nodes = (cst.spans as Span[]).filter((span) => !span.trivia);
	const total = new Map<string, number>();

	for (const node of nodes) {
		total.set(node.hash, (total.get(node.hash) ?? 0) + 1);
	}

	const seen = new Map<string, number>();

	return nodes.map((node) => {
		const ordinal = seen.get(node.hash) ?? 0;

		seen.set(node.hash, ordinal + 1);

		// Bare hash when the content is unique (→ tracks moves); `#ordinal` only to disambiguate real duplicates.
		return { "type": node.type, "start": node.start, "end": node.end, "id": total.get(node.hash) === 1 ? node.hash : node.hash + "#" + ordinal };
	});
}

/**
 * The anchor id that best stands for the range [start, end) of `src` — a node another parser found (TypeScript's, say),
 * whose boundaries needn't match BABLR's exactly: the LARGEST BARE-hash span fully inside it (bare = unique content, no
 * `#ordinal`, so it tracks moves without duplicate-ordinal churn), falling back to the span overlapping it most.
 * Punctuation is never a handle. Undefined when nothing overlaps.
 */
export function pickAnchor(anchors: SpanAnchor[], start: number, end: number): string | undefined {
	let inside: { "id": string; "bare": boolean; "size": number } | undefined;
	let overlap: { "id": string; "score": number } | undefined;

	for (const anchor of anchors) {
		if (anchor.type === null) {
			continue;
		}

		const score = Math.max(0, Math.min(anchor.end, end) - Math.max(anchor.start, start));

		if (score <= 0) {
			continue;
		}

		if (anchor.start >= start && anchor.end <= end) {
			const bare = !anchor.id.includes("#");
			const size = anchor.end - anchor.start;

			// bare beats ordinal'd; then larger beats smaller (the node's own top span).
			if (inside === undefined || (bare && !inside.bare) || (bare === inside.bare && size > inside.size)) {
				inside = { "id": anchor.id, "bare": bare, "size": size };
			}
		}

		if (overlap === undefined || score > overlap.score) {
			overlap = { "id": anchor.id, "score": score };
		}
	}

	return (inside ?? overlap)?.id;
}
