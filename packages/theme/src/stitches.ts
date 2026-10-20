/**
 * theme/stitches — the app's one Stitches instance (PLAN.md §7.5): CSS-in-JS on Web Awesome's tokens, for anywhere it
 * helps (variants, token scales, nested selectors, keyframes, global styles). Nothing else imports `@stitches/core`
 * (webawesome/through-theme), so every `css()` in the repo shares this token map; webawesome/css-in-js-tokens holds
 * their values to the `--wa-*` tokens, as css-tokens holds the stylesheets'.
 *
 *     import { css, globalCss } from "theme/stitches";
 *
 * Its output is unlayered, on purpose: it's the top of the cascade, which is how the shell's styles win over the DOM
 * they style that isn't ours (dockview, codehike) and how Workbench.tsx's win over VS Code's. (A style that should rank
 * with the exception sheets instead can be wrapped in an `"@layer app"` key, which Stitches emits as that layer.) It
 * injects into the head of the document it runs in; in VS Code's document, theme/sheet's mirrorStyles copies it into a
 * docked window's.
 */
import { createStitches } from "@stitches/core";

/** The palette: Web Awesome's tokens under the shell's names, for code that styles plain DOM or a library's widget, and
 *  as the instance's `$colors` scale. */
export const palette = {
	"bg": "var(--wa-color-surface-default)",
	"headerBg": "var(--wa-color-surface-raised)",
	"border": "var(--wa-color-surface-border)",
	"line": "var(--wa-color-neutral-border-quiet)",
	"text": "var(--wa-color-text-normal)",
	"title": "var(--wa-color-text-quiet)",
	"btnBg": "var(--wa-color-neutral-fill-quiet)",
	"btnText": "var(--wa-color-neutral-on-quiet)",
	"btnHover": "var(--wa-color-neutral-fill-normal)",
	"accent": "var(--wa-color-brand-fill-loud)", // primary series / links
	"accent2": "var(--wa-color-orange-60)" // secondary series / guide-lines (warm contrast)
} as const;

export const { css, globalCss, keyframes, theme } = createStitches({
	"theme": {
		"colors": { ...palette }
	}
});
