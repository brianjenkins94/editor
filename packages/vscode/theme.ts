/**
 * Shared visual theme for the in-browser tooling (the dark host-page palette).
 *
 * Two faces of the same tokens:
 *   • {@link palette} — raw hex strings, for consumers that style plain DOM / third-party widgets.
 *   • the Stitches instance (`css`/`theme`/…) — typed CSS-in-JS for component authors, with `$token`
 *     references resolving to the same palette.
 *
 * Uses `@stitches/core` (framework-agnostic — no React) so it fits the source-export → bundle chain
 * with no build plugin; runtime-injects into document.head on first `css()` use.
 */
import { createStitches } from "@stitches/core";
import { createElement } from "lucide";

/** Raw palette — the single source of truth for both faces below. */
export const palette = {
	"bg": "#0a0e17",
	"headerBg": "#0d1626",
	"border": "#2a5c8a",
	"line": "#1a2233",
	"text": "#cdd",
	"title": "#88aacc",
	"btnBg": "#16243a",
	"btnText": "#adf",
	"btnHover": "#26527c",
	"accent": "#4aa3ff",   // primary series / links (bright on dark)
	"accent2": "#e0843a"   // secondary series / guide-lines (warm contrast)
} as const;

export const { css, theme, keyframes, globalCss } = createStitches({
	"theme": {
		"colors": { ...palette }
	}
});

// ── Icons (lucide) ───────────────────────────────────────────────────────────────
//
// lucide ships each icon as plain data (an array of [tag, attrs] SVG children), rendered here via lucide's own
// `createElement` — vanilla DOM, no UI framework — so `theme` stays framework-agnostic. The consumer imports
// the specific icons it needs from `lucide` (tree-shaken) and passes them in:
//
//   import { X } from "lucide";
//   import { icon, iconSvg } from "./theme";
//   el.append(icon(X, { size: 14 }));                                        // vanilla DOM
//   <span dangerouslySetInnerHTML={{ __html: iconSvg(X, { size: 14 }) }} />  // Preact
//
// Icons are stroke-based with stroke:"currentColor", so they inherit the surrounding text colour (the
// palette) for free — set `color` on a parent and the icon follows.

/** lucide's per-icon shape: a flat list of SVG children as [tag, attributes] pairs (structurally lucide's own
 *  `IconNode`). */
export type IconNode = readonly [tag: string, attrs: Record<string, string | number>][];

export interface IconOptions {
	/** Width & height in px (lucide's 24px artboard is scaled to this). Default 16. */
	"size"?: number;
	/** Stroke width. Default 2 (lucide's default). */
	"stroke"?: number;
	/** Extra class(es) added alongside `lucide`. */
	"class"?: string;
}

/** Render a lucide icon node to an `<svg>` DOM element via lucide's `createElement` (merges our size/stroke/
 *  class over lucide's default attributes — viewBox, fill:none, stroke:currentColor, round caps). */
export function icon(node: IconNode, { size = 16, stroke = 2, "class": cls }: IconOptions = {}): SVGElement {
	return createElement(node as never, {
		"width": size,
		"height": size,
		"stroke-width": stroke,
		"class": cls ? `lucide ${cls}` : "lucide"
	}) as SVGElement;
}

/** Render a lucide icon node to an SVG markup string (for innerHTML / dangerouslySetInnerHTML). */
export function iconSvg(node: IconNode, options?: IconOptions): string {
	return icon(node, options).outerHTML;
}
