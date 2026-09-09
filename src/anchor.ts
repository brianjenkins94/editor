/**
 * silo — anchor findings onto CST nodes, and re-anchor them across text edits. Turns "a finding at offset X"
 * into "a finding on THIS document node" (with its tsc type via ./bridge), so reach/canary/journal results live
 * on the lossless BABLR CST — and survive the text changing out of band.
 *
 * Anchoring: reach (static, positioned) → the CST node at its offset; canary events (runtime) → the CST node at
 * their callsite span (net/fs/exec/eval, now that the canary stamps `start`/`end`) or, matched by capability+
 * callee, they enrich a reach anchor. A runtime finding with neither a matching anchor nor a span FLOATS (env
 * member reads; sneaky constructs with no callsite span).
 *
 * Recovery has two paths, both honouring the review-ratchet (a changed node re-opens the question). When the
 * edits are known — the editor case — `reanchorEdits` carries each anchor's span through the bridge's drift (the
 * `transport` primitive lives in ./bridge, where the CST projection is kept honest against the text): an anchor
 * no edit touched only shifted, so it re-anchors exactly with no reparse; an anchor an edit overlapped is
 * re-resolved against the reparsed CST (same node kind + fingerprint ⇒ relocated, else stale). When only the new
 * text is known — an upstream version, no edit path — `reanchor` falls back to matching each finding's
 * formatting-insensitive `fingerprint` + node type (+ occurrence ordinal), or marks it stale. The drift path is
 * the correct one: it locates by position through the actual edits, so a far-off identical fingerprint can never
 * steal an anchor (the silent mis-anchor that endpoint matching risks — see Zooko's badmerge). Dev-linked to
 * ../tsval and ../bablr-language-ts; kept out of the CI sweep until they publish.
 */

import { cstSpans } from "@brianjenkins94/bablr";
import { type CstNode, cstNodeAtSpan, type Edit, openDrift, prepare, type Span } from "./bridge";
import { ALL_CAPABILITIES, runCanary } from "./canary";
import { findReach } from "@brianjenkins94/util/silo/reach";

export type { CstNode, Edit, Span } from "./bridge";

export interface AnchoredFinding {
	"capability": string;
	"callee": string;
	"cst": CstNode;
	/** formatting-insensitive structural id of the anchored node (for `reanchor`). */
	"fingerprint"?: string;
	/** resolved tsc type at the anchor (via ./bridge). */
	"type"?: string;
	/** from reach (static analysis). */
	"static"?: { "value": string; "safe"?: boolean };
	/** from the canary (runtime-resolved resource — includes values static couldn't see). */
	"runtime"?: { "value": string; "safe"?: boolean };
}

/** A runtime finding with no anchor — no matching static callsite and no callsite span (e.g. an env read). */
export interface FloatingFinding {
	"capability": string;
	"callee": string;
	"runtime": { "value": string; "safe"?: boolean };
}

export interface AnchorReport {
	"anchored": AnchoredFinding[];
	"floating": FloatingFinding[];
}

/** The code-token text within [start, end) — a formatting-insensitive (whitespace- and comment-independent, yet
 *  string-content-preserving) structural id of a CST node. Trivia tokens are dropped, so reformatting or
 *  re-commenting doesn't change it; a value/name edit does. Spans arrive in close order, hence the sort. */
function tokensIn(spans: Span[], src: string, start: number, end: number): string {
	return spans
		.filter((span) => span.token && !span.trivia && span.start >= start && span.end <= end)
		.sort((a, b) => a.start - b.start)
		.map((span) => src.slice(span.start, span.end))
		.join(" ");
}

/** Formatting-insensitive structural id of the CST node covering [start, end). Pass `spans` when fingerprinting
 *  several spans of one text; otherwise the text is parsed per call. */
export function fingerprint(src: string, start: number, end: number, spans: Span[] = cstSpans(src).spans as Span[]): string {
	return tokensIn(spans, src, start, end);
}

/** Anchor reach + canary findings onto CST nodes (typed via the bridge), stamping each with a fingerprint. */
export function anchor(src: string, fileName = "entry.ts"): AnchorReport {
	const spans = cstSpans(src).spans as Span[];
	const bridge = prepare(src, fileName);

	const place = (capability: string, callee: string, node: CstNode | undefined, start: number, end: number): AnchoredFinding => {
		const cst = node ?? { "type": "(unlocated)", "start": start, "end": end };
		const finding: AnchoredFinding = { "capability": capability, "callee": callee, "cst": cst };

		if (node !== undefined) {
			finding.fingerprint = tokensIn(spans, src, node.start, node.end);
			finding.type = bridge.match(node.start, node.end)?.type;
		}

		return finding;
	};

	const anchored: AnchoredFinding[] = findReach(fileName, src).map((reach) => {
		const finding = place(reach.capability, reach.callee, cstNodeAtSpan(spans, reach.start, reach.end), reach.start, reach.end);

		finding.static = { "value": reach.value, "safe": reach.safe };

		return finding;
	});

	const floating: FloatingFinding[] = [];
	const enriched = new Set<number>();

	for (const event of runCanary(src, { "predicted": [...ALL_CAPABILITIES], "fileName": fileName }).observed) {
		// Match a runtime event to a static anchor by callee, or (since both now carry spans) by the event's
		// callsite falling within the anchor's node — reach and the canary render callees differently
		// (`writeFile` vs `fs.writeFile`), so span containment is the reliable join.
		const index = anchored.findIndex((finding, i) => !enriched.has(i) && finding.capability === event.capability
			&& (finding.callee === event.callee
				|| (event.start !== undefined && event.end !== undefined && event.start >= finding.cst.start && event.end <= finding.cst.end)));

		if (index !== -1) {
			enriched.add(index);
			anchored[index].runtime = { "value": event.value, "safe": event.safe };
			// Upgrade the (point-anchored) reach finding to the whole callsite node the canary spanned, so its
			// fingerprint covers the value.
			if (event.start !== undefined && event.end !== undefined) {
				const node = cstNodeAtSpan(spans, event.start, event.end);

				if (node !== undefined) {
					anchored[index].cst = node;
					anchored[index].fingerprint = tokensIn(spans, src, node.start, node.end);
					anchored[index].type = bridge.match(node.start, node.end)?.type;
				}
			}
		} else if (event.start !== undefined && event.end !== undefined) {
			// A runtime finding reach didn't produce (e.g. a computed URL) but the canary stamped its callsite —
			// anchor it directly to the callsite node.
			const finding = place(event.capability, event.callee, cstNodeAtSpan(spans, event.start, event.end), event.start, event.end);

			finding.runtime = { "value": event.value, "safe": event.safe };
			anchored.push(finding);
		} else {
			floating.push({ "capability": event.capability, "callee": event.callee, "runtime": { "value": event.value, "safe": event.safe } });
		}
	}

	return { "anchored": anchored, "floating": floating };
}

