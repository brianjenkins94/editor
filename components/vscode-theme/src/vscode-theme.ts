/**
 * @brianjenkins94/vscode-theme — the theme's look, Web Awesome as VS Code (packages/theme/src/vscode-theme.ts),
 * published (packages/theme/README.md, *Published components*): importing it applies it where the page is (VS Code's document, a webview, or anywhere else,
 * following the system's mode there), and `vscodeTheme(element)` applies it for another. util-publish bundles it from
 * there.
 *
 *     import "@brianjenkins94/vscode-theme";
 */
import { vscodeTheme } from "../../../packages/theme/src/vscode-theme";

vscodeTheme();

export { vscodeTheme };
