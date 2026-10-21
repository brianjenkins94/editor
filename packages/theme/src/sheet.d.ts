/** Put the layer order first in `document`'s head, once: `vendor`, Web Awesome's, then `app` (`app.base`, `app.recipes`,
 *  `app.styles`, `app.overrides`, then its own rules). */
export function layerOrder(document?: Document): void;

/** A `<style>` holding `css` (an exception sheet, imported `?raw`), for `document`, whose head has the layer order first:
 *  `layerOrder`'s. */
export function styleSheet(css: string, document?: Document): HTMLStyleElement;

/** Copy the app's own `<style>`s (not VS Code's: `data-vscode`) from `source` into `target`, a window VS Code opened,
 *  and keep copying the ones added after. Returns a function that stops. */
export function mirrorStyles(target: Document, source?: Document): () => void;
