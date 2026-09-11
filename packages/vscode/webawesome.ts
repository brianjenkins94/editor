/**
 * WebAwesome setup — the theme tokens the window chrome (window.ts) draws with.
 *
 * The `--wa-*` custom properties (spacing, colors, font weights) come from the theme stylesheet;
 * the utilities sheet backs any `wa-*` utility classes. Component definitions (`wa-card`, `wa-button`)
 * are imported where they're used (window.ts) so a consumer that only needs the tokens doesn't pull
 * the component JS. Import this ONCE per document that renders WebAwesome chrome (the host page).
 *
 * Mirrors sms-reference-app/app/src/webawesome.ts, trimmed to what the editor's window needs.
 */
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
