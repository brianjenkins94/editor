/**
 * theme/stitches — the app's one Stitches instance (PLAN.md §7.5): CSS-in-JS on Web Awesome's tokens, for anywhere it
 * helps (variants, token scales, nested selectors, keyframes, global styles). Nothing else imports `@stitches/core`
 * (webawesome/through-theme), so every `css()` in the repo shares this token map; webawesome/css-in-js-tokens holds
 * their values to the `--wa-*` tokens, as css-tokens holds the stylesheets'.
 *
 *     import { css, globalCss } from "theme/stitches";
 *
 * Its output is layered, the way Panda layers its own: `css()` (with its variants and compound variants) in
 * `app.styles`, `globalCss()` in `app.base`, both in the `app` layer after Web Awesome's (theme/sheet's layer order,
 * which this puts first in the document's head). So which rule wins follows the layers, not specificity or which sheet
 * was inserted last: a Stitches class wins over Web Awesome's utilities and the recipes (`app.recipes`), and over the
 * DOM it styles that isn't ours when that DOM's sheet is in the `vendor` layer, under everything (dockview's; codehike
 * styles inline). Stitches has no layers of its own (it predates them); it emits an `"@layer name"` key as that layer's
 * block, so each style object is wrapped in one.
 *
 * VS Code's CSS isn't ours to layer, and unlayered CSS outranks every layer, so what overrides it — Workbench.tsx — says
 * so with `unlayeredGlobalCss`, the one way out of the layers.
 *
 * It injects into the head of the document it runs in; in VS Code's document, theme/sheet's mirrorStyles copies it into
 * a docked window's.
 */
import { createStitches } from "@stitches/core";

import { layerOrder } from "./sheet.js";

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

const stitches = createStitches({
	"theme": {
		"colors": { ...palette }
	}
});

if (globalThis.document !== undefined) {
	layerOrder(document);
}

const inLayer = (layer: string, style: object): any => ({ [`@layer ${layer}`]: style });

const mapValues = (object: object, map: (value: any) => unknown) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value)]));

/** A `css()` argument in `app.styles`: its own rules, each variant's and each compound variant's (a composed component
 *  is already layered). */
function styles(style: any) {
	if (style === null || typeof style !== "object") {
		return style;
	}

	const { variants, compoundVariants, defaultVariants, ...rules } = style;

	return {
		...inLayer("app.styles", rules),
		...(variants === undefined ? {} : { "variants": mapValues(variants, (options) => mapValues(options, (option) => inLayer("app.styles", option))) }),
		...(compoundVariants === undefined ? {} : { "compoundVariants": compoundVariants.map(({ css, ...when }) => ({ ...when, "css": inLayer("app.styles", css) })) }),
		...(defaultVariants === undefined ? {} : { defaultVariants })
	};
}

export const css = ((...arguments_: any[]) => stitches.css(...arguments_.map(styles))) as typeof stitches.css;

export const globalCss = ((...arguments_: any[]) => stitches.globalCss(...arguments_.map((style) => inLayer("app.base", style)))) as typeof stitches.globalCss;

/** Global styles outside every layer, over CSS that isn't layered and can't be (VS Code's). */
export const unlayeredGlobalCss = stitches.globalCss;

export const { keyframes, theme } = stitches;
