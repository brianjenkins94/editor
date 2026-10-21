/**
 * theme/vscode-skin — Web Awesome's components as VS Code draws its own (PLAN.md §9.2.2), where no token reaches: their
 * parts, in a document on the VS Code theme (VS Code's own, a webview, the shell carrying its colours), so admin keeps
 * Web Awesome's look. The tokens do the rest (theme/tokens' vscodeTokens: VS Code's corner radii and shadows, a
 * control's height, padding and weight). theme/vscode and theme/vscode-colors call it with the tokens.
 */
import { stylesheet } from "./stitches";

/** Where the VS Code theme is: VS Code's document, or a body marked with its kind (a webview, the shell). */
const VSCODE = ":is(.monaco-workbench, body[data-vscode-theme-kind])";

export const vscodeSkin = stylesheet({
	// A dropdown is VS Code's context menu: its background, border, corner and depth, and its selection's colours on the
	// item under the pointer or the keyboard.
	[`${VSCODE} wa-dropdown::part(menu)`]: {
		"backgroundColor": "var(--vscode-menu-background)",
		"color": "var(--vscode-menu-foreground)",
		"borderColor": "var(--vscode-menu-border, var(--vscode-widget-border))",
		"borderRadius": "var(--wa-border-radius-l)",
		"boxShadow": "var(--wa-shadow-l)"
	},
	[`${VSCODE} wa-dropdown-item`]: {
		"color": "var(--vscode-menu-foreground)"
	},
	[`${VSCODE} wa-dropdown-item:hover, ${VSCODE} wa-dropdown-item:focus-visible`]: {
		"backgroundColor": "var(--vscode-menu-selectionBackground)",
		"color": "var(--vscode-menu-selectionForeground)",
		"outline": "none"
	},
	// A checkbox is VS Code's: its own box and border, the check in its foreground, not a filled brand square.
	[`${VSCODE} wa-checkbox::part(control)`]: {
		"backgroundColor": "var(--vscode-checkbox-background)",
		"borderColor": "var(--vscode-checkbox-border)",
		"borderRadius": "var(--wa-border-radius-s)"
	},
	[`${VSCODE} wa-checkbox::part(checked-icon), ${VSCODE} wa-checkbox::part(indeterminate-icon)`]: {
		"color": "var(--vscode-checkbox-foreground)"
	}
});
