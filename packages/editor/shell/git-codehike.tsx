import type { AnnotationHandler, HighlightedCode, Tokens } from "codehike/code";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { DiffRowInfo } from "../shared/git-hunks";
import { highlight, InnerLine, Pre } from "codehike/code";
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "theme/components/dropdown";
import "theme/components/dropdown-item";

const roots = new WeakMap<HTMLElement, Root>();

export interface DiffInput {
	"docKey": string;
	"head": string;
	"working": string;
	"lang": string;
	"mode"?: DiffMode;
	"rows": DiffRowInfo[];
	"deselectedRows"?: number[];
	"onRowSelection"?: (deselected: number[]) => void;
	"onDiscardRows"?: (rows: number[]) => void;
}

const ADD_BG = "#2ea04326";
const DEL_BG = "#f8514926";

const SHIKI_THEME = { "light": "github-light", "dark": "github-dark" } as const;

const NON_CODE_COLORS = {
	"dark": new Set(["#a5d6ff", "#8b949e"]),
	"light": new Set(["#0a3069", "#6e7781"])
} as const;

export type DiffMode = "light" | "dark";

const CTX_KEEP = 3;

interface Rendered { "row": number; "type": DiffRowInfo["type"]; "index": number }
interface FoldRegion { "id": string; "startRow": number; "endRow": number; "count": number }
interface FoldHeader { "id": string; "folded": boolean; "count": number }

function tint(type: DiffRowInfo["type"], side: "left" | "right"): string | undefined {
	const changed = side === "left" ? type === "del" || type === "mod" : type === "add" || type === "mod";

	if (!changed) {
		return undefined;
	}

	return side === "left" ? DEL_BG : ADD_BG;
}

function computeFolds(tokens: Tokens, nonCode: ReadonlySet<string>): { "start": number; "end": number }[] {
	const stack: number[] = [];
	const regions: { "start": number; "end": number }[] = [];
	let line = 1;

	for (const token of tokens) {
		const text = typeof token === "string" ? token : token[0];
		const skip = typeof token !== "string" && token[1] !== undefined && nonCode.has(token[1]);

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
	"indexToGrid": Map<number, number>;
}

function foldHeadersOf(rows: DiffRowInfo[], folds: FoldRegion[], folded: ReadonlySet<string>, hidden: (row: number) => boolean): [Map<number, FoldHeader>, Map<number, FoldHeader>] {
	const leftFoldHeaders = new Map<number, FoldHeader>();
	const rightFoldHeaders = new Map<number, FoldHeader>();

	for (const fold of folds) {
		if (!hidden(fold.startRow)) {
			const header: FoldHeader = { "id": fold.id, "folded": folded.has(fold.id), "count": fold.count };
			const row = rows[fold.startRow];

			if (row.leftNo !== undefined) {
				leftFoldHeaders.set(row.leftNo, header);
			}

			if (row.rightNo !== undefined) {
				rightFoldHeaders.set(row.rightNo, header);
			}
		}
	}

	return [leftFoldHeaders, rightFoldHeaders];
}

function buildPlan(
	rows: DiffRowInfo[],
	folds: FoldRegion[],
	expanded: ReadonlySet<string>,
	folded: ReadonlySet<string>
): DiffPlan {
	const hiddenFold = new Set<number>();

	for (const fold of folds) {
		if (folded.has(fold.id)) {
			for (let index = fold.startRow + 1; index <= fold.endRow; index += 1) {
				hiddenFold.add(index);
			}
		}
	}

	const hiddenCollapse = new Set<number>();
	const gapAtFirstRow = new Map<number, { "count": number; "id": string }>();
	let runStart = -1;
	let runLength = 0;

	const flushRun = (endExclusive: number): void => {
		if (runLength - CTX_KEEP * 2 >= 2 && !expanded.has("gap-" + runStart)) {
			const firstHidden = runStart + CTX_KEEP;
			const lastHidden = endExclusive - 1 - CTX_KEEP;

			for (let index = firstHidden; index <= lastHidden; index += 1) {
				hiddenCollapse.add(index);
			}

			gapAtFirstRow.set(firstHidden, { "count": lastHidden - firstHidden + 1, "id": "gap-" + runStart });
		}

		runStart = -1;
		runLength = 0;
	};

	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index].type === "ctx" && !hiddenFold.has(index)) {
			if (runStart < 0) {
				runStart = index;
			}

			runLength += 1;
		} else {
			flushRun(index);
		}
	}

	flushRun(rows.length);

	const leftLineToRow = new Map<number, Rendered>();
	const rightLineToRow = new Map<number, Rendered>();
	const spacers: DiffPlan["spacers"] = [];
	const gaps: DiffPlan["gaps"] = [];
	const indexToGrid = new Map<number, number>();
	let gridRow = 0;

	for (let index = 0; index < rows.length; index += 1) {
		if (!hiddenFold.has(index)) {
			if (hiddenCollapse.has(index)) {
				const gap = gapAtFirstRow.get(index);

				if (gap !== undefined) {
					gridRow += 1;
					gaps.push({ "row": gridRow, "count": gap.count, "id": gap.id });
				}
			} else {
				gridRow += 1;
				indexToGrid.set(index, gridRow);

				const row = rows[index];

				if (row.leftNo !== undefined) {
					leftLineToRow.set(row.leftNo, { "row": gridRow, "type": row.type, "index": index });
				}

				if (row.rightNo !== undefined) {
					rightLineToRow.set(row.rightNo, { "row": gridRow, "type": row.type, "index": index });
				}

				if (row.leftNo === undefined) {
					spacers.push({ "row": gridRow, "side": "left" });
				} else if (row.rightNo === undefined) {
					spacers.push({ "row": gridRow, "side": "right" });
				}
			}
		}
	}

	const [leftFoldHeaders, rightFoldHeaders] = foldHeadersOf(rows, folds, folded, (row) => hiddenFold.has(row) || hiddenCollapse.has(row));

	return { "leftLineToRow": leftLineToRow, "rightLineToRow": rightLineToRow, "spacers": spacers, "gaps": gaps, "leftFoldHeaders": leftFoldHeaders, "rightFoldHeaders": rightFoldHeaders, "indexToGrid": indexToGrid };
}

