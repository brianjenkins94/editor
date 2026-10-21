/**
 * theme/styles/pane-views — The pane's look (pane-views.ts draws every view in it, the Margin's look): a row per line, its label, then its value
 * or a column per turn. Its buttons, split buttons and input are Web Awesome's; what's left is bespoke, since nothing
 * in Web Awesome lines up with the code's lines and characters: the rows and their columns, a value's colour by its
 * kind, the marks in the gutter column and a step card's label. All on --wa-* tokens (theme/vscode maps them onto the
 * VS Code theme), plus the bridge's --code-value-* for what the debugger shows; the Margin's accent is theme/styles/margin's.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const paneViewsStyles = stylesheet({
	".monaco-editor": {
		// A character column: the rows line up with the code's characters, so their gaps are measured in them, not on Web
		// Awesome's space scale.
		"--live-values-ch": "1ch",
		"--live-values-lit": "color-mix(in srgb, var(--margin-accent) 22%, transparent)",
		"--live-values-held": "color-mix(in srgb, var(--margin-accent) 35%, transparent)",
		"--live-values-ran": "color-mix(in srgb, var(--wa-color-success-fill-loud) 56%, transparent)",
		"--live-values-missed": "color-mix(in srgb, var(--wa-color-danger-fill-loud) 75%, transparent)"
	},
	".live-values-row": {
		"display": "flex",
		"whiteSpace": "pre",
		"fontFamily": "var(--notes-margin-code-font-family, var(--wa-font-family-code))",
		"fontSize": "var(--notes-margin-code-font-size, var(--wa-font-size-s))"
	},
	".live-values-label": {
		"flex": "none",
		"paddingRight": "var(--live-values-ch)",
		"color": "var(--code-value-name)"
	},
	".live-values-cell": {
		"flex": "none",
		"overflow": "hidden",
		"textOverflow": "ellipsis"
	},
	".live-values-cell.turn": {
		"padding": "0 var(--live-values-ch)",
		"borderLeft": "var(--wa-border-width-s) solid var(--wa-color-surface-border)",
		"cursor": "pointer"
	},
	".live-values-cell.lit": {
		"background": "var(--live-values-lit)"
	},
	".live-values-cell.held": {
		"background": "var(--live-values-held)"
	},
	// A value beside its label shrinks to the margin, cut short with an ellipsis.
	".live-values-cell.inline": {
		"flex": "0 1 auto",
		"minWidth": "0"
	},
	// The cursor's line opens up (pane.ts lights the margin's cell at the cursor): each value whole, wrapped in its
	// column, the cell growing for it.
	".notes-margin-cell.lit .live-values-row": {
		"alignItems": "start"
	},
	".notes-margin-cell.lit .live-values-cell": {
		"whiteSpace": "pre-wrap",
		"overflowWrap": "anywhere"
	},
	".live-values-string": {
		"color": "var(--code-value-string)"
	},
	".live-values-number": {
		"color": "var(--code-value-number)"
	},
	".live-values-boolean": {
		"color": "var(--code-value-boolean)"
	},
	".live-values-branch": {
		"color": "var(--wa-color-text-quiet)",
		"fontStyle": "italic"
	},
	// A value set by hand or by a rule.
	".live-values-set": {
		"color": "var(--wa-color-orange-60)",
		"fontWeight": "var(--wa-font-weight-bold)"
	},
	// A call that wasn't made — skipped at its stop, or by a live run (LIVE-VALUES.md): what didn't happen, muted.
	".live-values-skip": {
		"color": "var(--wa-color-text-quiet)",
		"fontStyle": "italic"
	},
	// An item's buttons, under it (a wa-cluster).
	".live-values-choices": {
		"marginTop": "var(--wa-space-2xs)"
	},
	// The one clicked, while the item's buttons are off until it's drawn again.
	".live-values-choice.chosen": {
		"outline": "var(--wa-border-width-s) solid var(--wa-color-focus)",
		"outlineOffset": "var(--wa-border-width-s)"
	},
	".live-values-ask-error": {
		"marginTop": "var(--wa-space-2xs)",
		"color": "var(--wa-color-danger-on-quiet)",
		"fontFamily": "var(--wa-font-family-body)"
	},
	// A row's buttons at its end (a wa-cluster), on its hover or at the cursor, so rows don't grow controls nobody asked
	// for: process.argv's Mock… is always there, beside what a rule gives it.
	".live-values-mock": {
		"alignSelf": "center",
		"marginLeft": "var(--live-values-ch)",
		"visibility": "hidden",
		"fontFamily": "var(--wa-font-family-body)"
	},
	// A row's controls are no taller than its line (so a row stays as tall as the code's), and the row's `pre` stays out
	// of them. Buttons are in the UI's type.
	".live-values-mock, .live-values-input": {
		"--wa-form-control-height": "var(--notes-margin-line-height)",
		"whiteSpace": "normal",
		"lineHeight": "var(--wa-line-height-condensed)"
	},
	".live-values-mock.shown, .live-values-row:hover .live-values-mock, .notes-margin-cell.lit .live-values-mock": {
		"visibility": "visible"
	},
	// A value typed in (process.argv's Mock…): as wide as a short command line, in the code's type.
	".live-values-input": {
		"flex": "none",
		"width": "14ch",
		"marginRight": "var(--live-values-ch)"
	},
	// Coverage's marks in the margin's gutter column (coverage.ts), shaped as VS Code's own gutter bars (theme/styles/margin):
	// green beside a line that ran, red beside one that didn't, the two striped beside one that partly ran (as its
	// coverage stripes) — and, in a high-contrast theme, a solid line rather than a fill, as its coverage does.
	".notes-margin-mark.coverage-ran": {
		"background": "var(--live-values-ran)"
	},
	".notes-margin-mark.coverage-missed": {
		"background": "var(--live-values-missed)"
	},
	".notes-margin-mark.coverage-partial": {
		"backgroundImage": "linear-gradient(45deg, var(--live-values-ran) 25%, var(--live-values-missed) 25%, var(--live-values-missed) 50%, var(--live-values-ran) 50%, var(--live-values-ran) 75%, var(--live-values-missed) 75%)",
		"backgroundSize": "6px 6px"
	},
	".hc-black .notes-margin-mark[class*=\"coverage-\"], .hc-light .notes-margin-mark[class*=\"coverage-\"]": {
		"background": "none",
		"borderLeft": "3px solid var(--wa-color-success-fill-loud)",
		"boxSizing": "border-box"
	},
	".hc-black .notes-margin-mark.coverage-missed, .hc-light .notes-margin-mark.coverage-missed": {
		"borderLeftColor": "var(--wa-color-danger-fill-loud)"
	},
	// How the last run ended short, in the gutter column: a near-square badge, centred on where its bar would be (6.5px
	// in: theme/styles/margin) and on the line, clear of the line number — beside the line it crashed on or was stopped at. The
	// mark spans the line; the badge is drawn inside it. A placed rule (RULES.md: *at*) is a small diamond there, over
	// coverage's bar, so a mocked variable or a given result isn't invisible.
	".notes-margin-mark.run-crashed, .notes-margin-mark.run-stopped, .notes-margin-mark.rule-placed": {
		"left": "2px",
		"width": "9px",
		"display": "flex",
		"alignItems": "center",
		"justifyContent": "center",
		"zIndex": "1"
	},
	".notes-margin-mark.run-crashed::before, .notes-margin-mark.run-stopped::before": {
		"display": "flex",
		"alignItems": "center",
		"justifyContent": "center",
		"width": "9px",
		"height": "11px",
		"borderRadius": "var(--wa-border-radius-s)",
		"fontSize": "var(--wa-font-size-3xs)",
		"lineHeight": "var(--wa-line-height-condensed)",
		"fontWeight": "var(--wa-font-weight-bold)"
	},
	".notes-margin-mark.run-crashed::before": {
		"content": "\"\u2715\"",
		"background": "var(--wa-color-danger-fill-loud)",
		"color": "var(--wa-color-danger-on-loud)"
	},
	".notes-margin-mark.run-stopped::before": {
		"content": "\"\u25aa\"",
		"background": "var(--wa-color-warning-fill-loud)",
		"color": "var(--wa-color-warning-on-loud)"
	},
	// Hollow where it was found by a weak match.
	".notes-margin-mark.rule-placed::before": {
		"content": "\"\"",
		"width": "6px",
		"height": "6px",
		"boxSizing": "border-box",
		"transform": "rotate(45deg)",
		"background": "var(--margin-accent)",
		"boxShadow": "0 0 0 var(--wa-border-width-s) var(--wa-color-surface-default)"
	},
	".notes-margin-mark.rule-placed.uncertain::before": {
		"background": "var(--wa-color-surface-default)",
		"border": "1.5px solid var(--margin-accent)"
	},
	// A step's card label (the card is the margin's, theme/styles/margin): its title, what it is, whether it ran.
	".live-values-step-title": {
		"color": "var(--wa-color-text-normal)"
	},
	".live-values-step-detail, .live-values-step-ran": {
		"marginLeft": "var(--wa-space-xs)"
	},
	".live-values-step-ran.ran": {
		"color": "var(--wa-color-success-on-quiet)"
	},
	".live-values-step-ran.missed": {
		"color": "var(--wa-color-danger-on-quiet)"
	},
	".live-values-step-ran.partial": {
		"color": "var(--wa-color-warning-on-quiet)"
	},
	// A pane view's item (pane-views.ts), marked by its tone.
	".pane-item.tone-question, .pane-item.tone-info, .pane-item.tone-warning, .pane-item.tone-error": {
		"paddingLeft": "var(--wa-space-xs)",
		"borderLeft": "var(--wa-border-width-m) solid var(--tone)"
	},
	".pane-item.tone-question": {
		"--tone": "var(--wa-color-brand-fill-loud)"
	},
	".pane-item.tone-info": {
		"--tone": "var(--wa-color-neutral-fill-loud)"
	},
	".pane-item.tone-warning": {
		"--tone": "var(--wa-color-warning-fill-loud)"
	},
	".pane-item.tone-error": {
		"--tone": "var(--wa-color-danger-fill-loud)"
	},
	// A row's lead cells (a function's call picker: ‹ 2/5 ›), and any cell that does something when clicked.
	".live-values-cell.lead": {
		"flex": "none",
		"padding": "0 var(--wa-space-3xs)",
		"color": "var(--wa-color-text-quiet)"
	},
	".live-values-cell.lead + .live-values-label": {
		"marginLeft": "var(--live-values-ch)"
	},
	".live-values-cell.lead.clickable": {
		"color": "var(--wa-color-text-link)"
	},
	".live-values-cell.clickable": {
		"cursor": "pointer"
	},
	// A pane view's prose sits on its line: no paragraph margins.
	".pane-item .pane-markdown p": {
		"margin": "0"
	}
});
