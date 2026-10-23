/**
 * theme/documents — Web Awesome in more than one document (README.md, *Gotchas*): import it first, before any component, in a
 * realm whose components move into other documents, as VS Code's do into a docked window (an `about:blank` frame).
 *
 *     import "theme/documents";
 *
 * Lit gives each component's shadow root its styles as constructed stylesheets, made once in the document that loaded
 * it. Another document refuses them ("Sharing constructed stylesheets in multiple documents is not allowed"), so a
 * component made in a docked window doesn't render, and one moved there loses its styles. Lit takes its other way when
 * the platform can't adopt stylesheets: a `<style>` in each shadow root, which goes wherever its component goes. It
 * decides once, as it loads, by whether `ShadyCSS` (the old polyfill) says shadow DOM isn't native; saying so here is
 * what turns that way on. Nothing else reads it (checked in the workbench bundle and VS Code's), and the browser shares
 * the parsed contents of identical `<style>`s, so a component's styles are parsed once all the same.
 */
globalThis.ShadyCSS ??= { "nativeShadow": false };
