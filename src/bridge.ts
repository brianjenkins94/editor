/**
 * silo — the CST ↔ tsc span-alignment bridge. Text is authoritative; both trees are projections of it, aligned
 * by source SPAN. The BABLR CST (from `@brianjenkins94/bablr-language-ts`) is the lossless, annotatable document
 * substrate; the tsc AST (via `@brianjenkins94/tsval/typed`) carries types + drives execution. This maps a CST
 * node's span to its tsc node so an annotation anchored to the CST resolves types/behavior — and, because both
 * reparse from the same text, it re-aligns after an edit (the fault-tolerant recovery model).
 *
 * `prepare` builds the typed program ONCE and answers span queries against it; `align` and `resolve` are the
 * one-shot conveniences on top. Dev-linked to ../tsval and ../bablr-language-ts via tsconfig `paths`; kept out of
 * the CI sweep until those publish.
 */

import { cstSpans } from "@brianjenkins94/bablr";
import { ts } from "@brianjenkins94/tsval";
import { createTypedProgram, typeAtNode } from "@brianjenkins94/tsval/typed";

/** A CST node as the bridge and the anchors see it (the subset of a `cstSpans` span that survives serialization). */
export interface CstNode {
	"type": string;
	"start": number;
	"end": number;
	"token"?: boolean;
}

export interface TscMatch {
	"kind": string;
	"start": number;
	"end": number;
	"type"?: string;
}

export interface Alignment {
	"cst": CstNode;
	"ts"?: TscMatch;
}

interface Positioned {
	"node": ts.Node;
	"start": number;
	"end": number;
}

/** `ts.SyntaxKind[kind]` yields an alias for some kinds (`VariableStatement` reads back as `FirstStatement`); this
 *  table keeps the canonical names. */
const KIND_NAMES = new Map<number, string>();

for (const [name, kind] of Object.entries(ts.SyntaxKind)) {
	if (typeof kind === "number" && !/^(?:First|Last)[A-Z]/u.test(name) && !KIND_NAMES.has(kind)) { KIND_NAMES.set(kind, name); }
}

function kindName(kind: ts.SyntaxKind): string {
	return KIND_NAMES.get(kind) ?? ts.SyntaxKind[kind];
}

/** A plain, resolvable filename for the typed program — TS's `getSourceFile` returns undefined for an arbitrary
 *  absolute path, so collapse to `entry.<ext>` (keeping the extension for TS/TSX handling). */
function tsFileName(fileName: string): string {
	return `entry${/\.[^./\\]+$/u.exec(fileName)?.[0] ?? ".ts"}`;
}

/** All tsc nodes in the source file with their trivia-free spans, pre-order (parent before child, starts ascending). */
function collectNodes(sourceFile: ts.SourceFile): Positioned[] {
	const nodes: Positioned[] = [];
	const visit = (node: ts.Node): void => {
		nodes.push({ "node": node, "start": node.getStart(sourceFile), "end": node.getEnd() });
		node.forEachChild(visit);
	};

	sourceFile.forEachChild(visit);

	return nodes;
}

/** The typed program plus span queries against it. Build once per source text; every query is then cheap. */
export interface Bridge {
	"sourceFile": ts.SourceFile;
	"checker": ts.TypeChecker;
	/** The tightest tsc node whose [start, end) covers the span — for an exact span, the innermost node with it. */
	"at": (start: number, end: number) => ts.Node | undefined;
	/** `at`, rendered as kind + span + resolved type. */
	"match": (start: number, end: number) => TscMatch | undefined;
	/** Every CST node of the text aligned to its tsc node, in one linear sweep. */
	"align": () => Alignment[];
}