function foldSlotOf(header: FoldHeader | undefined, onToggleFold: (id: string) => void): ReactNode {
	return createElement("span", { "className": "sxs-fold-slot wa-cluster wa-flex-nowrap wa-align-items-start wa-justify-content-center", "key": "b" }, header !== undefined
		? createElement("button", {
				"className": "sxs-fold",
				"title": header.folded ? "Unfold " + header.count + " lines" : "Fold block",
				"onClick": (event: { "stopPropagation": () => void }) => {
					event.stopPropagation();
					onToggleFold(header.id);
				}
			}, header.folded ? "▸" : "▾")
		: null);
}

function pickSlotOf(at: Rendered, hasFolds: boolean, deselectedRows: ReadonlySet<number>, onToggleRow: (index: number) => void): ReactNode {
	if (at.type !== "ctx") {
		return createElement("button", {
			"className": "sxs-pick wa-cluster wa-flex-nowrap wa-justify-content-center" + (deselectedRows.has(at.index) ? "" : " on"),
			"key": "p",
			"title": deselectedRows.has(at.index) ? "Include this line in the commit" : "Exclude this line from the commit",
			"onClick": (event: { "stopPropagation": () => void }) => {
				event.stopPropagation();
				onToggleRow(at.index);
			}
		}, deselectedRows.has(at.index) ? "" : "✓");
	}

	return hasFolds ? createElement("span", { "className": "sxs-pick sxs-pick-empty", "key": "p" }) : null;
}

function indentStyleOf(indent: number, foldedHeader: FoldHeader | undefined): { "marginLeft": string; "textIndent"?: string } | undefined {
	if (indent > 0) {
		return foldedHeader === undefined
			? { "marginLeft": indent + "ch", "textIndent": "-" + indent + "ch" }
			: { "marginLeft": indent + "ch" };
	}

	return undefined;
}

