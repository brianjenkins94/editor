/**
 * theme/tokens — the theme's tokens, as Stitches: the brand's, over Web Awesome's defaults, and
 * the bridge that maps Web Awesome's onto the active VS Code theme. Unlayered, on purpose: token definitions that have
 * to win over Web Awesome's own, which are layered. theme/chrome and theme/vscode call them; nothing else needs to. Together they're a Web Awesome theme with VS Code's look
 * (README.md, *VS Code's look everywhere*).
 */
import { unlayeredGlobalCss } from "./stitches";

/** The brand: the app's theme, layered on Web Awesome and expressed entirely in --wa-* design tokens.
 * The whole point of these (and of this pivot): rebrand by RETONING WEB AWESOME'S TOKENS, not by writing our own
 * component CSS. Unlayered, so they win over Web Awesome's default theme; `import "theme"` (or theme/chrome, or theme/vscode
 * in VS Code's document) sets them.
 * MODE-AGNOSTIC. Web Awesome switches light/dark via the `.wa-light` / `.wa-dark` classes on the root (the `theme`
 * entry sets them from `prefers-color-scheme`), and its default theme supplies the per-mode SURFACE and TEXT tokens. So these
 * override only the BRAND color ramp — `--wa-color-brand-{10..95}` (10 = darkest, 95 = lightest) — which the semantic
 * tokens point into (`--wa-color-brand-fill-loud: var(--wa-color-brand-50)`, and in dark mode fill-quiet →
 * brand-10, in light mode → brand-95). Because the ramp spans dark→light, the SAME ramp reads correctly in both
 * modes, so re-toning the brand here rebrands every `<wa-*>` component in light and dark alike, with no per-mode CSS.
 * Focus follows the brand mid. (Add `.wa-dark` / `.wa-light` keys here if a token ever needs to differ
 * per mode.)
 */
export const brandTokens = unlayeredGlobalCss({
	":root": {
		// Brand ramp — the editor blue (#3794ff at -50). Everything brand-colored (buttons, focus, links) follows from it.
		"--wa-color-brand-10": "#071a33",
		"--wa-color-brand-20": "#0a2a52",
		"--wa-color-brand-30": "#0f3d78",
		"--wa-color-brand-40": "#1e5fb0",
		"--wa-color-brand-50": "#3794ff",
		"--wa-color-brand-60": "#5aa8ff",
		"--wa-color-brand-70": "#83c0ff",
		"--wa-color-brand-80": "#add6ff",
		"--wa-color-brand-90": "#d6ebff",
		"--wa-color-brand-95": "#ebf5ff",
		// Focus ring picks up the brand mid so keyboard focus reads as "editor blue" in either mode.
		"--wa-color-focus": "var(--wa-color-brand-50)"
	}
});

/**
 * VS Code's look where VS Code isn't (README.md, *VS Code's look everywhere*): a fixed copy of the editor's default themes' colours (Default
 * Light+ and Default Dark+, the ones the editor itself takes from the system's mode), read from VS Code 1.142 and
 * declared as VS Code declares them, so the bridge below applies to them as it does to the live ones. On the document's
 * root only: where VS Code's own are (on `.monaco-workbench`, a webview's root, the shell's body), they're lower in the
 * tree or inline, so they win, and the active theme is followed there. Admin and the account pages, with no VS Code,
 * get these. Light unless the root is `wa-dark` (theme/chrome keeps it in step with the system).
 */
