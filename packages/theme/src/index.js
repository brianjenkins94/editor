/**
 * theme — the styling setup for a page outside VS Code (admin, account): one import.
 *
 *     import "theme";
 *
 * theme/chrome (Web Awesome's layers, utility classes and default theme, our brand tokens, and the system's light/dark
 * mode), plus Web Awesome's native styles, so bare headings, tables, links and form elements look like Web Awesome's.
 * Native styles are in their own layer (wa-native, the lowest), which chrome.js declared first, so loading them last
 * changes nothing in the cascade. App chrome that hosts other people's DOM (the shell) takes theme/chrome alone.
 */
import "./chrome.js";
import "@awesome.me/webawesome/dist/styles/native.css";