export function prepare(src: string, fileName = "entry.ts"): Bridge {
	const { sourceFile, checker } = createTypedProgram(src, tsFileName(fileName));
	const nodes = collectNodes(sourceFile);

	const render = (entry: Positioned): TscMatch => {
		const type = typeAtNode(checker, entry.node);

		return {
			"kind": kindName(entry.node.kind),
			"start": entry.start,
			"end": entry.end,
			"type": type === undefined ? undefined : checker.typeToString(type)
		};
	};

	// Pre-order is ascending by start with parents first, so among the nodes starting at or before `start` the
	// LAST one that still reaches `end` is the innermost container. Binary-search the boundary, scan back from it.
	const entryAt = (start: number, end: number): Positioned | undefined => {
		let low = 0;
		let high = nodes.length;

		while (low < high) {
			const mid = (low + high) >>> 1;

			if (nodes[mid].start <= start) { low = mid + 1; } else { high = mid; }
		}

		for (let i = low - 1; i >= 0; i -= 1) {
			if (nodes[i].end >= end) { return nodes[i]; }
		}

		return undefined;
	};

	const align = (): Alignment[] => {
		const spans = cstSpans(src).spans.map((span, index) => ({ "span": span, "index": index })).sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
		const result: Alignment[] = new Array(spans.length);
		const stack: Positioned[] = []; // the chain of tsc nodes containing the current position
		let next = 0;

		for (const { span, index } of spans) {
			while (next < nodes.length && nodes[next].start <= span.start) {
				while (stack.length > 0 && stack[stack.length - 1].end <= nodes[next].start) { stack.pop(); }
				stack.push(nodes[next]);
				next += 1;
			}

			let k = stack.length - 1;

			while (k >= 0 && stack[k].end < span.end) { k -= 1; }

			const cst: CstNode = { "type": String(span.type ?? "(token)"), "start": span.start, "end": span.end, "token": span.token };

			result[index] = k >= 0 ? { "cst": cst, "ts": render(stack[k]) } : { "cst": cst };
		}

		return result;
	};

	return {
		"sourceFile": sourceFile,
		"checker": checker,
		"at": (start, end) => entryAt(start, end)?.node,
		"match": (start, end) => {
			const entry = entryAt(start, end);

			return entry === undefined ? undefined : render(entry);
		},
		"align": align
	};
}

/** Parse `src` with both grammars and align every CST node to its tsc counterpart (+ resolved type). */
export function align(src: string, fileName = "entry.ts"): Alignment[] {
	return prepare(src, fileName).align();
}

/** Resolve a single CST span to its tsc node kind + type — the query an annotation makes to get semantics.
 *  One-shot: builds a typed program per call; use `prepare` when resolving more than one span of the same text. */
export function resolve(src: string, start: number, end: number, fileName = "entry.ts"): TscMatch | undefined {
	return prepare(src, fileName).match(start, end);
}

// ── snapshot ⊕ patch: the drift between the authoritative text and the CST projection ───────────────────────
//
// The CST is a projection of the text and is allowed to LAG it; the lag is a patch — the edits accumulated since
// the last parse. `openDrift` holds a parsed snapshot plus that drift-patch: `push` records an edit without
// reparsing, `transportSpan`/`at` answer queries in current-text coordinates by carrying the snapshot's spans
// through the drift, and `reparse` collapses the drift into a fresh snapshot. So positions stay correct between
// parses at O(edit) cost, and a reparse is paid lazily — only when a query lands in an edited (touched) zone, or
// on idle — never on every keystroke. `transport`/`mapPos` are the primitive the whole thing (and the anchors
// that ride on the CST — see ./anchor) share.

/** A `cstSpans` span — the fields the projection layer reads (the bablr module documents the full shape). */
export interface Span {
	"type": string | null;
	"start": number;
	"end": number;
	"token": boolean;
	"cover": boolean;
	"trivia": boolean;
}

/** One text edit: replace `[start, end)` with `insert` (`start === end` is a pure insertion, `insert === ""` a
 *  pure deletion). Offsets are in the coordinate space produced by applying all PRIOR edits in the list, so a
 *  sequence of edits compounds left-to-right — the shape an editor's change stream already has (adapt an editor
 *  event's simultaneous, original-coordinate changes by applying them in the order the editor gives). */
export interface Edit {
	"start": number;
	"end": number;
	"insert": string;
}

/** Map one offset from the old snapshot to the new one across a single edit. `bias` decides which side an offset
 *  sitting exactly on an edit boundary sticks to; a span passes "right" for its start and "left" for its end, so
 *  the node stays tight and never absorbs text inserted immediately before or after it. */
export function mapPos(pos: number, edit: Edit, bias: "left" | "right"): number {
	const delta = edit.insert.length - (edit.end - edit.start);

	if (pos < edit.start) { return pos; }
	if (pos > edit.end) { return pos + delta; }
	if (pos === edit.start && bias === "left") { return pos; }
	if (pos === edit.end && bias === "right") { return pos + delta; }

	return bias === "left" ? edit.start : edit.start + edit.insert.length;
}

