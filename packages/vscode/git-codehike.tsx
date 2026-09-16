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
 * COMPOSE for step 3's cosmetic/semantic verdict): a `Pre` handler replaces InnerPre with a `display:contents`
 * wrapper (codehike's own `<pre><div>` wrappers would otherwise trap the lines below the grid), and a `Line` handler
 * places each line as a `subgrid` item at its diff-row track — number gutter + word-wrapped code — with `InnerLine`
 * still rendering the tokens underneath.
 *
 * NOTE (production): shiki is WebAssembly and fetches grammars from lighter.codehike.org at runtime — needs
 * `script-src 'wasm-unsafe-eval'` and `connect-src https://lighter.codehike.org` IF a CSP is ever added (our app
 * sets none today).
 */
import type { AnnotationHandler } from "codehike/code";
import type { ChangeKind } from "./cosmetic-classifier";
import { highlight, InnerLine, Pre } from "codehike/code";
import { createElement, type ReactNode } from "react";
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
}

const ADD_BG = "#2ea04326";
const DEL_BG = "#f8514926";
const COSMETIC_BG = "#8a8a8a26";

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
 * Build the handlers + gutter for one side. `lineToRow` maps a source line number → { grid row, row type }; a line
 * that maps nowhere (the phantom empty line of an empty file) renders nothing.
 */
function sideHandlers(
	side: "left" | "right",
	lineToRow: Map<number, { "row": number; "type": DiffRowInfo["type"] }>,
	verdict: ChangeKind | "none"
): AnnotationHandler[] {
	const cols = side === "left" ? "1 / span 2" : "3 / span 2";

	// Replace InnerPre so the lines aren't wrapped in codehike's <pre><div> (which would sit below the shared grid);
	// display:contents lets each line become a direct grid item of the parent.
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
			// (`ch` == the mono space width; the leading spaces stay in the text via pre-wrap.)
			const indent = typeof props.indentation === "number" ? props.indentation : 0;

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
			createElement("span", { "className": "sxs-num", "key": "n" }, props.lineNumber),
			createElement("div", {
				"className": "sxs-code",
				"key": "c",
				"style": indent > 0 ? { "marginLeft": indent + "ch", "textIndent": "-" + indent + "ch" } : undefined
			}, createElement(InnerLine, { "merge": props })));
		}
	};

	return [contents, line];
}

/** The BABLR verdict banner above the diff (nothing for a non-classified change). */
function banner(verdict: ChangeKind | "none" | undefined): ReactNode {
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

/** Faint fill for the empty half of an add/del row, so the gutter reads as continuous. */
function spacers(rows: DiffRowInfo[]): ReactNode[] {
	const out: ReactNode[] = [];

	rows.forEach((row, index) => {
		const missing = row.leftNo === undefined ? "left" : row.rightNo === undefined ? "right" : undefined;

		if (missing !== undefined) {
			out.push(createElement("div", {
				"key": "s" + String(index),
				"className": "sxs-empty " + missing,
				"style": { "gridColumn": missing === "left" ? "1 / span 2" : "3 / span 2", "gridRow": index + 1 }
			}));
		}
	});

	return out;
}

/** Render (or re-render) the side-by-side diff for one file into `host`. */
export async function mountDiff(host: HTMLElement, input: DiffInput): Promise<void> {
	const leftMap = new Map<number, { "row": number; "type": DiffRowInfo["type"] }>();
	const rightMap = new Map<number, { "row": number; "type": DiffRowInfo["type"] }>();

	input.rows.forEach((row, index) => {
		if (row.leftNo !== undefined) {
			leftMap.set(row.leftNo, { "row": index + 1, "type": row.type });
		}

		if (row.rightNo !== undefined) {
			rightMap.set(row.rightNo, { "row": index + 1, "type": row.type });
		}
	});

	const verdict = input.verdict ?? "none";

	const [leftCode, rightCode] = await Promise.all([
		highlight({ "value": input.head, "lang": input.lang, "meta": "" }, "github-dark"),
		highlight({ "value": input.working, "lang": input.lang, "meta": "" }, "github-dark")
	]);

	const grid = createElement("div", { "className": "sxs" },
		...spacers(input.rows),
		createElement(Pre, { "code": leftCode, "handlers": sideHandlers("left", leftMap, verdict) }),
		createElement(Pre, { "code": rightCode, "handlers": sideHandlers("right", rightMap, verdict) }));

	let root = roots.get(host);

	if (root === undefined) {
		root = createRoot(host);
		roots.set(host, root);
	}

	root.render(createElement("div", { "className": "sxs-wrap" }, banner(verdict), grid));
}

/** Tear down the React root (when the diff pane is emptied). */
export function unmountDiff(host: HTMLElement): void {
	const root = roots.get(host);

	if (root !== undefined) {
		root.unmount();
		roots.delete(host);
	}
}
