/**
 * theme/styles/margin — The right-hand side (pane.ts): the frame beside the code, its cells and entries. Bespoke, since nothing in Web
 * Awesome is laid out line for line with the code: the frame, its sash, the gutter column, the cards around a step's
 * lines and the tab strip on the pane's first line. All on --wa-* tokens (theme/vscode maps them onto the VS Code
 * theme); the Margin's accent is the palette's purple, as the architecture view's hub links are.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const marginStyles = stylesheet({
	// The Margin's colours, for every part of it: the frame, the gutter column and the code's marked lines are all in the
	// editor, not in one another.
	".monaco-editor": {
		"--margin-accent": "var(--wa-color-purple-60)",
		"--margin-marked": "color-mix(in srgb, var(--margin-accent) 12%, transparent)",
		"--margin-card": "color-mix(in srgb, var(--wa-color-surface-raised) 55%, transparent)"
	},
	".notes-margin": {
		"position": "absolute",
		"top": "0",
		"overflow": "hidden",
		"background": "var(--wa-color-surface-default)",
		"borderLeft": "var(--wa-border-width-s) solid var(--wa-color-surface-border)",
		"color": "var(--wa-color-text-normal)",
		"fontFamily": "var(--wa-font-family-body)",
		"fontSize": "var(--wa-font-size-m)",
		"zIndex": "5"
	},
	".notes-margin-sash": {
		"position": "absolute",
		"top": "0",
		"bottom": "0",
		"left": "-3px",
		"width": "5px",
		"cursor": "col-resize",
		"zIndex": "1"
	},
	".notes-margin-sash:hover, .notes-margin-sash.dragging": {
		"background": "var(--wa-color-focus)"
	},
	// The gutter column, left of the code (its own overlay): a mark per line, the consumer's to style.
	".notes-margin-gutter": {
		"position": "absolute",
		"top": "0",
		"overflow": "hidden"
	},
	// A mark as VS Code draws its change bar in this lane (dirtydiffDecorator.css: 5px in, scm.diffDecorationsGutterWidth's
	// default 3px wide), so the column looks native.
	".notes-margin-mark": {
		"position": "absolute",
		"left": "5px",
		"width": "3px"
	},
	".notes-margin-cell": {
		"position": "absolute",
		"left": "0",
		"right": "0",
		"padding": "0 var(--wa-space-m)",
		"boxSizing": "border-box",
		"borderLeft": "var(--wa-border-width-m) solid transparent"
	},
	".notes-margin-cell.lit": {
		"borderLeftColor": "var(--margin-accent)"
	},
	// Line for line with the code (the frame sets the editor's line height): a one-line note is as tall as its line.
	".notes-margin-entry + .notes-margin-entry": {
		"marginTop": "var(--wa-space-xs)"
	},
	".notes-margin-entry p": {
		"margin": "0 0 var(--wa-space-2xs)"
	},
	".notes-margin-entry p:last-child": {
		"marginBottom": "0"
	},
	".notes-margin-entry code": {
		"fontFamily": "var(--notes-margin-code-font-family, var(--wa-font-family-code))",
		"fontSize": "var(--notes-margin-code-font-size, var(--wa-font-size-s))"
	},
	".notes-margin-marked": {
		"background": "var(--margin-marked)"
	},
	// A group of entries (a step, in the program's projection): a card around its lines, behind its entries, with its
	// label on its bottom border.
	".notes-margin-group": {
		"position": "absolute",
		"left": "4px",
		"right": "6px",
		"boxSizing": "border-box",
		"border": "var(--wa-border-width-s) solid var(--wa-color-surface-border)",
		"borderRadius": "var(--wa-border-radius-m)",
		"background": "var(--margin-card)",
		"pointerEvents": "none"
	},
	".notes-margin-group.lit": {
		"borderColor": "var(--wa-color-focus)"
	},
	".notes-margin-group.lit .notes-margin-group-label": {
		"color": "var(--wa-color-text-normal)"
	},
	// On the card's bottom border, like a legend: in the blank line between steps, clear of the values on its lines.
	".notes-margin-group-label": {
		"position": "absolute",
		"bottom": "-9px",
		"right": "8px",
		"maxWidth": "80%",
		"padding": "0 var(--wa-space-2xs)",
		"background": "var(--wa-color-surface-default)",
		"overflow": "hidden",
		"fontSize": "var(--wa-font-size-xs)",
		"lineHeight": "var(--wa-line-height-condensed)",
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"color": "var(--wa-color-text-quiet)",
		"pointerEvents": "auto"
	},
	// The strip on the pane's first line (the editor's top padding is that line): the pane's views, as tabs. Pinned, over
	// the rows that scroll under it.
	".notes-margin-tabs": {
		"position": "absolute",
		"top": "0",
		"left": "0",
		"right": "0",
		"display": "flex",
		"gap": "var(--wa-space-3xs)",
		"padding": "0 var(--wa-space-s)",
		"boxSizing": "border-box",
		"background": "var(--wa-color-surface-default)",
		"borderBottom": "var(--wa-border-width-s) solid var(--wa-color-surface-border)",
		"zIndex": "2"
	},
	".notes-margin-tabs[hidden]": {
		"display": "none"
	},
	".notes-margin-tab": {
		"padding": "0 var(--wa-space-s)",
		"border": "0",
		"borderBottom": "var(--wa-border-width-s) solid transparent",
		// (its underline over the strip's border)
		"position": "relative",
		"top": "var(--wa-border-width-s)",
		"background": "none",
		"color": "var(--wa-color-text-quiet)",
		"font": "inherit",
		"fontSize": "var(--wa-font-size-xs)",
		"whiteSpace": "nowrap",
		"cursor": "pointer"
	},
	".notes-margin-tab:hover:not(:disabled)": {
		"color": "var(--wa-color-text-normal)"
	},
	".notes-margin-tab[aria-selected=\"true\"]": {
		"color": "var(--wa-color-text-normal)",
		"borderBottomColor": "var(--wa-color-focus)"
	},
	".notes-margin-tab:disabled": {
		"opacity": "0.5",
		"cursor": "default"
	},
	".notes-margin-tab:focus-visible": {
		"outline": "var(--wa-border-width-s) solid var(--wa-color-focus)",
		"outlineOffset": "calc(-1 * var(--wa-border-width-s))"
	},
	// A run's ball, rolling down the gutter column through the lines it ran (RUNNING.md, unattended runs): centred on its
	// line, gliding line to line, fading as it settles.
	".notes-margin-ball": {
		"position": "absolute",
		"left": "2px",
		"width": "9px",
		"height": "9px",
		"borderRadius": "var(--wa-border-radius-circle)",
		"background": "var(--margin-accent)",
		"transition": "top var(--wa-transition-fast) linear, opacity var(--wa-transition-slow) ease",
		"pointerEvents": "none"
	},
	".notes-margin-ball.placing": {
		"transition": "none"
	},
	".notes-margin-ball.settled": {
		"opacity": "0"
	},
	// The file's runs at the strip's end, a ball each, the one shown held: how it ended is its colour.
	".notes-margin-runs": {
		"display": "flex",
		"alignItems": "center",
		"gap": "var(--wa-space-3xs)",
		"marginLeft": "auto"
	},
	".notes-margin-run": {
		"width": "9px",
		"height": "9px",
		"padding": "0",
		"border": "0",
		"borderRadius": "var(--wa-border-radius-circle)",
		"background": "var(--wa-color-neutral-fill-loud)",
		"cursor": "pointer"
	},
	".notes-margin-run.ran": {
		"background": "var(--margin-accent)"
	},
	".notes-margin-run.crashed": {
		"background": "var(--wa-color-danger-fill-loud)"
	},
	".notes-margin-run.stopped": {
		"background": "var(--wa-color-warning-fill-loud)"
	},
	".notes-margin-run[aria-pressed=\"true\"]": {
		"outline": "var(--wa-border-width-m) solid var(--wa-color-focus)",
		"outlineOffset": "var(--wa-border-width-s)"
	}
});
