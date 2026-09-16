/**
 * CodeHike diff island — the React + codehike + shiki renderer for the review panel's diff pane.
 *
 * LAZY-LOADED: git-panel.ts (vanilla) `import("./git-codehike")` only on the first diff click, so codehike + shiki
 * + react-dom stay out of the shell's initial bundle. Uses `createElement` (not JSX) throughout, so it needs no JSX
 * pragma and doesn't clash with the shell's preact JSX config — only this file pulls React. Built on codehike's
 * `<Pre>` + `InnerLine` so AnnotationHandlers COMPOSE (the whole point vs. hand-rolling tokens): word-wrap today,
 * side-by-side + the BABLR cosmetic/semantic verdict next.
 *
 * NOTE (production): shiki is WebAssembly and fetches grammars from lighter.codehike.org at runtime — needs
 * `script-src 'wasm-unsafe-eval'` and `connect-src https://lighter.codehike.org` IF a CSP is ever added (our app
 * sets none today).
 */
import type { AnnotationHandler } from "codehike/code";
import { highlight, InnerLine, Pre } from "codehike/code";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/** One React root per host element, reused across diff switches (root.render updates in place). */
const roots = new WeakMap<HTMLElement, Root>();

export interface DiffInput {
	/** The working-tree file contents (what's shown, highlighted). */
	"working": string;
	/** 1-based working-file line numbers that are additions vs HEAD (marked). */
	"addedLines": number[];
	/** shiki language id (from the file extension). */
	"lang": string;
}

/** Render (or re-render) the diff for one file into `host`. */
export async function mountDiff(host: HTMLElement, input: DiffInput): Promise<void> {
	const added = new Set(input.addedLines);
	const code = await highlight({ "value": input.working, "lang": input.lang, "meta": "" }, "github-dark");

	// One handler for now: wrap long lines AND tint added lines. (Step 2 replaces this with a side-by-side handler
	// + a cosmetic/semantic handler — both compose the same way because they go through InnerLine.)
	const diffLine: AnnotationHandler = {
		"name": "diff-line",
		"Line": (props) => createElement(
			"div",
			{ "style": { "display": "block", "whiteSpace": "pre-wrap", "background": added.has(props.lineNumber) ? "#4ec9b022" : undefined } },
			createElement(InnerLine, { "merge": props })
		)
	};

	let root = roots.get(host);

	if (root === undefined) {
		root = createRoot(host);
		roots.set(host, root);
	}

	root.render(createElement(Pre, { "code": code, "handlers": [diffLine], "style": { "margin": 0, "fontSize": "12px", "lineHeight": "1.5" } }));
}

/** Tear down the React root (when the diff pane is emptied). */
export function unmountDiff(host: HTMLElement): void {
	const root = roots.get(host);

	if (root !== undefined) {
		root.unmount();
		roots.delete(host);
	}
}
