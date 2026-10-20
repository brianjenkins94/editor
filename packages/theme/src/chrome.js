/**
 * theme/chrome — the styling setup for app chrome outside VS Code (the shell): `theme` without Web Awesome's native
 * styles.
 *
 *     import "theme/chrome";
 *
 * Web Awesome's layers, utility classes and default theme, then our brand tokens (theme.css), so the tokens win, and the
 * recipes (recipes.css: the app's shapes, one class each). Then
 * the document follows the system's light/dark preference: Web Awesome switches mode by the `wa-light` / `wa-dark`
 * class on the root, not by `prefers-color-scheme`, so the root's class is kept in step with it, live.
 *
 * Native styles are left out because chrome hosts other people's DOM (dockview, the codehike diff, iframes): they
 * style bare `button`, `svg`, `iframe`, `pre` and `table` and make every box border-box, so that DOM would change
 * under them. A page of our own content takes `theme`, which adds them. In VS Code's document it's theme/vscode.
 */
import "@awesome.me/webawesome/dist/styles/layers.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "./theme.css";
import "./recipes.css";

const dark = window.matchMedia("(prefers-color-scheme: dark)");

function sync() {
	document.documentElement.classList.toggle("wa-dark", dark.matches);
	document.documentElement.classList.toggle("wa-light", !dark.matches);
}

sync();
dark.addEventListener("change", sync);
