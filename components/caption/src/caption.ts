/**
 * caption — the theme's `caption` recipe as a package of its own (PLAN.md §10); theme/recipes re-exports it, and says how
 * a recipe is overridden.
 */
import { recipe } from "../../../packages/theme/src/stitches";

/** A section's or a card's label: small, quiet, uppercase.
 *  Tokens: `--app-caption-color`, `--app-caption-size`. */
export const caption = recipe({
	"color": "var(--app-caption-color, var(--wa-color-text-quiet))",
	"fontSize": "var(--app-caption-size, var(--wa-font-size-xs))",
	"fontWeight": "var(--wa-font-weight-semibold)",
	"letterSpacing": "0.04em",
	"textTransform": "uppercase",
	"variants": {
		"size": {
			"xs": {},
			"2xs": { "--app-caption-size": "var(--wa-font-size-2xs)" }
		}
	}
});