function sideHandlers(
	side: "left" | "right",
	lineToRow: Map<number, Rendered>,
	foldHeaders: Map<number, FoldHeader> | undefined,
	onToggleFold: (id: string) => void,
	deselectedRows: ReadonlySet<number>,
	onToggleRow: (index: number) => void,
	highlightedLines: ReadonlySet<number>
): AnnotationHandler[] {
	const cols = side === "left" ? "1 / span 2" : "4 / span 2";
	const hasFolds = foldHeaders !== undefined && foldHeaders.size > 0;

	const contents: AnnotationHandler = {
		"name": "sxs-contents",
		// eslint-disable-next-line ts/naming-convention -- codehike's AnnotationHandler slot name
		"Pre": (props: { "children"?: ReactNode }) => createElement("div", { "style": { "display": "contents" } }, props.children)
	};

	const line: AnnotationHandler = {
		"name": "sxs-line",
		// eslint-disable-next-line ts/naming-convention -- codehike's AnnotationHandler slot name
		"Line": (props: { "lineNumber": number; "indentation"?: number }) => {
			const at = lineToRow.get(props.lineNumber);

			if (at === undefined) {
				return null;
			}

			const indent = typeof props.indentation === "number" ? props.indentation : 0;
			const header = foldHeaders?.get(props.lineNumber);

			const rowSelected = at.type !== "ctx" && !deselectedRows.has(at.index);
			const numCell = createElement("span", { "className": "sxs-num wa-cluster wa-flex-nowrap wa-align-items-start wa-gap-3xs" + (rowSelected ? " sel" : ""), "key": "n" }, hasFolds ? foldSlotOf(header, onToggleFold) : null, pickSlotOf(at, hasFolds, deselectedRows, onToggleRow), createElement("span", { "className": "sxs-lineno", "key": "l" }, props.lineNumber));

			const foldedHeader = header?.folded === true ? header : undefined;
			const codeCell = createElement("div", {
				"className": "sxs-code" + (foldedHeader !== undefined ? " folded" : ""),
				"key": "c",
				"style": indentStyleOf(indent, foldedHeader)
			}, createElement(InnerLine, { "merge": props }), foldedHeader !== undefined
				? createElement("span", {
						"className": "sxs-folded-mark",
						"key": "f",
						"title": "Unfold " + foldedHeader.count + " lines",
						"onClick": (event: { "stopPropagation": () => void }) => {
							event.stopPropagation();
							onToggleFold(foldedHeader.id);
						}
					}, " ⋯ }")
				: null);

			const cells = side === "left" ? [codeCell, numCell] : [numCell, codeCell];

			const highlighted = side === "right" && highlightedLines.has(props.lineNumber);

			return createElement("div", {
				"className": "sxs-line " + side + (at.type !== "ctx" ? " chg" : "") + (highlighted ? " hl" : ""),
				"style": {
					"display": "grid",
					"gridTemplateColumns": "subgrid",
					"gridColumn": cols,
					"gridRow": at.row,
					"background": highlighted ? "var(--wa-color-warning-fill-quiet)" : tint(at.type, side)
				}
			}, ...cells);
		}
	};

	return [contents, line];
}

export type HighlightRange = { "start": number; "end": number } | null;

let currentHighlight: HighlightRange = null;
const highlightListeners = new Set<(range: HighlightRange) => void>();

export function setDiffHighlight(range: HighlightRange): void {
	currentHighlight = range;

	for (const listener of highlightListeners) {
		listener(range);
	}
}

function subscribeHighlight(listener: (range: HighlightRange) => void): () => void {
	highlightListeners.add(listener);

	return () => {
		highlightListeners.delete(listener);
	};
}

function hunkState(chosen: number, total: number): "all" | "none" | "partial" {
	if (chosen === total) {
		return "all";
	}

	return chosen === 0 ? "none" : "partial";
}

const HUNK_MARKS = { "all": "✓", "partial": "–", "none": "" } as const;

