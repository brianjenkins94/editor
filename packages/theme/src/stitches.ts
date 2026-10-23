/**
 * theme/stitches — the app's one Stitches instance (README.md, *Stitches only, in the theme*), the theme's own: its styles are made here, in
 * the theme — the recipes and composed components (components/*, through theme/recipes and theme/app-window) and each surface's styles
 * (theme/styles/<surface>) — and the app imports those, never this (webawesome/through-theme fails it outside the
 * theme, as it does `@stitches/core`). webawesome/css-in-js-tokens holds their values to the `--wa-*` tokens.
 *
 *     import { css, globalCss } from "../stitches";   // in packages/theme/src/styles/<surface>.ts
 *
 * Its output is layered, the way Panda layers its own, in the `app` layer after Web Awesome's (theme/sheet's layer
 * order, which this puts first in the document's head): `globalCss()` in `app.base`; `recipe()`, the theme's
 * vocabulary (theme/recipes), in `app.recipes`; `css()`, a surface's own styles, in `app.styles`; and a use-site
 * override — `toolbar({ "css": { … } })`, Stitches' one-off on any of them — in `app.overrides`, above them all, so
 * it wins wherever it's inserted (README.md, *The layers*). So which rule wins follows the layers, not specificity or which sheet
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
import { tokens } from "./web-awesome";

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

/** A `css()` argument in `layer`: its own rules, each variant's and each compound variant's (a composed component is
 *  already layered). */
const layered = (layer: string) => (style: any) => {
	if (style === null || typeof style !== "object") {
		return style;
	}

	const { variants, compoundVariants, defaultVariants, ...rules } = style;

	return {
		...inLayer(layer, rules),
		...(variants === undefined ? {} : { "variants": mapValues(variants, (options) => mapValues(options, (option) => inLayer(layer, option))) }),
		...(compoundVariants === undefined ? {} : { "compoundVariants": compoundVariants.map(({ css, ...when }) => ({ ...when, "css": inLayer(layer, css) })) }),
		...(defaultVariants === undefined ? {} : { defaultVariants })
	};
};

/** `style` with each `var(--wa-…)` given Web Awesome's default as its fallback (theme/web-awesome), so a recipe, and a
 *  component made of one, lays out on a page without Web Awesome's theme (README.md, *Published components*). */
const withDefaults = (style: any): any => {
	if (typeof style === "string") {
		return style.replaceAll(/var\((--wa-[\w-]+)\)/gu, (whole, name: string) => (tokens[name] === undefined ? whole : `var(${name}, ${tokens[name]})`));
	}

	if (Array.isArray(style)) {
		return style.map(withDefaults);
	}

	return style !== null && typeof style === "object" ? mapValues(style, withDefaults) : style;
};

/** A component whose use-site `css` goes in `app.overrides`. Still Stitches' own component (its descriptors copied,
 *  the internal one with them), so it composes: `css(toolbar, { … })`. */
function overridable<Component extends (...arguments_: any[]) => any>(component: Component): Component {
	const call = (props?: any) => component(props?.css === undefined ? props : { ...props, "css": inLayer("app.overrides", props.css) });

	return Object.defineProperties(call, Object.getOwnPropertyDescriptors(component)) as unknown as Component;
}

export const css = ((...arguments_: any[]) => overridable(stitches.css(...arguments_.map(layered("app.styles"))))) as typeof stitches.css;

/** A recipe: the theme's own vocabulary (theme/recipes, the components), under every surface's styles; Web Awesome's
 *  tokens in it fall back to their defaults. */
export const recipe = ((...arguments_: any[]) => overridable(stitches.css(...arguments_.map(withDefaults).map(layered("app.recipes"))))) as typeof stitches.css;

export const globalCss = ((...arguments_: any[]) => stitches.globalCss(...arguments_.map((style) => inLayer("app.base", style)))) as typeof stitches.globalCss;

/** A surface's styles by selector (theme/styles/<surface>: what an exception sheet was), in `app.styles` with its other
 *  styles, where its rules adjust a recipe without outranking it by specificity. */
export const stylesheet = ((...arguments_: any[]) => stitches.globalCss(...arguments_.map((style) => inLayer("app.styles", style)))) as typeof stitches.globalCss;

/** Global styles outside every layer, over CSS that isn't layered and can't be (VS Code's). */
export const unlayeredGlobalCss = stitches.globalCss;

export const { keyframes, theme } = stitches;