/** Carry a span from the old snapshot to the new one by folding it through the edits. `touched` is true iff some
 *  edit's range overlapped the span — i.e. the node's own text changed (a mere shift leaves it false). The
 *  overlap test runs in each edit's own (running) coordinate space, before the span is mapped past it. */
export function transport(span: { "start": number; "end": number }, edits: Edit[]): { "span": { "start": number; "end": number }; "touched": boolean } {
	let { start, end } = span;
	let touched = false;

	for (const edit of edits) {
		if (edit.start < end && edit.end > start) { touched = true; }
		start = mapPos(start, edit, "right");
		end = mapPos(end, edit, "left");
	}

	return { "span": { "start": start, "end": end }, "touched": touched };
}

/** The CST node covering the span [start, end) — exact, else tightest-enclosing (the callsite node, not just the
 *  callee token). Covers, trivia and anonymous tokens are skipped. */
export function cstNodeAtSpan(spans: Span[], start: number, end: number): CstNode | undefined {
	let best: CstNode | undefined;
	let bestWidth = Number.POSITIVE_INFINITY;

	for (const span of spans) {
		if (span.cover || span.trivia || span.type === null) { continue; }

		if (span.start <= start && span.end >= end) {
			const width = span.end - span.start;

			if (width < bestWidth) {
				best = { "type": span.type, "start": span.start, "end": span.end };
				bestWidth = width;
			}
		}
	}

	return best;
}

/** A parsed CST snapshot plus the drift-patch accumulated against it. Stateful: `push` mutates the drift,
 *  `reparse` collapses it. `spans`/`src` return the SNAPSHOT (last-parsed) spans and the CURRENT text; queries
 *  that need current-coordinate structure either transport through the drift (`at`, `transportSpan`) or call
 *  `reparse` first. */
export interface DriftingBridge {
	/** the current text — the snapshot with every pushed edit applied. */
	"src": () => string;
	/** the last-parsed snapshot's CST spans (in snapshot coordinates until the next `reparse`). */
	"spans": () => Span[];
	/** the edits accumulated since the last parse (snapshot → current), compounding. */
	"drift": () => Edit[];
	/** record an edit (offsets in current-text coordinates); nothing reparses. */
	"push": (edit: Edit) => void;
	/** carry a snapshot-coordinate span to current coordinates; `touched` ⇒ an edit changed the node's own text. */
	"transportSpan": (span: { "start": number; "end": number }) => { "span": { "start": number; "end": number }; "touched": boolean };
	/** the CST node at a CURRENT-coordinate position — the transported snapshot node, or "drifted" (in a touched
	 *  zone, or no clean node) meaning a `reparse` is needed to answer. */
	"at": (pos: number) => CstNode | "drifted";
	/** collapse the drift: reparse the current text into a fresh snapshot, drift = []. */
	"reparse": () => void;
}

/** Open a drifting bridge over `src`: parse it once as the snapshot, then track edits as a drift-patch. */
export function openDrift(src: string): DriftingBridge {
	let spans = cstSpans(src).spans as Span[];
	let current = src;
	const drift: Edit[] = [];

	return {
		"src": () => current,
		"spans": () => spans,
		"drift": () => drift,
		"push": (edit) => {
			if (edit.start < 0 || edit.end > current.length || edit.start > edit.end) {
				throw new Error(`openDrift.push: edit [${edit.start}, ${edit.end}) out of range for a ${current.length}-char document`);
			}

			current = current.slice(0, edit.start) + edit.insert + current.slice(edit.end);
			drift.push(edit);
		},
		"transportSpan": (span) => transport(span, drift),
		"at": (pos) => {
			let best: CstNode | undefined;
			let bestWidth = Number.POSITIVE_INFINITY;

			for (const span of spans) {
				if (span.cover || span.trivia || span.type === null) { continue; }

				const carried = transport({ "start": span.start, "end": span.end }, drift);

				if (carried.touched || carried.span.start > pos || carried.span.end <= pos) { continue; }

				const width = carried.span.end - carried.span.start;

				if (width < bestWidth) {
					best = { "type": span.type, "start": carried.span.start, "end": carried.span.end };
					bestWidth = width;
				}
			}

			return best ?? "drifted";
		},
		"reparse": () => {
			spans = cstSpans(current).spans as Span[];
			drift.length = 0;
		}
	};
}
