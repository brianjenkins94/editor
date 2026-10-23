/**
 * theme/vscode-theme — the theme's look in one call: Web Awesome with VS Code's (README.md, *VS Code's look everywhere*, *Published components*), published as
 * components/vscode-theme, so a page not built here gets it too.
 *
 *     vscodeTheme();                     // where the page is: VS Code's document, a webview, or anywhere else
 *     vscodeTheme(document.documentElement);   // the system's mode, wherever it is (theme/chrome)
 *
 * It sets VS Code's palette (a fixed copy of Default Light+ and Dark+, theme/tokens' vscodePalette), the bridge that
 * maps Web Awesome's tokens onto it (vscodeTokens) and the components as VS Code draws its own (theme/vscode-skin), and
 * keeps Web Awesome's mode class (`wa-dark` / `wa-light`) in step: inside VS Code (`.monaco-workbench`, or a webview's
 * `body[data-vscode-theme-kind]`) with its theme's kind, where its live colours are and win over the fixed copy; anywhere
 * else with the system's preference, on the root, whose basics it sets from the tokens there too (its font, text and
 * background, which Web Awesome's own theme would otherwise give). It loads none of Web Awesome: a page that has it gets
 * its components in this look, and one that hasn't still gets the look's tokens (which the published components read).
 * Returns a function that stops following the mode.
 */
import { globalCss } from "./stitches";
import { vscodePalette, vscodeTokens } from "./tokens";
import { vscodeSkin } from "./vscode-skin";

/** VS Code's theme kinds that are dark: the class it puts on `.monaco-workbench`, or a webview body's
 *  `data-vscode-theme-kind`. */
const DARK = ["vs-dark", "hc-black"];
const DARK_KINDS = ["vscode-dark", "vscode-high-contrast"];

/** The page's basics, from the tokens, under everything else's (`app.base`). */
const page = globalCss({
	":root": { "colorScheme": "light", "color": "var(--wa-color-text-normal)", "backgroundColor": "var(--wa-color-surface-default)", "fontFamily": "var(--wa-font-family-body)" },
	":root.wa-dark": { "colorScheme": "dark" }
});

export function vscodeTheme(element: HTMLElement = document.querySelector<HTMLElement>(".monaco-workbench, body[data-vscode-theme-kind]") ?? document.documentElement): () => void {
	vscodePalette();
	vscodeTokens();
	vscodeSkin();

	const mode = (dark: boolean) => {
		element.classList.toggle("wa-dark", dark);
		element.classList.toggle("wa-light", !dark);
	};

	if (element === element.ownerDocument.documentElement) {
		page(); // (inside VS Code, VS Code's page is its own)

		const system = element.ownerDocument.defaultView.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => {
			mode(system.matches);
		};

		sync();
		system.addEventListener("change", sync);

		return () => {
			system.removeEventListener("change", sync);
		};
	}

	// VS Code defines --vscode-font-family only in webviews. In its own document the UI font is the workbench element's
	// (set by platform), so the bridge's font tokens read that.
	const style = element.ownerDocument.defaultView.getComputedStyle(element);

	if (style.getPropertyValue("--vscode-font-family") === "") {
		element.style.setProperty("--vscode-font-family", style.fontFamily);
	}

	const sync = () => {
		mode(DARK.some((kind) => element.classList.contains(kind)) || DARK_KINDS.includes(element.dataset["vscodeThemeKind"] ?? ""));
	};
	const observer = new MutationObserver(sync);

	sync();
	observer.observe(element, { "attributes": true, "attributeFilter": ["class", "data-vscode-theme-kind"] });

	return () => {
		observer.disconnect();
	};
}
