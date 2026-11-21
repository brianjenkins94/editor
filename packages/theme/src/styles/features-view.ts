/**
 * theme/styles/features-view — Features and tests: a table Web Awesome has no component for, on its tokens, so it follows
 * light and dark. Its cells are Web Awesome's badges and buttons; left here are the table's lines and the columns' widths.
 */
import { stylesheet } from "../stitches";

export const featuresViewStyles = stylesheet({
	// (the whole of the view, whatever size it's laid out to: it scrolls, so its header stays)
	".fv": {
		"position": "absolute",
		"inset": 0,
		"overflow": "auto",
		"boxSizing": "border-box",
		"padding": "var(--wa-space-xs)"
	},
	".fv-table": {
		"width": "100%",
		"borderCollapse": "collapse",
		"fontSize": "var(--wa-font-size-xs)"
	},
	// (a header on one line, as its cells are: wrapped, it grew as tall as a short view's middle, where a row scrolled to
	// would be, under it)
	".fv-table th, .fv-table td": {
		"whiteSpace": "nowrap"
	},
	".fv-table th": {
		"position": "sticky",
		"top": 0,
		"textAlign": "start",
		"fontWeight": "var(--wa-font-weight-semibold)",
		"color": "var(--wa-color-text-quiet)",
		"background": "var(--wa-color-surface-default)",
		"padding": "var(--wa-space-2xs) var(--wa-space-xs)"
	},
	".fv-table td": {
		"padding": "var(--wa-space-3xs) var(--wa-space-xs)",
		"borderTop": "var(--wa-border-width-s) solid var(--wa-color-surface-border)"
	},
	".fv-feature td": {
		"fontWeight": "var(--wa-font-weight-semibold)",
		"background": "var(--wa-color-surface-lowered)"
	},
	".fv-test": {
		"paddingInlineStart": "var(--wa-space-l)"
	},
	".fv-case": {
		"paddingInlineStart": "var(--wa-space-2xl)",
		"color": "var(--wa-color-text-quiet)"
	},
	".fv-toggle": {
		"cursor": "pointer"
	}
});
