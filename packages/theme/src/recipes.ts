/**
 * theme/recipes — the app's shapes as Stitches recipes (PLAN.md §8.2): a class for a Web Awesome element or plain
 * markup, framework-free, so `class=`, `className=` and `element(tag, className)` all take it.
 *
 *     import { caption, toolbar } from "theme/recipes";
 *     element("div", toolbar({ "density": "compact" }) + " wa-cluster wa-gap-xs");
 *
 * Each is overridable, least reach first: its variants; its component tokens, read with Web Awesome's as the fallback,
 * so a subtree, a document or a brand retunes it by setting them on an ancestor (`--app-toolbar-padding-block: 0`);
 * a use-site override, `toolbar({ "css": { … } })`, which wins by layer (`app.overrides`); and a new recipe composed
 * from it (`recipe(toolbar, { … })`).
 *
 * Each is published as a package of its own from components/ (PLAN.md §10); this is the theme's one way in to them.
 */
export { caption } from "../../../components/caption/src/caption";
export { code } from "../../../components/code/src/code";
export { frame } from "../../../components/frame/src/frame";
export { toolbar } from "../../../components/toolbar/src/toolbar";
