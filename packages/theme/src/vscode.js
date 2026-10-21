/**
 * theme/vscode — Web Awesome in VS Code's document, or in a webview, following the active VS Code color theme.
 *
 * Neither document has a stylesheet of its own to link (the workbench's build emits JavaScript only, and a webview is
 * given its page as a string), so the styles come in as text and are adopted: Web Awesome's layers, default theme and
 * utility classes; then our brand tokens and the bridge that maps Web Awesome's tokens onto (theme/tokens, Stitches) VS Code's. Not
 * Web Awesome's native styles: VS Code's own native elements, and a webview's default styles, would meet them.
 *
 *     import { followVsCodeTheme } from "theme/vscode";
 *     followVsCodeTheme(workbenchContainer);  // the element VS Code makes `.monaco-workbench`
 *     followVsCodeTheme(document.body);       // in a webview
 */
import layers from "@awesome.me/webawesome/dist/styles/layers.css?inline";
import webAwesomeTheme from "@awesome.me/webawesome/dist/styles/themes/default.css?inline";
import utilities from "@awesome.me/webawesome/dist/styles/utilities.css?inline";
import { brandTokens, vscodeTokens } from "./tokens";
import { vscodeSkin } from "./vscode-skin";

/** VS Code's theme types that are dark: the class it puts on `.monaco-workbench`, or a webview body's
 *  `data-vscode-theme-kind`. */
const DARK = ["vs-dark", "hc-black"];
const DARK_KINDS = ["vscode-dark", "vscode-high-contrast"];

const adopted = new WeakSet();

/**
 * Adopt the styles into `element`'s document (once per document), and keep `element`'s Web Awesome mode class in step
 * with its VS Code theme type. `element` is `.monaco-workbench`, or a webview's `body`. Returns a function that stops
 * following.
 */
export function followVsCodeTheme(element) {
	const document = element.ownerDocument;

	if (!adopted.has(document)) {
		adopted.add(document);

		const sheet = new document.defaultView.CSSStyleSheet();

		sheet.replaceSync([layers, webAwesomeTheme, utilities].join("\n"));
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	}

	// (Stitches puts them in its own document's head; a docked window gets them from there, by mirrorStyles)
	brandTokens();
	vscodeTokens();
	vscodeSkin();

	// VS Code defines --vscode-font-family only in webviews. In its own document the UI font is the workbench element's
	// (set by platform), so the bridge's font tokens read that.
	const style = document.defaultView.getComputedStyle(element);

	if (style.getPropertyValue("--vscode-font-family") === "") {
		element.style.setProperty("--vscode-font-family", style.fontFamily);
	}

	function sync() {
		const dark = DARK.some((type) => element.classList.contains(type)) || DARK_KINDS.includes(element.dataset.vscodeThemeKind);

		element.classList.toggle("wa-dark", dark);
		element.classList.toggle("wa-light", !dark);
	}

	sync();

	const observer = new MutationObserver(sync);

	observer.observe(element, { "attributes": true, "attributeFilter": ["class", "data-vscode-theme-kind"] });

	return () => {
		observer.disconnect();
	};
}

/**
 * Follow the VS Code theme in a document VS Code opens a window into (a docked editor window), whose `.monaco-workbench`
 * VS Code makes after handing it the window: the styles adopted there now, and its mode followed once that element is
 * in. Returns a function that stops. (The styles must be this document's own: a window VS Code restores at boot exists
 * before the editor's document has them, so it has no copy of them to take.)
 */
export function followVsCodeThemeIn(document) {
	let stop = () => undefined;
	const start = () => {
		const workbench = document.querySelector(".monaco-workbench");

		if (workbench === null) {
			return false;
		}

		stop = followVsCodeTheme(workbench);

		return true;
	};

	if (start()) {
		return () => {
			stop();
		};
	}

	const waiting = new document.defaultView.MutationObserver(() => {
		if (start()) {
			waiting.disconnect();
		}
	});

	waiting.observe(document.documentElement, { "childList": true, "subtree": true });

	return () => {
		waiting.disconnect();
		stop();
	};
}