export interface Reanchored {
	"finding": AnchoredFinding;
	"status": "anchored" | "stale";
	/** the node in the edited source the finding re-anchored to (absent when stale). */
	"cst"?: CstNode;
}

/** Re-locate anchored findings in an edited source by fingerprint + node type (+ occurrence ordinal, taken in
 *  document order), else mark them stale. Candidates are the new text's non-cover, non-trivia nodes, one per
 *  distinct span — a cover shares its inner node's span and would otherwise count as a second occurrence. */
export function reanchor(findings: AnchoredFinding[], newSrc: string): Reanchored[] {
	const newSpans = cstSpans(newSrc).spans as Span[];
	const keyOf = (type: string, fp: string): string => `${type} ${fp}`;
	const byKey = new Map<string, CstNode[]>();
	const seen = new Set<string>();

	for (const span of [...newSpans].sort((a, b) => a.start - b.start || b.end - a.end)) {
		if (span.cover || span.trivia || span.type === null) { continue; }

		const where = `${span.start}-${span.end}`;

		if (seen.has(where)) { continue; }

		seen.add(where);

		const node: CstNode = { "type": span.type, "start": span.start, "end": span.end };
		const key = keyOf(span.type, tokensIn(newSpans, newSrc, span.start, span.end));
		const list = byKey.get(key);

		if (list === undefined) { byKey.set(key, [node]); } else { list.push(node); }
	}

	// Consume candidates in the ORIGINAL findings' document order, so the n-th identical finding takes the n-th
	// identical node; results go back in the caller's order.
	const order = findings.map((finding, index) => ({ finding, index })).sort((a, b) => a.finding.cst.start - b.finding.cst.start);
	const consumed = new Map<string, number>();
	const results: Reanchored[] = new Array<Reanchored>(findings.length);

	for (const { finding, index } of order) {
		const key = finding.fingerprint === undefined ? undefined : keyOf(finding.cst.type, finding.fingerprint);
		const candidates = key === undefined ? undefined : byKey.get(key);
		const ordinal = key === undefined ? 0 : consumed.get(key) ?? 0;

		if (key === undefined || candidates === undefined || ordinal >= candidates.length) {
			results[index] = { "finding": finding, "status": "stale" };
			continue;
		}

		consumed.set(key, ordinal + 1);
		results[index] = { "finding": finding, "status": "anchored", "cst": candidates[ordinal] };
	}

	return results;
}

// ── the editor recovery path: re-anchor through the bridge's drift (one projection-maintenance path) ──────────

/** Re-anchor findings across a KNOWN edit list (the editor path), reading through the bridge's drift so there is
 *  a single projection-maintenance path. Open a drift on the snapshot the findings were anchored to, replay the
 *  edits, then: an anchor no edit touched only shifted — re-anchored exactly to its transported span, no reparse;
 *  an anchor an edit overlapped is re-resolved against the reparsed CST (same node kind + fingerprint, formatting
 *  aside ⇒ relocated; anything else stale, the ratchet re-opening the question). The drift reparses at most once,
 *  and only if some anchor was actually touched. */
export function reanchorEdits(findings: AnchoredFinding[], snapshotSrc: string, edits: Edit[]): Reanchored[] {
	const bridge = openDrift(snapshotSrc);

	for (const edit of edits) { bridge.push(edit); }

	const transported = findings.map((finding) => ({ "finding": finding, ...bridge.transportSpan(finding.cst) }));

	if (transported.some((entry) => entry.touched)) { bridge.reparse(); }

	const spans = bridge.spans();
	const src = bridge.src();

	return transported.map(({ finding, span, touched }): Reanchored => {
		if (!touched) {
			return { "finding": finding, "status": "anchored", "cst": { "type": finding.cst.type, "start": span.start, "end": span.end } };
		}

		const node = cstNodeAtSpan(spans, span.start, span.end);

		return node !== undefined && node.type === finding.cst.type && tokensIn(spans, src, node.start, node.end) === finding.fingerprint
			? { "finding": finding, "status": "anchored", "cst": node }
			: { "finding": finding, "status": "stale" };
	});
}
