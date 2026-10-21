/**
 * theme/sheet — the layer order every document of the app shares, and a docked window's copy of the app's styles.
 *
 * Every style is in a layer (theme/stitches puts each in its own): Web Awesome's, then `app`. Where Web Awesome's own
 * sheets are adopted (theme/vscode), they come after every `<style>` in the document, so the order is declared first
 * in the document's head, once (`layerOrder`, which theme/stitches calls as it loads): `vendor` (the DOM we host that
 * isn't ours: dockview's sheet), Web Awesome's own order, then `app`, and in it `app.base`
 * (theme/stitches' globalCss), `app.recipes` (theme/recipes), `app.styles` (a surface's styles, theme/styles/*) and
 * `app.overrides` (a use-site `css`).
 */
import { layers } from "./web-awesome";

/** The layers, lowest first: vendors', Web Awesome's in its order (theme/web-awesome's, derived from its layers.css, so
 *  this needn't load Web Awesome), then the app's. */
const ORDER = ["@layer vendor;", layers, "@layer app;", "@layer app.base, app.recipes, app.styles, app.overrides;"].join("\n");

/** Put the layer order first in `document`'s head, once. */
export function layerOrder(document = globalThis.document) {
	if (document.head.querySelector("style[data-layer-order]") === null) {
		const order = document.createElement("style");

		order.dataset.layerOrder = "";
		order.textContent = ORDER;
		document.head.prepend(order);
	}
}

/**
 * Copy the app's own `<style>`s from `source` into `target` — the document of a window VS Code opened, as a docked
 * editor's frame — and keep copying the ones added after; returns a function that stops. VS Code copies its own
 * stylesheets into such a window itself, and marks each `data-vscode`, but none of ours: the layer order, and Stitches'
 * (whose rules it inserts, so its text is empty: rules are copied, not text).
 * A rule inserted after the copy — Stitches makes a style's rules when it's first used, so a view first drawn after the
 * window opened adds them then — is inserted into the copy too (`follow`).
 */
export function mirrorStyles(target, source = globalThis.document) {
	const unfollow = [];
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

		if (style.sheet !== null && clone.sheet !== null) {
			unfollow.push(follow(style.sheet, clone.sheet));
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

		for (const stop of unfollow) {
			stop();
		}
	};
}

/** What each followed rule list passes its inserts and deletes on to. */
const followers = new WeakMap();

/**
 * Pass what's inserted into `source` (a stylesheet, or a grouping rule in one) on to `copy`, made rule for rule like it:
 * into the sheet itself, and into each of its top-level groups (Stitches keeps its rules in groups it makes at the
 * start, `@media {}` blocks, and inserts into those). Returns a function that stops.
 */
function follow(source, copy) {
	const stops = [];
	const each = (list, mirror) => {
		let mirrors = followers.get(list);

		if (mirrors === undefined) {
			const insert = list.insertRule;
			const remove = list.deleteRule;

			mirrors = new Set();
			followers.set(list, mirrors);
			list.insertRule = function(rule, index) {
				const at = insert.call(this, rule, index);

				for (const other of mirrors) {
					try {
						other.insertRule(rule, at);
					} catch {
						// (a copy that's drifted from its source: it keeps what it has)
					}
				}

				return at;
			};

			list.deleteRule = function(index) {
				remove.call(this, index);

				for (const other of mirrors) {
					try {
						other.deleteRule(index);
					} catch {
						// (as above)
					}
				}
			};
		}

		mirrors.add(mirror);
		stops.push(() => mirrors.delete(mirror));
	};

	each(source, copy);

	for (const [index, rule] of [...source.cssRules].entries()) {
		const counterpart = copy.cssRules[index];

		if (typeof rule.insertRule === "function" && counterpart !== undefined && typeof counterpart.insertRule === "function") {
			each(rule, counterpart);
		}
	}

	return () => {
		for (const stop of stops) {
			stop();
		}
	};
}
