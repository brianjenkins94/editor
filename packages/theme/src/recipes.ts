/**
 * theme/recipes — the app's shapes as Stitches recipes (PLAN.md §8.2): a class for a Web Awesome element or plain
 * markup, framework-free, so `class=`, `className=` and `element(tag, className)` all take it.
 *
 *     import { caption, toolbar } from "theme/recipes";
 *     element("div", toolbar({ "density": "compact" }) + " wa-cluster wa-gap-xs");
 *
 * Each is overridable, least reach first: its variants; its component tokens, read with Web Awesome's as the fallback,
 * so a subtree, a document or a brand retunes it by setting them on an ancestor (`--app-toolbar-padding-block: 0`);
 * a use-site override, `toolbar({ "css": { … } })`, which wins by layer (`app.overrides`); and a new recipe composed
 * from it, made here (`recipe(toolbar, { … })`).
 */
import { recipe } from "./stitches";

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

/** A document's whole view, fixed to the viewport: a webview's is clear of the padding VS Code's default webview styles
 *  give the body, which is unlayered, so no layered rule could take it back. */
export const frame = recipe({ "position": "fixed", "inset": 0, "overflow": "auto" });

/** Code, in the code's font: an id, a release, a route, a trace. */
export const code = recipe({ "fontFamily": "var(--wa-font-family-code)" });
