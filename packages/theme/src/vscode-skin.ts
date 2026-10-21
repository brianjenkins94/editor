/**
 * theme/vscode-skin — Web Awesome's components as VS Code draws its own (PLAN.md §9.2.2), where no token reaches: their
 * parts, on every page the theme is on (VS Code's colours there are the live ones, or the theme's fixed copy). The tokens
 * do the rest (theme/tokens' vscodeTokens: VS Code's corner radii and shadows, a
 * control's height, padding and weight). theme/chrome, theme/vscode and theme/vscode-colors call it with the tokens.
 */
import { stylesheet } from "./stitches";

export const vscodeSkin = stylesheet({
	// A dropdown is VS Code's context menu: its background, border, corner and depth, and its selection's colours on the
	// item under the pointer or the keyboard.
	"wa-dropdown::part(menu)": {
		"backgroundColor": "var(--vscode-menu-background)",
		"color": "var(--vscode-menu-foreground)",
		"borderColor": "var(--vscode-menu-border, var(--vscode-widget-border))",
		"borderRadius": "var(--wa-border-radius-l)",
		"boxShadow": "var(--wa-shadow-l)"
	},
	"wa-dropdown-item": {
		"color": "var(--vscode-menu-foreground)"
	},
	"wa-dropdown-item:hover, wa-dropdown-item:focus-visible": {
		"backgroundColor": "var(--vscode-menu-selectionBackground)",
		"color": "var(--vscode-menu-selectionForeground)",
		"outline": "none"
	},
	// A checkbox is VS Code's: its own box and border, the check in its foreground, not a filled brand square.
	"wa-checkbox::part(control)": {
		"backgroundColor": "var(--vscode-checkbox-background)",
		"borderColor": "var(--vscode-checkbox-border)",
		"borderRadius": "var(--wa-border-radius-s)"
	},
	"wa-checkbox::part(checked-icon), wa-checkbox::part(indeterminate-icon)": {
		"color": "var(--vscode-checkbox-foreground)"
	}
});
