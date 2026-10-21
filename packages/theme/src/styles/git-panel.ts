/**
 * theme/styles/git-panel — Git review panel — what Web Awesome's components and utility classes don't cover. The panel (git-panel.tsx) is
 * wa-checkbox / wa-badge / wa-button / wa-textarea laid out with wa-stack / wa-cluster / wa-split and the text
 * utilities; left here are the panel's sizing, the rows' hover and current states, and the codehike diff renderer
 * (git-codehike.tsx): its side-by-side grid has no Web Awesome component. Everything is on Web Awesome's tokens, so it
 * follows light and dark.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const gitPanelStyles = stylesheet({
	".gp": {
		"height": "100%",
		"minHeight": "0"
	},
	// The pane's only header (the shell's collapse button arrives at its end) — sized like the shell's "Projects" header
	// so the two sides line up.
	// border-box: wa-split makes it 100% wide, which its padding would otherwise overflow.
	".gp-head": {
		"flex": "none",
		"boxSizing": "border-box",
		"padding": "var(--wa-space-2xs) var(--wa-space-xs) var(--wa-space-2xs) var(--wa-space-s)"
	},
	".gp-files": {
		"flex": "1 1 0",
		"minHeight": "80px",
		"overflow": "auto"
	},
	".gp-empty": {
		"padding": "var(--wa-space-l) var(--wa-space-s)"
	},
	".gp-commit": {
		"flex": "none",
		"padding": "var(--wa-space-s)",
		"background": "var(--wa-color-surface-raised)",
		"borderBlockStart": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)"
	},
	".gp-file": {
		"padding": "var(--wa-space-3xs) var(--wa-space-s)",
		"cursor": "pointer",
		"borderInlineStart": "var(--wa-border-width-m) var(--wa-border-style) transparent"
	},
	".gp-file:hover": {
		"background": "var(--wa-color-neutral-fill-quiet)"
	},
	".gp-file[aria-current=\"true\"]": {
		"background": "var(--wa-color-brand-fill-quiet)",
		"borderInlineStartColor": "var(--wa-color-brand-fill-loud)"
	},
	".gp-status": {
		"fontFamily": "var(--wa-font-family-code)"
	},
	// rtl so a long path truncates at its START (…/deep/file.ts); the path itself sits in a <bdi dir="ltr"> so rtl
	// doesn't reorder its neutral characters — without it ".gitignore" renders as "gitignore.".
	".gp-name": {
		"flex": "1 1 0",
		"minWidth": "0",
		"direction": "rtl",
		"textAlign": "left"
	},
	".gp-discard": {
		"visibility": "hidden"
	},
	".gp-file:hover .gp-discard, .gp-discard.armed": {
		"visibility": "visible"
	},
	// "Your edits" — per-file chunk timeline (Automerge edit-bursts, node-grouped). Hovering a chunk spotlights its
	// range in the open diff (setDiffHighlight), in the same colour.
	".gp-chunks": {
		"padding": "var(--wa-space-3xs) var(--wa-space-s) var(--wa-space-xs) var(--wa-space-xl)",
		"background": "var(--wa-color-surface-lowered)"
	},
	".gp-chunk, .gp-chunk-info": {
		"padding": "var(--wa-space-3xs) var(--wa-space-2xs)"
	},
	".gp-chunk": {
		"cursor": "pointer",
		"fontVariantNumeric": "tabular-nums"
	},
	".gp-chunk:hover": {
		"background": "var(--wa-color-warning-fill-quiet)"
	},
	".gp-chunk-label": {
		"flex": "1 1 0",
		"minWidth": "0",
		"fontFamily": "var(--wa-font-family-code)"
	},
	// BABLR verdict banner — sticky at the top of the diff, in the variant (wa-neutral / wa-warning / wa-danger) of
	// whether the change moves the meaning.
	".sxs-wrap": {
		"minHeight": "100%"
	},
	".sxs-verdict": {
		"position": "sticky",
		"top": "0",
		"zIndex": "1",
		"padding": "var(--wa-space-xs) var(--wa-space-s)",
		"background": "var(--wa-color-surface-raised)",
		"color": "var(--wa-color-on-quiet)",
		"letterSpacing": ".02em",
		"borderBlockEnd": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)"
	},
	".sxs-dot": {
		"flex": "none",
		"width": "8px",
		"height": "8px",
		"background": "var(--wa-color-fill-loud)"
	},
	// Side-by-side codehike diff: HEAD | working, sharing one grid so a row's height is the taller of its two cells
	// (that's what keeps alignment under word wrap). Each line is a subgrid item = number gutter + wrapped code.
	// Number gutters are `auto` (content-sized), not a fixed width: each holds a fold chevron slot + the pick toggle +
	// the line number, so a fixed gutter clips the number once folds appear or line numbers reach 3–4 digits.
	".sxs": {
		"display": "grid",
		"alignItems": "stretch",
		"paddingBottom": "var(--wa-space-xs)",
		"gridTemplateColumns": "minmax(0, 1fr) auto 14px auto minmax(0, 1fr)",
		"fontFamily": "var(--wa-font-family-code)",
		"fontSize": "var(--wa-font-size-xs)",
		"lineHeight": "var(--wa-line-height-normal)"
	},
	// Center gutter bar (GitHub-Desktop split view): one per change hunk, spanning its rows, toggles the WHOLE change.
	// Its fill is a deeper brand tone than the number gutters' (GitHub-Desktop style).
	".sxs-hunk": {
		"gridColumn": "3",
		"margin": "0",
		"border": "0",
		"padding": "var(--wa-space-3xs) 0 0",
		"cursor": "pointer",
		"fontSize": "var(--wa-font-size-3xs)",
		"lineHeight": "var(--wa-line-height-condensed)",
		"background": "var(--wa-color-neutral-fill-quiet)",
		"color": "transparent"
	},
	".sxs-hunk:hover": {
		"background": "var(--wa-color-neutral-fill-normal)",
		"color": "var(--wa-color-text-quiet)"
	},
	".sxs-hunk.all": {
		"background": "var(--wa-color-brand-fill-normal)",
		"color": "var(--wa-color-brand-on-normal)"
	},
	".sxs-hunk.partial": {
		"background": "var(--wa-color-brand-fill-quiet)",
		"color": "var(--wa-color-brand-on-quiet)"
	},
	// Both number gutters hug the centre bar; a SELECTED changed line fills its gutter cell with the brand colour.
	".sxs-num": {
		"padding": "0 var(--wa-space-2xs)",
		"color": "var(--wa-color-text-quiet)",
		"userSelect": "none",
		"whiteSpace": "nowrap"
	},
	".sxs-lineno": {
		"marginLeft": "auto",
		"fontVariantNumeric": "tabular-nums"
	},
	".sxs-fold-slot": {
		"flex": "none",
		"width": "11px"
	},
	".sxs-num.sel": {
		"background": "var(--wa-color-brand-fill-loud)"
	},
	".sxs-num.sel, .sxs-num.sel .sxs-lineno, .sxs-num.sel .sxs-fold": {
		"color": "var(--wa-color-brand-on-loud)"
	},
	// order: -1 places the pick checkmark LEFT of the fold chevron; an empty slot on context rows just reserves width.
	".sxs-pick": {
		"order": "-1",
		"flex": "none",
		"width": "12px",
		"height": "17px",
		"border": "0",
		"padding": "0",
		"cursor": "pointer",
		"fontSize": "var(--wa-font-size-3xs)",
		"lineHeight": "var(--wa-line-height-condensed)",
		"background": "transparent",
		"color": "inherit"
	},
	".sxs-pick-empty": {
		"pointerEvents": "none"
	},
	".sxs-line:hover .sxs-num:not(.sel) button.sxs-pick": {
		"color": "var(--wa-color-text-quiet)",
		"outline": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)",
		"outlineOffset": "calc(-1 * var(--wa-border-width-s))"
	},
	".sxs-code": {
		"padding": "0 var(--wa-space-s)",
		"minWidth": "0",
		"whiteSpace": "pre-wrap",
		"overflowWrap": "anywhere"
	},
	".sxs-empty": {
		"background": "var(--wa-color-surface-lowered)"
	},
	".sxs-line": {
		"transition": "opacity var(--wa-transition-slow) var(--wa-transition-easing)"
	},
	".sxs-line.faded": {
		"opacity": ".38"
	},
	".sxs-line.faded:hover": {
		"opacity": "1"
	},
	".sxs-fold": {
		"border": "0",
		"padding": "0",
		"background": "none",
		"cursor": "pointer",
		"color": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-3xs)",
		"lineHeight": "var(--wa-line-height-normal)"
	},
	".sxs-fold:hover": {
		"color": "var(--wa-color-text-normal)"
	},
	// A folded row shows `{ ⋯ }`. InnerLine emits a trailing newline that `pre-wrap` would break onto its own line, so a
	// folded row uses `white-space: normal` (collapsing that newline) and renders the code inline, so the mark flows
	// right after the opening brace and still wraps on-screen for a long signature. Indent comes from the cell's
	// margin-left.
	".sxs-code.folded, .sxs-code.folded > div": {
		"whiteSpace": "normal"
	},
	".sxs-code.folded > div": {
		"display": "inline"
	},
	".sxs-folded-mark": {
		"padding": "0 var(--wa-space-2xs)",
		"borderRadius": "var(--wa-border-radius-s)",
		"cursor": "pointer",
		"whiteSpace": "nowrap",
		"color": "var(--wa-color-text-quiet)"
	},
	".sxs-folded-mark:hover": {
		"background": "var(--wa-color-neutral-fill-quiet)",
		"color": "var(--wa-color-text-normal)"
	},
	".sxs-gap": {
		"gridColumn": "1 / span 5",
		"padding": "var(--wa-space-3xs) var(--wa-space-s)",
		"textAlign": "left",
		"cursor": "pointer",
		"font": "inherit",
		"border": "0",
		"borderBlock": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)",
		"background": "var(--wa-color-neutral-fill-quiet)",
		"color": "var(--wa-color-text-quiet)"
	},
	".sxs-gap:hover": {
		"background": "var(--wa-color-neutral-fill-normal)",
		"color": "var(--wa-color-text-normal)"
	},
	// The right-click discard menu: its one action (a wa-button) at the pointer, over a backdrop that dismisses it.
	// The right-click menu's trigger: the point that was clicked (its left and top set where it opens).
	".sxs-menu": {
		"position": "fixed"
	},
	// Plain-diff fallback, rendered into the overlay body when the codehike island can't load.
	".sxs-plain": {
		"padding": "var(--wa-space-2xs) 0",
		"fontFamily": "var(--wa-font-family-code)",
		"fontSize": "var(--wa-font-size-xs)",
		"lineHeight": "var(--wa-line-height-normal)"
	},
	".sxs-plain-row": {
		"padding": "0 var(--wa-space-s)",
		"whiteSpace": "pre-wrap"
	},
	".sxs-plain-row.add": {
		"background": "var(--wa-color-success-fill-quiet)",
		"color": "var(--wa-color-success-on-quiet)"
	},
	".sxs-plain-row.del": {
		"background": "var(--wa-color-danger-fill-quiet)",
		"color": "var(--wa-color-danger-on-quiet)"
	},
	".sxs-plain-row.ctx": {
		"color": "var(--wa-color-text-quiet)"
	},
	".sxs-plain-row.gap": {
		"textAlign": "center",
		"fontStyle": "italic",
		"background": "var(--wa-color-neutral-fill-quiet)",
		"color": "var(--wa-color-text-quiet)"
	}
});
