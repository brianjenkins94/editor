/**
 * theme/styles/rule-editor — The rule editor (editor/workbench/rule-editor.ts): what Web Awesome's components and utility classes don't cover. Its
 * controls are wa-select / wa-input / wa-checkbox / wa-button, its rows and lists wa-cluster / wa-stack, its words
 * wa-color-text-quiet. Left here: how wide each control is in a row, where a list and a row's − + go, a group's indent,
 * and a place in the code — on --wa-* tokens (theme/vscode maps them onto the VS Code theme).
 */
import { stylesheet } from "../stitches";

export const ruleEditorStyles = stylesheet({
	// A group's rows, indented under its head, a rule down their side.
	".rule-editor-group:not(.top) > .rule-editor-rows": {
		"marginInlineStart": "var(--wa-space-xs)",
		"paddingInlineStart": "var(--wa-space-s)",
		"borderInlineStart": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)"
	},
	// A select as wide as its choice, not its longest option ("is", not "is valid against").
	".rule-editor-select": {
		"flex": "none",
		"width": "9em"
	},
	// The argument takes what's left of the row, wrapping under the selects only when that's too little.
	".rule-editor-argument, .rule-editor-place": {
		"flex": "1 1 6em",
		"minWidth": "6em"
	},
	// A row's − and +, at its end.
	".rule-editor-tools": {
		"marginInlineStart": "auto"
	},
	// A row's list takes a line of its own under its selects, which keep the row's − and +.
	".rule-editor-row > .rule-editor-list": {
		"order": "2",
		"flex": "1 1 100%"
	},
	".rule-editor-row:has(> .rule-editor-list) > .rule-editor-tools": {
		"order": "1"
	},
	// An array's items: each as wide as a short value, its ✕ after it…
	".rule-editor-list .rule-editor-argument": {
		"flex": "none",
		"width": "8em"
	},
	// …but a list of lists' (process.argv's runs) as wide as the row.
	".rule-editor-list.nested > .rule-editor-list-item > .rule-editor-argument": {
		"flex": "1 1 auto",
		"width": "auto"
	},
	// A place in the code: its statement, in the code's type, not editable.
	".rule-editor-place": {
		"padding": "var(--wa-space-2xs) var(--wa-space-xs)",
		"borderRadius": "var(--wa-border-radius-s)",
		"background": "var(--wa-color-neutral-fill-quiet)",
		"fontFamily": "var(--wa-font-family-code)"
	}
});
