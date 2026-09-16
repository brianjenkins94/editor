/**
 * CodeHike diff island — the React + codehike + shiki renderer for the review panel's diff dialog.
 *
 * LAZY-LOADED: git-panel.ts (vanilla) `import("./git-codehike")` only on the first diff click, so codehike + shiki
 * + react-dom stay out of the shell's initial bundle. Uses `createElement` (not JSX) throughout, so it needs no JSX
 * pragma and doesn't clash with the shell's preact JSX config — only this file pulls React.
 *
 * SIDE-BY-SIDE (step 2): HEAD on the left, working tree on the right, aligned ROW-BY-ROW by the diff. The two sides
 * share ONE CSS grid so a row's height is the taller of its two cells — which is what makes alignment survive word
 * wrap. We get there through codehike's handler slots rather than hand-rolling tokens (so AnnotationHandlers still
 * COMPOSE): a `Pre` handler replaces InnerPre with a `display:contents` wrapper (codehike's own `<pre><div>` would
 * otherwise trap the lines below the grid), and a `Line` handler places each line as a `subgrid` item — number
 * gutter + word-wrapped code — with `InnerLine` still rendering the tokens underneath.
 *
 * COLLAPSING: two kinds, both hide rows and reassign grid tracks.
 *   1. Context folding — long runs of UNCHANGED rows collapse to a clickable "⋯ N unchanged lines" gap. Pure diff
 *      data, no parser.
 *   2. Block folding — `{ … }` regions found by scanning the working tokens for brace DEPTH (skipping braces inside
 *      strings/comments by their github-dark colour), foldable from a gutter chevron. Token-based, so a brace in a
 *      string doesn't miscount; no parser / BABLR needed.
 *
 * NOTE (production): shiki is WebAssembly and fetches grammars from lighter.codehike.org at runtime — needs
 * `script-src 'wasm-unsafe-eval'` and `connect-src https://lighter.codehike.org` IF a CSP is ever added (our app
 * sets none today).
 */
