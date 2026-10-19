/**
 * theme/vscode — Web Awesome in VS Code's document, following the active VS Code color theme.
 *
 * The workbench document has no stylesheet of its own to link (its build emits JavaScript only), so the styles come
 * in as text and are adopted: Web Awesome's layers, default theme and utility classes, our brand tokens, then the
 * bridge (vscode.css) that maps Web Awesome's tokens onto VS Code's. Not Web Awesome's native styles: VS Code's own
 * native elements would pick them up.
 *
 *     import { followVsCodeTheme } from "theme/vscode";
 *     followVsCodeTheme(workbenchContainer);  // the element VS Code makes `.monaco-workbench`
 */
import layers from "@awesome.me/webawesome/dist/styles/layers.css?inline";
import webAwesomeTheme from "@awesome.me/webawesome/dist/styles/themes/default.css?inline";
import utilities from "@awesome.me/webawesome/dist/styles/utilities.css?inline";
import brand from "./theme.css?inline";
import bridge from "./vscode.css?inline";

/** VS Code's theme types (the class it puts on `.monaco-workbench`) that are dark. */
const DARK = ["vs-dark", "hc-black"];

const adopted = new WeakSet();

/**
 * Adopt the styles into `workbench`'s document (once per document), and keep `workbench`'s Web Awesome mode class in
 * step with its VS Code theme type. Returns a function that stops following.
 */
export function followVsCodeTheme(workbench) {
	const document = workbench.ownerDocument;

	if (!adopted.has(document)) {
		adopted.add(document);

		const sheet = new document.defaultView.CSSStyleSheet();

		sheet.replaceSync([layers, webAwesomeTheme, utilities, brand, bridge].join("\n"));
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	}

	// VS Code defines --vscode-font-family only in webviews. In its own document the UI font is the workbench element's
	// (set by platform), so the bridge's font tokens read that.
	const style = document.defaultView.getComputedStyle(workbench);

	if (style.getPropertyValue("--vscode-font-family") === "") {
		workbench.style.setProperty("--vscode-font-family", style.fontFamily);
	}

	function sync() {
		const dark = DARK.some((type) => workbench.classList.contains(type));

		workbench.classList.toggle("wa-dark", dark);
		workbench.classList.toggle("wa-light", !dark);
	}

	sync();

	const observer = new MutationObserver(sync);

	observer.observe(workbench, { "attributes": true, "attributeFilter": ["class"] });

	return () => {
		observer.disconnect();
	};
}
