/**
 * theme/vscode-colors — VS Code's active colour theme, carried to a document that isn't VS Code's (README.md, *VS Code's look everywhere*).
 * VS Code declares its theme's `--vscode-*` variables only in its own document; the shell around it is another, so
 * the workbench reads them and the shell sets them on its body, where theme/vscode's mapping (theme/tokens' vscodeTokens) applies to
 * them as it does in VS Code's document and in a webview.
 *
 *     hub.publish("theme.colors", readVsCodeColors(workbenchElement));           // VS Code's document
 *     hub.subscribe("theme.colors", (colors) => applyVsCodeColors(document.body, colors));  // the shell
 */
import { vscodeTokens } from "./tokens";
import { vscodeSkin } from "./vscode-skin";

/** VS Code's theme types, as the class it puts on `.monaco-workbench`, and as a webview's `data-vscode-theme-kind`. */
const KINDS = { "vs": "vscode-light", "vs-dark": "vscode-dark", "hc-black": "vscode-high-contrast", "hc-light": "vscode-high-contrast-light" };
const DARK_KINDS = ["vscode-dark", "vscode-high-contrast"];

/** The active theme's colours (every `--vscode-*` but the icons') and its kind, from `.monaco-workbench`. */
export function readVsCodeColors(workbench) {
	const style = workbench.ownerDocument.defaultView.getComputedStyle(workbench);
	const vars = {};

	for (let index = 0; index < style.length; index += 1) {
		const name = style[index];

		if (name.startsWith("--vscode-") && !name.startsWith("--vscode-icon-")) {
			vars[name] = style.getPropertyValue(name).trim();
		}
	}

	// (in its own document VS Code sets the UI font on the element, not as a variable, as theme/vscode reads it there)
	vars["--vscode-font-family"] ??= style.fontFamily;

	const type = Object.keys(KINDS).find((name) => workbench.classList.contains(name)) ?? "vs";

	return { "kind": KINDS[type], "vars": vars };
}

const applied = new WeakMap();

/** Set `colors` on `element` (the shell's body), dropping any the previous theme had that this one hasn't, and mark it
 *  with the theme's kind and Web Awesome's mode for it. */
export function applyVsCodeColors(element, colors) {
	vscodeTokens(); // (the mapping that reads them, and the components as VS Code draws its own: once, the first time)
	vscodeSkin();

	for (const name of applied.get(element) ?? []) {
		if (!(name in colors.vars)) {
			element.style.removeProperty(name);
		}
	}

	for (const [name, value] of Object.entries(colors.vars)) {
		element.style.setProperty(name, value);
	}

	applied.set(element, Object.keys(colors.vars));
	element.dataset.vscodeThemeKind = colors.kind;
	element.classList.toggle("wa-dark", DARK_KINDS.includes(colors.kind));
	element.classList.toggle("wa-light", !DARK_KINDS.includes(colors.kind));
}
