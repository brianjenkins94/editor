/**
 * toolbar — the theme's `toolbar` recipe as a package of its own (PLAN.md §10); theme/recipes re-exports it, and says how
 * a recipe is overridden.
 */
import { recipe } from "../../../packages/theme/src/stitches";

/** A bar of controls along the top of a view, ruled off from what's under it.
 *  Tokens: `--app-toolbar-padding-block`, `--app-toolbar-padding-inline`, `--app-toolbar-rule`. */
export const toolbar = recipe({
	"flex": "none",
	"boxSizing": "border-box",
	"padding": "var(--app-toolbar-padding-block, var(--wa-space-xs)) var(--app-toolbar-padding-inline, var(--wa-space-s))",
	"borderBottom": "var(--app-toolbar-rule, var(--wa-border-width-s) solid var(--wa-color-surface-border))",
	"variants": {
		"density": {
			"compact": { "--app-toolbar-padding-block": "var(--wa-space-3xs)", "--app-toolbar-padding-inline": "var(--wa-space-xs)" },
			"normal": {}
		},
		"ruled": {
			"false": { "--app-toolbar-rule": "none" },
			"true": {}
		}
	}
});
