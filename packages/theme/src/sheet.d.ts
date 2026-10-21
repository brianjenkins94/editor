/** Put the layer order first in `document`'s head, once: `vendor`, Web Awesome's, then `app` (`app.base`, `app.recipes`,
 *  `app.styles`, `app.overrides`). */
export function layerOrder(document?: Document): void;

/** Copy the app's own `<style>`s (not VS Code's: `data-vscode`) from `source` into `target`, a window VS Code opened,
 *  and keep copying the ones added after. Returns a function that stops. */
export function mirrorStyles(target: Document, source?: Document): () => void;