export const vscodePalette = unlayeredGlobalCss({
	":root": {
		// VS Code's own fonts (its UI's stack, and its editor's), as it sets them per platform.
		"--vscode-font-family": "-apple-system, BlinkMacSystemFont, \"Segoe WPC\", \"Segoe UI\", system-ui, \"Ubuntu\", \"Droid Sans\", sans-serif",
		"--vscode-editor-font-family": "Menlo, Monaco, Consolas, \"Droid Sans Mono\", \"Courier New\", monospace",
		"--vscode-cornerRadius-medium": "6px",
		"--vscode-cornerRadius-small": "4px",
		"--vscode-cornerRadius-xSmall": "2px",
		"--vscode-shadow-lg": "0 0 12px rgba(0, 0, 0, 0.14)",
		"--vscode-shadow-md": "0 0 6px rgba(0, 0, 0, 0.08)",
		"--vscode-shadow-sm": "0 0 0 0 transparent",
		"--vscode-button-background": "#007acc",
		"--vscode-button-foreground": "#ffffff",
		"--vscode-button-secondaryBackground": "#e8e8e8",
		"--vscode-button-secondaryForeground": "#616161",
		"--vscode-checkbox-background": "#ffffff",
		"--vscode-checkbox-border": "#919191",
		"--vscode-checkbox-foreground": "#616161",
		"--vscode-debugTokenExpression-boolean": "#0000ff",
		"--vscode-debugTokenExpression-name": "#9b46b0",
		"--vscode-debugTokenExpression-number": "#098658",
		"--vscode-debugTokenExpression-string": "#a31515",
		"--vscode-descriptionForeground": "#717171",
		"--vscode-editor-background": "#ffffff",
		"--vscode-editorGroup-border": "#e7e7e7",
		"--vscode-editorWidget-background": "#f3f3f3",
		"--vscode-editorWidget-border": "rgba(97, 97, 97, 0.2)",
		"--vscode-focusBorder": "#0090f1",
		"--vscode-foreground": "#616161",
		"--vscode-input-background": "#ffffff",
		"--vscode-input-foreground": "#616161",
		"--vscode-input-placeholderForeground": "#767676",
		"--vscode-menu-background": "#ffffff",
		"--vscode-menu-border": "#d4d4d4",
		"--vscode-menu-foreground": "#616161",
		"--vscode-menu-selectionBackground": "#0060c0",
		"--vscode-menu-selectionForeground": "#ffffff",
		"--vscode-sideBar-background": "#f3f3f3",
		"--vscode-textLink-foreground": "#006ab1",
		"--vscode-titleBar-activeBackground": "#dddddd",
		"--vscode-titleBar-activeForeground": "#333333",
		"--vscode-titleBar-inactiveBackground": "#e5e5e5",
		"--vscode-titleBar-inactiveForeground": "rgba(51, 51, 51, 0.6)",
		"--vscode-widget-border": "#d4d4d4",
		"--vscode-widget-shadow": "rgba(0, 0, 0, 0.16)"
	},
	":root.wa-dark": {
		"--vscode-button-background": "#0e639c",
		"--vscode-button-foreground": "#ffffff",
		"--vscode-button-secondaryBackground": "#2a2d2e",
		"--vscode-button-secondaryForeground": "#cccccc",
		"--vscode-checkbox-background": "#3c3c3c",
		"--vscode-checkbox-border": "#6b6b6b",
		"--vscode-checkbox-foreground": "#f0f0f0",
		"--vscode-debugTokenExpression-boolean": "#4e94ce",
		"--vscode-debugTokenExpression-name": "#c586c0",
		"--vscode-debugTokenExpression-number": "#b5cea8",
		"--vscode-debugTokenExpression-string": "#ce9178",
		"--vscode-descriptionForeground": "rgba(204, 204, 204, 0.7)",
		"--vscode-editor-background": "#1e1e1e",
		"--vscode-editorGroup-border": "#444444",
		"--vscode-editorWidget-background": "#252526",
		"--vscode-editorWidget-border": "rgba(204, 204, 204, 0.2)",
		"--vscode-focusBorder": "#007fd4",
		"--vscode-foreground": "#cccccc",
		"--vscode-input-background": "#3c3c3c",
		"--vscode-input-foreground": "#cccccc",
		"--vscode-input-placeholderForeground": "#a6a6a6",
		"--vscode-menu-background": "#252526",
		"--vscode-menu-border": "#454545",
		"--vscode-menu-foreground": "#cccccc",
		"--vscode-menu-selectionBackground": "#0078d4",
		"--vscode-menu-selectionForeground": "#ffffff",
		"--vscode-sideBar-background": "#252526",
		"--vscode-textLink-foreground": "#3794ff",
		"--vscode-titleBar-activeBackground": "#3c3c3c",
		"--vscode-titleBar-activeForeground": "#cccccc",
		"--vscode-titleBar-inactiveBackground": "#323233",
		"--vscode-titleBar-inactiveForeground": "rgba(204, 204, 204, 0.6)",
		"--vscode-widget-border": "#303031",
		"--vscode-widget-shadow": "rgba(0, 0, 0, 0.36)"
	}
});

/** The bridge (theme/vscode's): Web Awesome's tokens, mapped onto the active VS Code color theme.
 * The one place a --vscode-* variable is read for a token. VS Code declares
 * its theme's variables on `.monaco-workbench` in its own document, and on a webview's `html` (marking its `body` with
 * the theme's kind), so the mapping is declared on `.monaco-workbench` and on a webview's `body`: a custom property has
 * to be resolved where the value it reads is defined, or below it. theme/vscode puts Web Awesome's `wa-dark` / `wa-light`
 * class on the same element, from VS Code's theme type, so every token not mapped here comes from Web Awesome's own
 * ramp for that mode.
 */
