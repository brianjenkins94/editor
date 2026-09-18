// Durable, content-addressed identity for CST SPANS — the anchor annotations attach to.
//
// A span's id is a hash of (its node type + its trivia-insensitive token content). That is:
//  - MOVE-STABLE: it depends only on the span's own content, not its position, its file, a base, or history — so the
//    same span moved to another file keeps its id (proven against content-defined chunking, which folds in context and
//    loses this), and two peers derive it identically with no coordination and no full history.
//  - SHIFT-RESISTANT: edits ELSEWHERE don't change a span's content, so its id is untouched.
//  - SELF-EDIT AWARE: editing the span itself changes its content → new id → the annotation orphans (which is exactly
//    the "semantic change, flag for review" signal — the cosmetic/semantic interest and durability are one mechanism).
//
// The one inherent weakness of any pure content-address — genuine DUPLICATES (byte-identical spans) collide — is
// patched with the MINIMAL possible tie-breaker: a span whose content is unique keeps a bare hash (so it tracks moves
// perfectly); only when the same hash occurs more than once do the occurrences get a `#<ordinal>` suffix in document
// order. Unique content (the overwhelming common case) is never disambiguated, so nothing is paid for the common path.
import { cstSpans } from "./spans";

interface Span { "type": string | null; "trivia": boolean; "token": boolean; "start": number; "end": number }

/** A CST span with its content-addressed, move-stable id. */
export interface SpanAnchor { "type": string | null; "start": number; "end": number; "id": string }

/** FNV-1a 64-bit → 16 hex chars. Wide enough for content-addressing here; a shipping version would use a crypto hash. */
function hash64(text: string): string {
	const mask = 0xffffffffffffffffn;
	const prime = 0x100000001b3n;
	let h = 0xcbf29ce484222325n;

	for (let index = 0; index < text.length; index += 1) {
		h ^= BigInt(text.charCodeAt(index));
		h = (h * prime) & mask;
	}

	return h.toString(16).padStart(16, "0");
}

/**
 * The content-addressed anchor id for every non-trivia CST span in `src`, in CST (close) order. Feed a span's `id` to
 * the annotation store; on open, re-derive `spanAnchors(current)` and look the id up to re-attach — no baseline, no
 * base, no history.
 */
export function spanAnchors(src: string, production = "Program"): SpanAnchor[] {
	const spans = cstSpans(src, production).spans as Span[];
	const tokens = spans.filter((span) => span.token && !span.trivia).map((span) => ({ "atom": (span.type ?? "") + "\t" + JSON.stringify(src.slice(span.start, span.end)), "start": span.start, "end": span.end }));

	// A span's trivia-insensitive content = its inner non-trivia token atoms (so reindent / comment edits don't move it).
	const contentOf = (span: Span): string => tokens.filter((token) => token.start >= span.start && token.end <= span.end).map((token) => token.atom).join("\0");
	const nodes = spans.filter((span) => !span.trivia).map((span) => ({ "type": span.type, "start": span.start, "end": span.end, "hash": hash64((span.type ?? "") + "" + contentOf(span)) }));

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
