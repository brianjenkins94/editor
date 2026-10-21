/**
 * theme/styles/admin — The admin app's own few rules (packages/admin); everything else is Web Awesome's: its themes, utilities (layout,
 * alignment, wa-link-plain, wa-text-truncate) and native table styles. Left here: sizes, the navigation's links, the
 * page's padding, tables' scrolling, monospace text, and the architecture page's diagram — on --wa-* tokens. The app
 * imports Web Awesome's stylesheet first, so `app` is declared after its layers.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const adminStyles = stylesheet({
	".auth-screen": {
		"minHeight": "100vh"
	},
	".auth-card": {
		"width": "100%",
		"maxWidth": "24rem"
	},
	".stats": {
		"--min-column-size": "14rem"
	},
	".pair": {
		"--min-column-size": "24rem"
	},
	"nav[slot=\"navigation\"] a": {
		"padding": "var(--wa-space-xs) var(--wa-space-s)",
		"borderRadius": "var(--wa-border-radius-m)"
	},
	"nav[slot=\"navigation\"] a.active": {
		"background": "var(--wa-color-brand-fill-quiet)",
		"color": "var(--wa-color-brand-on-quiet)",
		"fontWeight": "var(--wa-font-weight-semibold)"
	},
	"main": {
		"padding": "var(--wa-space-l)"
	},
	".table": {
		"overflowX": "auto"
	},
	".table th, .table td": {
		"whiteSpace": "nowrap"
	},
	".mono": {
		"fontFamily": "var(--wa-font-family-code)",
		"fontSize": "var(--wa-font-size-s)"
	},
	".problem": {
		"color": "var(--wa-color-danger-on-quiet)"
	},
	".agent": {
		"maxWidth": "40ch"
	},
	// The architecture page's diagram (src/architecture.tsx): Web Awesome's tokens, so it follows the theme.
	".diagram": {
		"overflowX": "auto"
	},
	".diagram svg": {
		"fontFamily": "var(--wa-font-family-body)"
	},
	".diagram .column": {
		"fill": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-xs)",
		"textTransform": "uppercase",
		"letterSpacing": "0.05em"
	},
	".diagram .box": {
		"cursor": "pointer"
	},
	".diagram .box rect": {
		"fill": "var(--wa-color-surface-raised)",
		"stroke": "var(--wa-color-surface-border)"
	},
	".diagram .box.selected rect": {
		"stroke": "var(--wa-color-brand-border-loud)",
		"strokeWidth": "2"
	},
	".diagram .title": {
		"fill": "var(--wa-color-text-normal)",
		"fontSize": "var(--wa-font-size-s)",
		"fontWeight": "var(--wa-font-weight-semibold)"
	},
	".diagram .kind": {
		"fill": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-xs)"
	},
	".diagram .line": {
		"fill": "var(--wa-color-text-normal)",
		"fontFamily": "var(--wa-font-family-code)",
		"fontSize": "var(--wa-font-size-xs)"
	},
	".diagram .metric": {
		"fill": "var(--wa-color-brand-on-quiet)",
		"fontSize": "var(--wa-font-size-xs)",
		"fontWeight": "var(--wa-font-weight-semibold)"
	},
	".diagram .edge path": {
		"fill": "none",
		"stroke": "var(--wa-color-neutral-border-loud)",
		"strokeWidth": "1.25"
	},
	".diagram .edge.back path": {
		"strokeDasharray": "4 4"
	},
	".diagram .edge text": {
		"fill": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-xs)",
		"textAnchor": "middle"
	},
	".diagram .edge.faded": {
		"opacity": "0.12"
	}
});
