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
 * document's head, once: Web Awesome's own order (its layers.css), then `app`.
 */
import layers from "@awesome.me/webawesome/dist/styles/layers.css?inline";

/** Web Awesome's layers, in its order, then the app's. */
const ORDER = layers.match(/@layer [^;{]+;/u)[0] + "\n@layer app;";

/** A `<style>` holding `css`, for `document`, whose head has the layer order first. */
export function styleSheet(css, document = globalThis.document) {
	if (document.head.querySelector("style[data-layer-order]") === null) {
		const order = document.createElement("style");

		order.dataset.layerOrder = "";
		order.textContent = ORDER;
		document.head.prepend(order);
	}

	return Object.assign(document.createElement("style"), { "textContent": css });
}
