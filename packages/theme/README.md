# theme

The app's theme, layered on top of [Web Awesome](https://webawesome.com) and expressed **entirely in `--wa-*` design
tokens** — the sandbox for rebranding the editor without writing our own component CSS.

## How it works

Web Awesome derives every component's appearance from tokens, in two layers:

1. **Color ramps** — `--wa-color-<role>-{10..95}` (10 darkest → 95 lightest) for `brand` / `neutral` / `success` /
   `warning` / `danger`. Semantic tokens point into the ramp (`--wa-color-brand-fill-loud: var(--wa-color-brand-50)`),
   so re-toning a role is just overriding its ramp steps.
2. **Semantic surface/text tokens** — `--wa-color-surface-*`, `--wa-color-text-*` — the page chrome.

`src/theme.css` overrides those tokens. Because it's only tokens, it re-skins every current and future `<wa-*>`
component at once.

## Usage

One import sets a document up: Web Awesome's layers, native styles, utility classes and default theme, then these
tokens, so the overrides win. It also keeps the root's `wa-light` / `wa-dark` class in step with the system's
light/dark preference, since Web Awesome switches mode by that class.

```ts
import "theme";
```

App chrome that hosts other people's DOM (the editor's shell: dockview, the codehike diff, iframes) takes
`theme/chrome` instead: the same, without Web Awesome's native styles, which style bare `button`, `svg`, `iframe`,
`pre` and `table` and make every box border-box.

```ts
import "theme/chrome";
```

Web Awesome resolves from the consumer's copy: list `@awesome.me/webawesome` in its Vite `resolve.dedupe`, as admin
and the editor do, or a stale copy beside this package can be picked up.

## In VS Code's document: `theme/vscode`

The workbench (VS Code's document) uses the same tokens, mapped onto the active VS Code color theme:

```ts
import { followVsCodeTheme } from "theme/vscode";

followVsCodeTheme(document.querySelector(".monaco-workbench"));
```

This adopts Web Awesome's theme and utility classes, these tokens, and `src/vscode.css` into that document.
`src/vscode.css` is the bridge from `--wa-*` to `--vscode-*`, and the only place a `--vscode-*` variable may appear.
The call also keeps the element's `wa-dark` / `wa-light` class in step with VS Code's theme type, so `<wa-*>`
components there follow a theme switch live. [PLAN.md](PLAN.md) has the design and the plan for the rest of the
custom CSS.

## Components: `theme/components/*`

The Web Awesome components the app may use, one module each: importing `theme/components/button` registers
`<wa-button>`, and `import type WaButton from "theme/components/button"` is its type. Code reaches Web Awesome only
through this package (`webawesome/through-theme`), and uses only the components here (`webawesome/known-components`):
to allow another, add `src/components/<name>.js` and `.d.ts`, each a one-line re-export.

## The layer order and docked windows: `theme/sheet`

Class names in code are a closed set (`webawesome/known-classes`): Web Awesome's, or one the theme styles. Every style
is in a layer, in the order `layerOrder()` puts first in a document once: `vendor` (dockview's sheet), Web Awesome's,
then `app` (`app.base`, `app.recipes`, `app.styles`, `app.overrides`). `mirrorStyles()` copies the app's styles into a
docked window, and the rules Stitches adds to them later.

## Recipes and composed components: `theme/recipes`, `theme/app-window`

`theme/recipes` is the app's shapes as Stitches recipes, a class for any element, from any framework:
`toolbar({ "density": "compact" })`, `caption({ "size": "2xs" })`. Overridable, least reach first: their variants;
their component tokens (`--app-toolbar-padding-inline`, `--app-caption-color`, …) set on an ancestor; a use-site
override, `toolbar({ "css": { … } })`, which wins by layer; or a new recipe composed from one, made here.
`theme/app-window` is `<app-window>`, a movable, collapsible window in light DOM: give it a `label`, `closable`,
`storage-key`, a `slot="header-actions"` child and a body (PLAN.md §8).

## Surface styles: `theme/styles/*`

What a surface draws with beyond Web Awesome and the recipes, made here with Stitches, one module per surface: the
shell, its dock, the preview, VS Code's document (`workbench`: VS Code's baseline, its overrides on `--vscode-*`), and
each view's (architecture-view, pane-views, margin, rule-view, rule-editor, git-panel, event-sheet, insights-monitor,
admin, account). The app imports their named styles, or calls a surface's `stylesheet()` once; it doesn't call
Stitches itself, and it has no stylesheets of its own (`webawesome/css-only-in-theme`, `no-css-imports`).

## CSS-in-JS: `theme/stitches`

The app's one Stitches instance (`css`, `recipe`, `globalCss`, `keyframes`, `theme`, and the `palette` of tokens under the
shell's names), the theme's own: nothing outside the theme imports it or `@stitches/core` (`webawesome/through-theme`). Its values are `--wa-*` tokens
(`webawesome/css-in-js-tokens`). Its output is layered: `css()` in `app.styles`, `globalCss()` in `app.base`. Only
`unlayeredGlobalCss` isn't, for what overrides CSS that isn't layered (VS Code's, in Workbench.tsx). `stylesheet()` is a surface's styles by selector, in
`app.styles`. In VS Code's document, `mirrorStyles` from `theme/sheet` copies them into a docked window, which VS
Code doesn't.

## What's left

What's left is budgeted (`budget.json`, checked by `test/budget.mjs`): the surfaces' declarations (`theme/styles/*`,
and a use-site `css` override wherever it is), and the comments that turn a `webawesome/*` rule off. The recipes,
components and tokens aren't: they're the vocabulary. Each may only
go down; a raise means editing `budget.json`, and a drop means lowering it.

## This starter

Light and dark alike, following the system, with the brand ramp set to the editor's blue accent (`#3794ff` at the
mid step). Every value is a starting point — iterate here rather than in component styles.
