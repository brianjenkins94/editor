/**
 * frame — the theme's `frame` recipe as a package of its own (PLAN.md §10); theme/recipes re-exports it, and says how
 * a recipe is overridden.
 */
import type { Recipe } from "../../../packages/theme/src/component";
import { recipe } from "../../../packages/theme/src/stitches";

/** A document's whole view, fixed to the viewport: a webview's is clear of the padding VS Code's default webview styles
 *  give the body, which is unlayered, so no layered rule could take it back. */
export const frame: Recipe = recipe({ "position": "fixed", "inset": 0, "overflow": "auto" });