export const vscodeTokens = unlayeredGlobalCss({
	":root, .monaco-workbench, body[data-vscode-theme-kind]": {
		// Type and density: VS Code's UI font at its 13px size, and spacing to match.
		"--wa-font-family-body": "var(--vscode-font-family)",
		"--wa-font-family-heading": "var(--vscode-font-family)",
		// VS Code sets its editor font on each editor, not here: outside one, Web Awesome's own code font.
		"--wa-font-family-code": "var(--vscode-editor-font-family, ui-monospace, monospace)",
		"--wa-font-size-scale": "0.8125",
		"--wa-space-scale": "0.75",
		// Shapes: VS Code's own corner radii and shadows (1.142 defines them; the fallbacks are its values), so a control's
		// corners and a popup's depth are VS Code's.
		"--wa-border-radius-s": "var(--vscode-cornerRadius-xSmall, 2px)",
		"--wa-border-radius-m": "var(--vscode-cornerRadius-small, 4px)",
		"--wa-border-radius-l": "var(--vscode-cornerRadius-medium, 6px)",
		"--wa-shadow-s": "var(--vscode-shadow-sm, none)",
		"--wa-shadow-m": "var(--vscode-shadow-md, 0 0 6px var(--vscode-widget-shadow))",
		"--wa-shadow-l": "var(--vscode-shadow-lg, 0 0 12px var(--vscode-widget-shadow))",
		// Surfaces and text.
		"--wa-color-surface-default": "var(--vscode-editor-background)",
		"--wa-color-surface-raised": "var(--vscode-editorWidget-background)",
		"--wa-color-surface-lowered": "var(--vscode-sideBar-background)",
		"--wa-color-surface-border": "var(--vscode-editorWidget-border)",
		"--wa-color-text-normal": "var(--vscode-foreground)",
		"--wa-color-text-quiet": "var(--vscode-descriptionForeground)",
		"--wa-color-text-link": "var(--vscode-textLink-foreground)",
		"--wa-color-focus": "var(--vscode-focusBorder)",
		// Brand is VS Code's primary button; neutral, its secondary button.
		"--wa-color-brand-fill-loud": "var(--vscode-button-background)",
		"--wa-color-brand-on-loud": "var(--vscode-button-foreground)",
		"--wa-color-neutral-fill-loud": "var(--vscode-button-secondaryBackground)",
		"--wa-color-neutral-on-loud": "var(--vscode-button-secondaryForeground)",
		// Form controls (buttons included) are VS Code's: 26px tall (a text button's 4px + 16px line + 4px, and its border),
		// 8px in from the side, a 4px corner, its normal weight for a button's label, and an 18px checkbox.
		"--wa-form-control-height": "26px",
		"--wa-form-control-padding-block": "4px",
		"--wa-form-control-padding-inline": "8px",
		"--wa-form-control-border-radius": "var(--vscode-cornerRadius-small, 4px)",
		"--wa-form-control-toggle-size": "18px",
		"--wa-font-weight-action": "var(--wa-font-weight-normal)",
		// Form controls are VS Code's inputs.
		"--wa-form-control-background-color": "var(--vscode-input-background)",
		"--wa-form-control-border-color": "var(--vscode-input-border, var(--vscode-editorWidget-border))",
		"--wa-form-control-value-color": "var(--vscode-input-foreground)",
		"--wa-form-control-placeholder-color": "var(--vscode-input-placeholderForeground)",
		"--wa-form-control-activated-color": "var(--vscode-focusBorder)",
		// What Web Awesome has no token for: a value's colours as VS Code's debugger shows them, so the Margin's live values
		// read like its hover. Not --wa-*, since they aren't Web Awesome's.
		"--code-value-name": "var(--vscode-debugTokenExpression-name)",
		"--code-value-string": "var(--vscode-debugTokenExpression-string)",
		"--code-value-number": "var(--vscode-debugTokenExpression-number)",
		"--code-value-boolean": "var(--vscode-debugTokenExpression-boolean)"
	},
	// The shell's dock (dockview), in the shell once it carries VS Code's colours (theme/vscode-colors): a window's bar is
	// VS Code's title bar, so a docked editor's window reads as one of VS Code's own, its title in the bar and the editor's
	// tabs and status bar inside; groups and separators are VS Code's editor groups'. On dockview's theme class, which
	// declares its own values there.
	":is(.dockview-theme-light, .dockview-theme-dark)": {
		"--dv-group-view-background-color": "var(--vscode-editor-background)",
		"--dv-tabs-and-actions-container-background-color": "var(--vscode-titleBar-activeBackground)",
		"--dv-floating-titlebar-background-color": "var(--vscode-titleBar-activeBackground)",
		"--dv-activegroup-visiblepanel-tab-background-color": "var(--vscode-titleBar-activeBackground)",
		"--dv-inactivegroup-visiblepanel-tab-background-color": "var(--vscode-titleBar-inactiveBackground)",
		"--dv-activegroup-hiddenpanel-tab-background-color": "var(--vscode-titleBar-activeBackground)",
		"--dv-inactivegroup-hiddenpanel-tab-background-color": "var(--vscode-titleBar-inactiveBackground)",
		"--dv-activegroup-visiblepanel-tab-color": "var(--vscode-titleBar-activeForeground)",
		"--dv-inactivegroup-visiblepanel-tab-color": "var(--vscode-titleBar-inactiveForeground)",
		"--dv-activegroup-hiddenpanel-tab-color": "var(--vscode-titleBar-inactiveForeground)",
		"--dv-inactivegroup-hiddenpanel-tab-color": "var(--vscode-titleBar-inactiveForeground)",
		"--dv-tab-divider-color": "var(--vscode-titleBar-activeBackground)",
		"--dv-separator-border": "var(--vscode-editorGroup-border)",
		"--dv-floating-border": "var(--wa-border-width-s) solid var(--vscode-titleBar-border, var(--vscode-editorGroup-border))",
		"--dv-floating-box-shadow": "0 0 8px 2px var(--vscode-widget-shadow)",
		"--dv-tabs-and-actions-container-font-size": "var(--wa-font-size-s)"
	}
});