function Diff(props: {
	"leftCode": HighlightedCode;
	"rightCode": HighlightedCode;
	"rows": DiffRowInfo[];
	"foldRegions": FoldRegion[];
	"contentKey": string;
	"deselectedRows"?: number[];
	"onRowSelection"?: (deselected: number[]) => void;
	"onDiscardRows"?: (rows: number[]) => void;
}): ReactNode {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	const [deselectedRows, setDeselectedRows] = useState<ReadonlySet<number>>(() => new Set(props.deselectedRows));
	const [menu, setMenu] = useState<{ "x": number; "y": number; "rows": number[] } | null>(null);
	const [highlight, setHighlight] = useState<HighlightRange>(currentHighlight);
	const menuRef = useRef<HTMLElement | null>(null);

	useEffect(() => subscribeHighlight(setHighlight), []);

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

	const plan = useMemo(() => buildPlan(props.rows, props.foldRegions, expanded, folded), [props.rows, props.foldRegions, expanded, folded]);

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

	const hunks: { "rows": number[]; "gridStart": number; "gridEnd": number }[] = [];
	let run: number[] = [];

	const flushHunk = (): void => {
		if (run.length > 0) {
			const grids = run.map((index) => plan.indexToGrid.get(index));

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

	const highlightedLines = new Set<number>();

	if (highlight !== null) {
		for (let line = highlight.start; line <= highlight.end; line += 1) {
			highlightedLines.add(line);
		}
	}

	const grid = createElement("div", { "className": "sxs" }, ...hunks.map((hunk) => {
		const chosen = hunk.rows.filter((index) => !deselectedRows.has(index)).length;
		const state = hunkState(chosen, hunk.rows.length);

		return createElement("button", {
			"key": "h" + hunk.gridStart,
			"className": "sxs-hunk wa-cluster wa-flex-nowrap wa-align-items-start wa-justify-content-center " + state,
			"title": (state === "all" ? "Exclude this whole change" : "Include this whole change") + " · right-click to discard",
			"style": { "gridRow": hunk.gridStart + " / " + (hunk.gridEnd + 1) },
			"onClick": () => { toggleHunk(hunk.rows); },
			"onContextMenu": (event: { "preventDefault": () => void; "clientX": number; "clientY": number }) => {
				event.preventDefault();
				setMenu({ "x": event.clientX, "y": event.clientY, "rows": hunk.rows });
			}
		}, HUNK_MARKS[state]);
	}), ...plan.spacers.map((spacer) => createElement("div", {
		"key": "s" + spacer.side + spacer.row,
		"className": "sxs-empty " + spacer.side,
		"style": { "gridColumn": spacer.side === "left" ? "1 / span 2" : "4 / span 2", "gridRow": spacer.row }
	})), ...plan.gaps.map((gap) => createElement("button", {
		"key": gap.id,
		"className": "sxs-gap",
		"style": { "gridRow": gap.row },
		"onClick": () => { expand(gap.id); }
	}, "⋯ " + gap.count + " unchanged lines")), createElement(Pre, { "code": props.leftCode, "handlers": sideHandlers("left", plan.leftLineToRow, plan.leftFoldHeaders, toggleFold, deselectedRows, toggleRow, highlightedLines) }), createElement(Pre, { "code": props.rightCode, "handlers": sideHandlers("right", plan.rightLineToRow, plan.rightFoldHeaders, toggleFold, deselectedRows, toggleRow, highlightedLines) }));

	useEffect(() => {
		const dropdown = menuRef.current;

		if (dropdown === null || menu === null) {
			return undefined;
		}

		const select = (): void => {
			props.onDiscardRows?.(menu.rows);
		};

		const hide = (event: Event): void => {
			if (event.target === dropdown) {
				setMenu(null);
			}
		};

		dropdown.addEventListener("wa-select", select);
		dropdown.addEventListener("wa-after-hide", hide);

		return () => {
			dropdown.removeEventListener("wa-select", select);
			dropdown.removeEventListener("wa-after-hide", hide);
		};
	}, [menu]);

	const menuTrigger = menu === null ? null : createElement("span", { "slot": "trigger", "className": "sxs-menu", "style": { "left": menu.x, "top": menu.y } });
	const menuItem = menu === null ? null : createElement("wa-dropdown-item", { "variant": "danger" }, "Discard this change (" + menu.rows.length + " line" + (menu.rows.length === 1 ? "" : "s") + ")");

	const menuEl = menu === null ? null : createElement("wa-dropdown", { "key": menu.x + "," + menu.y, "ref": menuRef, "open": true, "size": "small", "placement": "bottom-start" }, menuTrigger, menuItem);

	return createElement("div", { "className": "sxs-wrap wa-stack wa-gap-0" }, grid, menuEl);
}

export async function mountDiff(host: HTMLElement, input: DiffInput): Promise<void> {
	const mode: DiffMode = input.mode ?? "dark";
	const theme = SHIKI_THEME[mode];

	const [leftCode, rightCode] = await Promise.all([
		highlight({ "value": input.head, "lang": input.lang, "meta": "" }, theme),
		highlight({ "value": input.working, "lang": input.lang, "meta": "" }, theme)
	]);

	const foldRegions = toFoldRegions(computeFolds(rightCode.tokens, NON_CODE_COLORS[mode]), input.rows);

	let root = roots.get(host);

	if (root === undefined) {
		root = createRoot(host);
		roots.set(host, root);
	}

	const contentKey = input.head.length + ":" + input.working.length + ":" + input.rows.length;

	root.render(createElement(Diff, { "key": input.docKey, "leftCode": leftCode, "rightCode": rightCode, "rows": input.rows, "foldRegions": foldRegions, "contentKey": contentKey, "deselectedRows": input.deselectedRows, "onRowSelection": input.onRowSelection, "onDiscardRows": input.onDiscardRows }));
}
