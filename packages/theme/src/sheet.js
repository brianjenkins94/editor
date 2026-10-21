/**
 * theme/sheet — a surface's exception sheet (theme/exceptions/*.css, imported `?raw`) as a `<style>` for its document,
 * after the layer order every such sheet shares.
 *
 *     import css from "theme/exceptions/rule-view.css?raw";
 *     import { styleSheet } from "theme/sheet";
 *     document.head.append(styleSheet(css));
 *
 * A sheet's rules are in the `app` layer, which has to come after Web Awesome's. Where Web Awesome's own sheets are
 * adopted (theme/vscode), they come after every `<style>` in the document, so the order is declared first in the
 * document's head, once (`layerOrder`): `vendor` (the DOM we host that isn't ours: dockview's sheet), Web Awesome's own
 * order (its layers.css), then `app`, and in it `app.base` (theme/stitches' globalCss), `app.recipes` (recipes.css),
 * `app.styles` (theme/stitches' css). A sheet's own rules are in `app` itself, so they come after those three.
 */
import layers from "@awesome.me/webawesome/dist/styles/layers.css?inline";

/** The layers, lowest first: vendors', Web Awesome's in its order, then the app's. */
const ORDER = ["@layer vendor;", layers.match(/@layer [^;{]+;/u)[0], "@layer app;", "@layer app.base, app.recipes, app.styles;"].join("\n");

/** Put the layer order first in `document`'s head, once. */
export function layerOrder(document = globalThis.document) {
	if (document.head.querySelector("style[data-layer-order]") === null) {
		const order = document.createElement("style");

		order.dataset.layerOrder = "";
		order.textContent = ORDER;
		document.head.prepend(order);
	}
}

/** A `<style>` holding `css`, for `document`, whose head has the layer order first. */
export function styleSheet(css, document = globalThis.document) {
	layerOrder(document);

	return Object.assign(document.createElement("style"), { "textContent": css });
}

/**
 * Copy the app's own `<style>`s from `source` into `target` — the document of a window VS Code opened, as a docked
 * editor's frame — and keep copying the ones added after; returns a function that stops. VS Code copies its own
 * stylesheets into such a window itself, and marks each `data-vscode`, but none of ours: the layer order, the exception
 * sheets `styleSheet` made, and Stitches' (whose rules it inserts, so its text is empty: rules are copied, not text).
 * A rule Stitches inserts after the copy isn't followed; in VS Code's document its styles are global ones made at boot.
 */
export function mirrorStyles(target, source = globalThis.document) {
	const ours = (node) => node instanceof source.defaultView.HTMLStyleElement && !node.hasAttribute("data-vscode");
	const copy = (style) => {
		const clone = target.createElement("style");

		for (const attribute of style.attributes) {
			clone.setAttribute(attribute.name, attribute.value);
		}

		// (the layer order first, as in the source; then the rules, which need the element in its document)
		target.head[style.dataset.layerOrder === undefined ? "append" : "prepend"](clone);

		for (const rule of style.sheet?.cssRules ?? []) {
			clone.sheet?.insertRule(rule.cssText, clone.sheet.cssRules.length);
		}
	};

	for (const style of source.head.querySelectorAll("style")) {
		if (ours(style)) {
			copy(style);
		}
	}

	const observer = new source.defaultView.MutationObserver((records) => {
		for (const node of records.flatMap((record) => [...record.addedNodes])) {
			if (ours(node)) {
				copy(node);
			}
		}
	});

	observer.observe(source.head, { "childList": true });

	return () => {
		observer.disconnect();
	};
}
