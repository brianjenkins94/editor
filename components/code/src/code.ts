/**
 * code — the theme's `code` recipe as a package of its own (PLAN.md §10); theme/recipes re-exports it, and says how
 * a recipe is overridden.
 */
import { recipe } from "../../../packages/theme/src/stitches";

/** Code, in the code's font: an id, a release, a route, a trace. */
export const code = recipe({ "fontFamily": "var(--wa-font-family-code)" });