import type { AnnotationHandler, HighlightedCode, Tokens } from "codehike/code";
import type { ChangeKind } from "./cosmetic-classifier";
import { highlight, InnerLine, Pre } from "codehike/code";
import { createElement, type ReactNode, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** One React root per host element, reused across diff switches (root.render updates in place). */
const roots = new WeakMap<HTMLElement, Root>();

/** A diff row already aligned by git-panel: `ctx` unchanged, `add`/`del` single-side, `mod` a paired change. */
export interface DiffRowInfo {
	"type": "ctx" | "add" | "del" | "mod";
	/** 1-based HEAD line number, when this row has a left side. */
	"leftNo"?: number;
	/** 1-based working-tree line number, when this row has a right side. */
	"rightNo"?: number;
}

export interface DiffInput {
	/** Stable identity for this file (its path) — resets fold/expand state when a different file is opened. */
	"docKey": string;
	/** HEAD file contents (left column). Empty for an added file. */
	"head": string;
	/** Working-tree file contents (right column). Empty for a deleted file. */
	"working": string;
	/** shiki language id (from the file extension). */
	"lang": string;
	/** The aligned diff rows, in display order. */
	"rows": DiffRowInfo[];
	/** BABLR's verdict for the whole change ("none" when not a modified code file). */
	"verdict"?: ChangeKind | "none";
	/** Row indices (into `rows`) the reviewer has UN-checked for commit — the initial per-line selection. */
	"deselectedRows"?: number[];
	/** Called when the per-line selection changes, with the new deselected row indices. */
	"onRowSelection"?: (deselected: number[]) => void;
}

const ADD_BG = "#2ea04326";
const DEL_BG = "#f8514926";
const COSMETIC_BG = "#8a8a8a26";

/** github-dark colours for string & comment tokens — braces inside these don't count toward block depth. */
const NON_CODE_COLORS = new Set(["#a5d6ff", "#8b949e"]);

/** Collapse an unchanged run longer than this, keeping CTX_KEEP rows of context at each end. */
const CTX_KEEP = 3;

interface Rendered { "row": number; "type": DiffRowInfo["type"]; "index": number }
interface FoldRegion { "id": string; "startRow": number; "endRow": number; "count": number }
interface FoldHeader { "id": string; "folded": boolean; "count": number }

/**
 * Background tint for a line. A `cosmetic` verdict (whitespace/comments only) mutes every changed line to grey, so
 * the reviewer's eye isn't pulled to changes that don't move the meaning; otherwise del/mod is red, add/mod green.
 */
function tint(type: DiffRowInfo["type"], side: "left" | "right", verdict: ChangeKind | "none"): string | undefined {
	const changed = side === "left" ? type === "del" || type === "mod" : type === "add" || type === "mod";

	if (!changed) {
		return undefined;
	}

	if (verdict === "cosmetic") {
		return COSMETIC_BG;
	}

	return side === "left" ? DEL_BG : ADD_BG;
}

/**
 * Brace-depth scan over the highlighted WORKING tokens → `{ … }` regions spanning >1 line. Skips braces inside
 * string/comment tokens (by colour) so `"{"` or `// {` don't open a phantom region; still advances the line counter
 * through them so multi-line strings don't desync. Regions map to working line numbers (1-based).
 */
function computeFolds(tokens: Tokens): { "start": number; "end": number }[] {
	const stack: number[] = [];
	const regions: { "start": number; "end": number }[] = [];
	let line = 1;

	for (const token of tokens) {
		const text = typeof token === "string" ? token : token[0];
		const skip = typeof token !== "string" && token[1] !== undefined && NON_CODE_COLORS.has(token[1]);

		for (const ch of text) {
			if (ch === "\n") {
				line += 1;
			} else if (!skip && ch === "{") {
				stack.push(line);
			} else if (!skip && ch === "}") {
				const open = stack.pop();

				if (open !== undefined && open < line) {
					regions.push({ "start": open, "end": line });
				}
			}
		}
	}

	return regions;
}

/** Turn working-line brace regions into row-index regions (only those whose start & end rows both exist). */
function toFoldRegions(regions: { "start": number; "end": number }[], rows: DiffRowInfo[]): FoldRegion[] {
	const rightToRow = new Map<number, number>();

	rows.forEach((row, index) => {
		if (row.rightNo !== undefined) {
			rightToRow.set(row.rightNo, index);
		}
	});

	const out: FoldRegion[] = [];
	const seen = new Set<string>();

	for (const { start, end } of regions) {
		const startRow = rightToRow.get(start);
		const endRow = rightToRow.get(end);
		const id = start + "-" + end;

		if (startRow !== undefined && endRow !== undefined && endRow > startRow && !seen.has(id)) {
			seen.add(id);
			out.push({ "id": id, "startRow": startRow, "endRow": endRow, "count": endRow - startRow });
		}
	}

	return out;
}

interface DiffPlan {
	"leftLineToRow": Map<number, Rendered>;
	"rightLineToRow": Map<number, Rendered>;
	"spacers": { "row": number; "side": "left" | "right" }[];
	"gaps": { "row": number; "count": number; "id": string }[];
	"leftFoldHeaders": Map<number, FoldHeader>;
	"rightFoldHeaders": Map<number, FoldHeader>;
	/** Visible changed row index → its grid track, for grouping hunks and placing the center bar. */
	"indexToGrid": Map<number, number>;
}

/**
 * Resolve rows + fold regions + user toggles into a render plan: which grid track each visible line lands on, where
 * the gap and empty-side filler go, and which right-hand lines carry a fold chevron. Block folds are applied first,
 * then unchanged runs are collapsed among whatever rows remain visible.
 */
function buildPlan(
	rows: DiffRowInfo[],
	folds: FoldRegion[],
	expanded: ReadonlySet<string>,
	folded: ReadonlySet<string>
): DiffPlan {
	const hiddenFold = new Set<number>();

	for (const fold of folds) {
		if (folded.has(fold.id)) {
			for (let r = fold.startRow + 1; r <= fold.endRow; r += 1) {
				hiddenFold.add(r);
			}
		}
	}

	// Collapse runs of unchanged rows that survive folding.
	const hiddenCollapse = new Set<number>();
	const gapAtFirstRow = new Map<number, { "count": number; "id": string }>();
	let runStart = -1;
	let runLength = 0;

	const flushRun = (endExclusive: number): void => {
		if (runLength - CTX_KEEP * 2 >= 2 && !expanded.has("gap-" + runStart)) {
			const firstHidden = runStart + CTX_KEEP;
			const lastHidden = endExclusive - 1 - CTX_KEEP;

			for (let r = firstHidden; r <= lastHidden; r += 1) {
				hiddenCollapse.add(r);
			}

			gapAtFirstRow.set(firstHidden, { "count": lastHidden - firstHidden + 1, "id": "gap-" + runStart });
		}

		runStart = -1;
		runLength = 0;
	};

	for (let r = 0; r < rows.length; r += 1) {
		if (rows[r].type === "ctx" && !hiddenFold.has(r)) {
			if (runStart < 0) {
				runStart = r;
			}

			runLength += 1;
		} else {
			flushRun(r);
		}
	}

	flushRun(rows.length);

	// Assign grid tracks to the rows that remain, emitting one track per gap.
	const leftLineToRow = new Map<number, Rendered>();
	const rightLineToRow = new Map<number, Rendered>();
	const spacers: DiffPlan["spacers"] = [];
	const gaps: DiffPlan["gaps"] = [];
	const indexToGrid = new Map<number, number>();
	let gridRow = 0;

	for (let r = 0; r < rows.length; r += 1) {
		if (hiddenFold.has(r)) {
			continue;
		}

		if (hiddenCollapse.has(r)) {
			const gap = gapAtFirstRow.get(r);

			if (gap !== undefined) {
				gridRow += 1;
				gaps.push({ "row": gridRow, "count": gap.count, "id": gap.id });
			}

			continue;
		}

		gridRow += 1;
		indexToGrid.set(r, gridRow);

		const row = rows[r];

		if (row.leftNo !== undefined) {
			leftLineToRow.set(row.leftNo, { "row": gridRow, "type": row.type, "index": r });
		}

		if (row.rightNo !== undefined) {
			rightLineToRow.set(row.rightNo, { "row": gridRow, "type": row.type, "index": r });
		}

		if (row.leftNo === undefined) {
			spacers.push({ "row": gridRow, "side": "left" });
		} else if (row.rightNo === undefined) {
			spacers.push({ "row": gridRow, "side": "right" });
		}
	}

	// Chevrons on the visible header rows only — on BOTH gutters (either toggles the same region), wherever that
	// header row has a line on that side.
	const leftFoldHeaders = new Map<number, FoldHeader>();
	const rightFoldHeaders = new Map<number, FoldHeader>();

	for (const fold of folds) {
		if (hiddenFold.has(fold.startRow) || hiddenCollapse.has(fold.startRow)) {
			continue;
		}

		const header: FoldHeader = { "id": fold.id, "folded": folded.has(fold.id), "count": fold.count };
		const row = rows[fold.startRow];

		if (row.leftNo !== undefined) {
			leftFoldHeaders.set(row.leftNo, header);
		}

		if (row.rightNo !== undefined) {
			rightFoldHeaders.set(row.rightNo, header);
		}
	}

	return { "leftLineToRow": leftLineToRow, "rightLineToRow": rightLineToRow, "spacers": spacers, "gaps": gaps, "leftFoldHeaders": leftFoldHeaders, "rightFoldHeaders": rightFoldHeaders, "indexToGrid": indexToGrid };
}

/** The BABLR verdict banner above the diff (nothing for a non-classified change). */
function banner(verdict: ChangeKind | "none"): ReactNode {
	const label = verdict === "cosmetic" ? "Cosmetic change — whitespace & comments only"
		: verdict === "semantic" ? "Semantic change"
			: verdict === "unparsable" ? "Couldn’t parse — showing the raw text diff"
				: undefined;

	if (label === undefined) {
		return null;
	}

	return createElement("div", { "className": "sxs-verdict " + verdict },
		createElement("span", { "className": "sxs-dot" }), label);
}

/** Build the codehike handlers for one side: a display:contents Pre wrapper + a subgrid Line placer. */
function sideHandlers(
	side: "left" | "right",
	lineToRow: Map<number, Rendered>,
	verdict: ChangeKind | "none",
	foldHeaders: Map<number, FoldHeader> | undefined,
	onToggleFold: (id: string) => void,
	deselectedRows: ReadonlySet<number>,
	onToggleRow: (index: number) => void
): AnnotationHandler[] {
	const cols = side === "left" ? "1 / span 2" : "4 / span 2";

	const contents: AnnotationHandler = {
		"name": "sxs-contents",
		"Pre": (props: { "children"?: ReactNode }) =>
			createElement("div", { "style": { "display": "contents" } }, props.children)
	};

	const line: AnnotationHandler = {
		"name": "sxs-line",
		"Line": (props: { "lineNumber": number; "indentation"?: number }) => {
			const at = lineToRow.get(props.lineNumber);

			if (at === undefined) {
				return null;
			}

			// Word wrap that hangs at the line's own indent level (codehike's recipe): shift the whole line right by
			// its indentation, then pull the first row back by the same amount with a negative text-indent — so the
			// first row's leading whitespace still lands where it should while every WRAPPED row hangs under the code.
			const indent = typeof props.indentation === "number" ? props.indentation : 0;
			const header = foldHeaders?.get(props.lineNumber);

			return createElement("div", {
				"className": "sxs-line " + side,
				"style": {
					"display": "grid",
					"gridTemplateColumns": "subgrid",
					"gridColumn": cols,
					"gridRow": at.row,
					"background": tint(at.type, side, verdict)
				}
			},
			createElement("span", { "className": "sxs-num", "key": "n" },
				at.type !== "ctx"
					? createElement("button", {
						"className": "sxs-pick" + (deselectedRows.has(at.index) ? "" : " on"),
						"key": "p",
						"title": deselectedRows.has(at.index) ? "Include this line in the commit" : "Exclude this line from the commit",
						"onClick": (event: { "stopPropagation": () => void }) => { event.stopPropagation(); onToggleRow(at.index); }
					}, deselectedRows.has(at.index) ? "" : "✓")
					: null,
				header !== undefined
					? createElement("button", {
						"className": "sxs-fold",
						"key": "b",
						"title": header.folded ? "Unfold " + header.count + " lines" : "Fold block",
						"onClick": (event: { "stopPropagation": () => void }) => { event.stopPropagation(); onToggleFold(header.id); }
					}, header.folded ? "▸" : "▾")
					: null,
				createElement("span", { "className": "sxs-lineno", "key": "l" }, props.lineNumber)),
			createElement("div", {
				"className": "sxs-code",
				"key": "c",
				"style": indent > 0 ? { "marginLeft": indent + "ch", "textIndent": "-" + indent + "ch" } : undefined
			},
			createElement(InnerLine, { "merge": props }),
			header?.folded === true ? createElement("span", { "className": "sxs-folded-mark", "key": "f" }, " ⋯") : null));
		}
	};

	return [contents, line];
}

/** The interactive diff: highlighted code in, fold/expand state held here, one shared grid out. */
function Diff(props: {
	"leftCode": HighlightedCode;
	"rightCode": HighlightedCode;
	"rows": DiffRowInfo[];
	"verdict": ChangeKind | "none";
	"foldRegions": FoldRegion[];
	"contentKey": string;
	"deselectedRows"?: number[];
	"onRowSelection"?: (deselected: number[]) => void;
}): ReactNode {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const [deselectedRows, setDeselectedRows] = useState<ReadonlySet<number>>(() => new Set(props.deselectedRows));

	// Reset the per-line selection when the file's CONTENT changes (e.g. after a partial commit) while the same file
	// stays open — the component isn't remounted then (its key is the path), so adopt the fresh selection here. Fold
	// and expand state deliberately survive an ordinary refresh.
	const lastContentKey = useRef(props.contentKey);

	if (lastContentKey.current !== props.contentKey) {
		lastContentKey.current = props.contentKey;
		setDeselectedRows(new Set(props.deselectedRows));
	}

	const toggleRow = (index: number): void => {
		const next = new Set(deselectedRows);

		if (!next.delete(index)) {
			next.add(index);
		}

		setDeselectedRows(next);
		props.onRowSelection?.([...next]);
	};

	const plan = useMemo(() => buildPlan(props.rows, props.foldRegions, expanded, folded),
		[props.rows, props.foldRegions, expanded, folded]);

	const toggleFold = (id: string): void => {
		setFolded((prev) => {
			const next = new Set(prev);

			if (!next.delete(id)) {
				next.add(id);
			}

			return next;
		});
	};

	const expand = (id: string): void => {
		setExpanded((prev) => new Set(prev).add(id));
	};

	// Group consecutive visible changed rows into hunks; each gets a center bar that toggles the whole change.
	const hunks: { "rows": number[]; "gridStart": number; "gridEnd": number }[] = [];
	let run: number[] = [];

	const flushHunk = (): void => {
		if (run.length > 0) {
			const grids = run.map((index) => plan.indexToGrid.get(index)!);

			hunks.push({ "rows": run, "gridStart": Math.min(...grids), "gridEnd": Math.max(...grids) });
		}

		run = [];
	};

	props.rows.forEach((row, index) => {
		if (row.type !== "ctx" && plan.indexToGrid.has(index)) {
			run.push(index);
		} else {
			flushHunk();
		}
	});

	flushHunk();

	const toggleHunk = (rowsInHunk: number[]): void => {
		const allSelected = rowsInHunk.every((index) => !deselectedRows.has(index));
		const next = new Set(deselectedRows);

		for (const index of rowsInHunk) {
			if (allSelected) {
				next.add(index);
			} else {
				next.delete(index);
			}
		}

		setDeselectedRows(next);
		props.onRowSelection?.([...next]);
	};

	const grid = createElement("div", { "className": "sxs" },
		...hunks.map((hunk) => {
			const chosen = hunk.rows.filter((index) => !deselectedRows.has(index)).length;
			const state = chosen === hunk.rows.length ? "all" : chosen === 0 ? "none" : "partial";

			return createElement("button", {
				"key": "h" + hunk.gridStart,
				"className": "sxs-hunk " + state,
				"title": state === "all" ? "Exclude this whole change" : "Include this whole change",
				"style": { "gridRow": hunk.gridStart + " / " + (hunk.gridEnd + 1) },
				"onClick": () => { toggleHunk(hunk.rows); }
			}, state === "all" ? "✓" : state === "partial" ? "–" : "");
		}),
		...plan.spacers.map((spacer) => createElement("div", {
			"key": "s" + spacer.side + spacer.row,
			"className": "sxs-empty " + spacer.side,
			"style": { "gridColumn": spacer.side === "left" ? "1 / span 2" : "4 / span 2", "gridRow": spacer.row }
		})),
		...plan.gaps.map((gap) => createElement("button", {
			"key": gap.id,
			"className": "sxs-gap",
			"style": { "gridRow": gap.row },
			"onClick": () => { expand(gap.id); }
		}, "⋯ " + gap.count + " unchanged lines")),
		createElement(Pre, { "code": props.leftCode, "handlers": sideHandlers("left", plan.leftLineToRow, props.verdict, plan.leftFoldHeaders, toggleFold, deselectedRows, toggleRow) }),
		createElement(Pre, { "code": props.rightCode, "handlers": sideHandlers("right", plan.rightLineToRow, props.verdict, plan.rightFoldHeaders, toggleFold, deselectedRows, toggleRow) }));

	return createElement("div", { "className": "sxs-wrap" }, banner(props.verdict), grid);
}

/** Render (or re-render) the side-by-side diff for one file into `host`. */
export async function mountDiff(host: HTMLElement, input: DiffInput): Promise<void> {
	const verdict = input.verdict ?? "none";

	const [leftCode, rightCode] = await Promise.all([
		highlight({ "value": input.head, "lang": input.lang, "meta": "" }, "github-dark"),
		highlight({ "value": input.working, "lang": input.lang, "meta": "" }, "github-dark")
	]);

	const foldRegions = toFoldRegions(computeFolds(rightCode.tokens), input.rows);

	let root = roots.get(host);

	if (root === undefined) {
		root = createRoot(host);
		roots.set(host, root);
	}

	// `key` = the file path: switching files remounts Diff with fresh fold/expand state; re-showing the same file
	// (e.g. after a git.changed refresh) reuses it, so the reviewer's collapsed regions survive the refresh.
	// A cheap identity for the file's content — changes after a (partial) commit so the diff re-adopts the selection.
	const contentKey = input.head.length + ":" + input.working.length + ":" + input.rows.length;

	root.render(createElement(Diff, { "key": input.docKey, "leftCode": leftCode, "rightCode": rightCode, "rows": input.rows, "verdict": verdict, "foldRegions": foldRegions, "contentKey": contentKey, "deselectedRows": input.deselectedRows, "onRowSelection": input.onRowSelection }));
}

/** Tear down the React root (when the diff pane is emptied). */
export function unmountDiff(host: HTMLElement): void {
	const root = roots.get(host);

	if (root !== undefined) {
		root.unmount();
		roots.delete(host);
	}
}
