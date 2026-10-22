/**
 * theme/chrome — the styling setup for app chrome outside VS Code (the shell): `theme` without Web Awesome's native
 * styles.
 *
 *     import "theme/chrome";
 *
 * Web Awesome's layers, utility classes and default theme, then our brand tokens (theme/tokens) and the look
 * (theme/vscode-theme), so the tokens win. The document follows the system's light/dark preference: Web Awesome
 * switches mode by the `wa-light` / `wa-dark` class on the root, not by `prefers-color-scheme`, so theme/vscode-theme
 * keeps the root's class in step with it, live.
 *
 * Native styles are left out because chrome hosts other people's DOM (dockview, the codehike diff, iframes): they
 * style bare `button`, `svg`, `iframe`, `pre` and `table` and make every box border-box, so that DOM would change
 * under them. A page of our own content takes `theme`, which adds them. In VS Code's document it's theme/vscode.
 */
import "@awesome.me/webawesome/dist/styles/layers.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import { brandTokens } from "./tokens";
import { vscodeTheme } from "./vscode-theme";

// The theme: Web Awesome with VS Code's look (PLAN.md §9.2.5) — the brand, and theme/vscode-theme's look (VS Code's
// palette, a fixed copy of the editor's default themes until the editor sends the live one; the bridge onto it; the
// components as VS Code's), on the root, following the system's mode.
brandTokens();
vscodeTheme(document.documentElement);
