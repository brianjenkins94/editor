# theme

The app's theme, layered on top of [Web Awesome](https://webawesome.com) and expressed **entirely in `--wa-*` design
tokens** — the sandbox for rebranding the editor without writing our own component CSS. All of the app's styling goes
through it. What to use comes first; why it's this way is after it, under [Why](#why).

## How it works

Web Awesome derives every component's appearance from tokens, in two layers:

1. **Color ramps** — `--wa-color-<role>-{10..95}` (10 darkest → 95 lightest) for `brand` / `neutral` / `success` /
   `warning` / `danger`. Semantic tokens point into the ramp (`--wa-color-brand-fill-loud: var(--wa-color-brand-50)`),
   so re-toning a role is just overriding its ramp steps.
2. **Semantic surface/text tokens** — `--wa-color-surface-*`, `--wa-color-text-*` — the page chrome.

`src/tokens.ts` overrides those tokens (`brandTokens`). Because it's only tokens, it re-skins every current and future
`<wa-*>` component at once.

## The look: Web Awesome as VS Code

The theme is a Web Awesome theme with VS Code's look ([*VS Code's look everywhere*](#vs-codes-look-everywhere)): Web
Awesome's tokens map onto VS Code's colours and shapes, and the components it can't reach by tokens are drawn as VS
Code's (`theme/vscode-skin`). Where VS Code is (its document, a webview, the shell once the editor sends its colours)
the live theme is followed; anywhere else (admin, the account pages) it's a fixed copy of the editor's default themes,
Default Light+ and Dark+, by the system's mode.

## Usage

One import sets a document up: Web Awesome's layers, native styles, utility classes and default theme, then these
tokens, so the overrides win. It also keeps the root's `wa-light` / `wa-dark` class in step with the system's
light/dark preference, since Web Awesome switches mode by that class.

```ts
import "theme";
```

App chrome that hosts other people's DOM (the editor's shell: dockview, the codehike diff, iframes) takes
`theme/chrome` instead: the same, without Web Awesome's native styles, which style bare `button`, `svg`, `iframe`,
`pre` and `table` and make every box border-box ([*Why the shell skips native styles*](#why-the-shell-skips-native-styles)).

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

This adopts Web Awesome's layers, default theme and utility classes into that document, and sets these tokens and the
bridge from `--wa-*` to `--vscode-*` (`vscodeTokens` in `src/tokens.ts`). A webview calls it on its `body`, and a
docked window's document takes `followVsCodeThemeIn(document)`. The bridge, and `theme/vscode-skin` for the parts no
token reaches, are where the look reads `--vscode-*`; besides them, only `theme/styles/workbench` (VS Code's baseline)
does. The call also keeps the element's `wa-dark` / `wa-light` class in step with VS Code's theme type, so `<wa-*>`
components there follow a theme switch live.

## Components: `theme/components/*`

The Web Awesome components the app may use, one module each: importing `theme/components/button` registers
`<wa-button>`, and `import type WaButton from "theme/components/button"` is its type. Code reaches Web Awesome only
through this package (`webawesome/through-theme`), and uses only the components here (`webawesome/known-components`):
to allow another, add `src/components/<name>.js` and `.d.ts`, each a one-line re-export
([*Only through the theme*](#only-through-the-theme)).

## The layer order and docked windows: `theme/sheet`

Class names in code are a closed set (`webawesome/known-classes`): Web Awesome's, or one the theme styles. Every style
is in a layer, in the order `layerOrder()` puts first in a document once: `vendor` (dockview's sheet), Web Awesome's,
then `app` (`app.base`, `app.recipes`, `app.styles`, `app.overrides`) ([*The layers*](#the-layers)). VS Code copies
into a docked window only the stylesheets it made (each marked `data-vscode`), so `mirrorStyles()` copies the app's
(rules, not text, since Stitches inserts its), and the rules Stitches adds to them later.

## Recipes and composed components: `theme/recipes`, `theme/app-window`

`theme/recipes` is the app's shapes as Stitches recipes, a class for any element, from any framework:
`toolbar({ "density": "compact" })`, `caption({ "size": "2xs" })`. Overridable, least reach first: their variants;
their component tokens (`--app-toolbar-padding-inline`, `--app-caption-color`, …) set on an ancestor; a use-site
override, `toolbar({ "css": { … } })`, which wins by layer; or a new recipe composed from one, made here
([*Overriding a recipe*](#overriding-a-recipe)). `theme/app-window` is `<app-window>`, a movable, collapsible window in
light DOM: give it a `label`, `closable`, `storage-key`, a `slot="header-actions"` child and a body. `appWindow()` is
the same as a function (`theme/component`).

## Surface styles: `theme/styles/*`

What a surface draws with beyond Web Awesome and the recipes, made here with Stitches, one module per surface: the
shell, its dock, the preview, VS Code's document (`workbench`: VS Code's baseline, its overrides on `--vscode-*`), and
each view's (architecture-view, pane-views, margin, rule-view, rule-editor, git-panel, event-sheet, insights-monitor,
admin, account). The app imports their named styles, or calls a surface's `stylesheet()` once; it doesn't call
Stitches itself, and it has no stylesheets of its own (`webawesome/css-only-in-theme`, `no-css-imports`).

## CSS-in-JS: `theme/stitches`

The app's one Stitches instance (`css`, `recipe`, `globalCss`, `keyframes`, `theme`, and the `palette` of tokens under
the shell's names), the theme's own: nothing outside the theme imports it or `@stitches/core`
(`webawesome/through-theme`). Its values are `--wa-*` tokens (`webawesome/css-in-js-tokens`). Its output is layered:
`css()` in `app.styles`, `globalCss()` in `app.base`. Only `unlayeredGlobalCss` isn't, for what overrides CSS that
isn't layered (VS Code's, in `theme/styles/workbench`). `stylesheet()` is a surface's styles by selector, in
`app.styles`. In VS Code's document, `mirrorStyles` from `theme/sheet` copies them into a docked window, which VS Code
doesn't.

## Published: `components/<name>`

The recipes and composed components publish as packages of their own from `components/`: `app-window`, `toolbar`,
`caption`, `frame`, `code`, and `vscode-theme`, the look in one call (`vscodeTheme(element?)`), each
`@brianjenkins94/<name>`, released by cd.yml like any package. The source stays here
([*Published components*](#published-components)).

## The budget

What's left is budgeted (`budget.json`, checked by `test/budget.mjs`): the surfaces' declarations (`theme/styles/*`,
and a use-site `css` override wherever it is), and the comments that turn a `webawesome/*` rule off. The recipes,
components and tokens aren't: they're the vocabulary. Each may only go down; a raise means editing `budget.json`, where
the diff shows it, and a drop means lowering it, so the room a removal made isn't spent unseen.

## This starter

Light and dark alike, following the system, with the brand ramp set to the editor's blue accent (`#3794ff` at the
mid step). Every value is a starting point — iterate here rather than in component styles.

## Why

The goal: write as little of our own CSS as possible. Web Awesome should cover nearly everything, and custom CSS should
appear only in extraordinary cases. That rule is enforced by tooling, not by discipline.

### Why not Bamboo

[bamboocss](https://github.com/gajus/bamboocss) was the model for that enforcement. It's a fork of Panda CSS: a
build-time, zero-runtime CSS-in-JS compiler (Rust/Oxc, Vite only) that turns `css({ … })` calls into atomic classes. It
enforces discipline four ways: a closed vocabulary (generated, typed tokens, recipes and patterns; a value that isn't a
token is the exception); a build that rejects what it can't verify (a style it can't statically analyze, or a dead
reference, `ERR_BAMBOO_DEAD_IMPORT`); escape hatches as distinct syntax (`[…]`, which `no-escape-hatch` counts); and
lint where styles actually live (`prefer-token`, `no-hardcoded-color`, `no-unlayered-override`, `no-important`, …).

**Why not adopt it.** Bamboo is a *second styling system*. Adopting it means writing styles in `css()` calls next to
Web Awesome, which is the opposite of "Web Awesome has everything." Its enforcement covers its own `css()` calls and
says nothing about whether a `<wa-*>` component should have been used. It would also need its Vite plugin and a native
binary in every realm that renders UI: shell, workbench, webviews, admin and account. That adds connections and
connection types, not fewer.

**What we took from it.** Web Awesome's tokens, components and utility classes are the closed vocabulary. Every step
outside it is detectable, counted and budgeted. Lint reads the files that actually hold styles.

**Stitches stays.** The shell already had a CSS-in-JS layer, `@stitches/core`. Bamboo could have replaced it, but it
would have brought the Vite and native-binary requirements with it. Stitches needs neither, so it stays, as the way to
write the CSS that remains, on Web Awesome tokens ([*Stitches only, in the theme*](#stitches-only-in-the-theme)).

### The four lint gaps

The eslint plugin was doing its job on `.ts`/`.tsx`, and about 1,750 lines of custom CSS still reached the codebase,
most of it in the workbench, where Web Awesome wasn't loaded (lint alone couldn't fix that: `theme/vscode` makes Web
Awesome usable there). It came through four gaps, and each has a rule now:

1. **`.css` files weren't linted at all**, so nothing stopped a new `foo.css` and `import "./foo.css"`. ESLint lints
   CSS now (`@eslint/css`, which util's preset registers): a stylesheet but the one exempted by name is an error
   (`css-only-in-theme`), and so is importing one (`no-css-imports`).
2. **Wrapper helpers hid native elements.** `html("button", { class: "arch-button" })` went through a local helper,
   which `prefer-components` never saw, each with a bespoke class and CSS file. `prefer-components-wrapped` flags any
   call whose first argument is a string literal naming a native tag with a complement.
3. **Class names were unchecked**, so a bespoke class plus a CSS file was the path of least resistance. A `wa-` prefix
   proves nothing: `wa-diff-body` was our own class ([*Class names, a closed set*](#class-names-a-closed-set)).
4. **Disables were free.** A reasoned `eslint-disable` comment is accepted. All of them had plausible reasons, and that
   was the problem: with no budget, the count only grows ([*The budget*](#the-budget)).

### Only through the theme

Web Awesome and Stitches are reached only through the theme (`webawesome/through-theme`), which makes it the place to
curate the catalog and to add shapes of our own, so consistency of look and layout is enforced in practice and not
only by review. The allowlist, `src/components/`, is the curated catalog: adding a component is a file there, visible
in review. An upgrade is a change to one package.

- **A plugin rule, not `no-restricted-imports`.** ESLint flat config replaces a rule's options per file instead of
  merging them, so a second `no-restricted-imports` would silently undo the realm boundaries in `eslint.config.js`.
  `no-css-imports` is a plugin rule for the same reason.
- **Blocking imports doesn't block use.** Custom elements are registered globally, so once anything registers
  `wa-button`, any file can write `<wa-button>` with no import at all. The real enforcement is on tags:
  `known-components` fails a `wa-*` component in JSX or given to a create call that the theme doesn't export, and the
  JSX typings (`wa-jsx.d.ts`, in the editor and admin) list only the exported ones.
- **Web Awesome is a peer dependency**, and the consumers keep theirs: a peer resolves to the consumer's copy, which is
  exactly "one copy". The `resolve.dedupe` entries stay: `packages/theme/node_modules` has a stale 3.12 that
  `src/components/`'s imports would otherwise find.

### Class names, a closed set

A class name code sets as a literal must be one something styles: Web Awesome's (all of `dist/styles`, with its prefix
families, `[class*='wa-stack']`), or a selector key in the theme's Stitches. `eslint.config.js` builds the list from
those files, so it follows them. It's the class side of what `known-components` is for elements, and Bamboo's "a dead
reference fails the build": a bespoke class shows in review. Other people's DOM (Monaco and VS Code, dockview,
codehike) needs no entries: our code styles their classes but sets none as literals. VS Code's `codicon-*` is the one
allowed family, beside the hooks the tours and the code query, each a line in `eslint.config.js`. Runtime values go
through custom properties (`style.setProperty("--x", …)`), and the theme's styles decide what they mean; every other
inline style is an error (`no-inline-styles`).

### Stitches only, in the theme

Decided 2026-10-21 (the user's direction): all of the app's CSS is Stitches unless it can't be, all of it lives in this
package, and the theme hands out components, recipes and tokens that a consumer can override and extend, instead of a
consumer styling things itself: no stylesheets and no `css()`. `theme/stitches` is the theme's own, so there's one
instance, not one per package: every style shares one token map and one place to change it, is held to the tokens
(`css-in-js-tokens`) and is counted ([*The budget*](#the-budget)).

Lost in the move: `@eslint/css`'s checks (`use-baseline`, `no-invalid-properties`) apply to `.css` only, so they check
only the sign-in pages' sheet now. Accepted.

The risk: everything rides on Stitches, which is finished, not maintained: 1.2.8 (May 2023) is its last release. It's
small and has no dependencies, so it's a risk to watch, not a blocker: it's pinned rather than `latest`, and vendoring
it into the theme is the fallback if it ever breaks. Everything styles after its script runs, which is so for
everything but the sign-in pages and the first paint.

### Outside the rules

Stitches inserts its rules from JavaScript, into the document it runs in, so what it can't style is what has no
JavaScript of ours, or isn't ours:

- **Web Awesome's own stylesheets** and **dockview's**: vendors', loaded or adopted as CSS, in their layers.
- **`index.html`'s first-paint rule**: the shell's background before any script runs. One rule, in `app.base`, before
  the shell's, so theirs win.
- **The game files the event sheet emits** (`extensions/event-sheet/library.ts`): the game's CSS, written out as data,
  not the editor's.
- **The API's sign-in pages** (`packages/api/public/sign-in.css`) could be (they load a script) but would paint
  unstyled until it runs, so it's the one stylesheet, exempted by name. They bundle Web Awesome themselves
  (`packages/api/scripts/webawesome.ts`): the api doesn't depend on the theme.

Everything else can be, and is: the shell, admin, the workbench's views, the webviews (their policies allow `style-src
'unsafe-inline'`), the codehike diff and the tokens; shadow parts too (`"&::part(input)"`). One surface is Stitches but
outside the `webawesome/*` rules: `theme/styles/workbench`, VS Code's baseline, its overrides of VS Code's own CSS on
`--vscode-*`.

### The layers

Every style is in a layer, so which rule wins follows the layers, not specificity or which sheet was inserted last. The
order, lowest first, is `layerOrder()`'s: `vendor` (dockview's sheet), Web Awesome's layers, then `app`, and in it
`app.base` (`globalCss`), `app.recipes`, `app.styles` (a surface's styles) and `app.overrides` (a use-site `css`). So a
Stitches class wins over a recipe and Web Awesome's utilities wherever it's inserted, and the shell's styles over
dockview's.

- Stitches has no layers of its own (it predates them), but it emits an `"@layer name"` key as an `@layer name { … }`
  block, variants included, so `theme/stitches` wraps each call in one, as Panda (Bamboo's base) layers its own.
- VS Code's CSS isn't ours to layer, and unlayered CSS outranks every layer, so the overrides over it are
  `unlayeredGlobalCss`, the instance's one way out. The tokens are unlayered too, on purpose: definitions that have to
  win over Web Awesome's own, which are layered.
- Layers rank in the order they're first declared, and where Web Awesome's sheets are adopted (`theme/vscode`) they
  come after every `<style>`, so the order is put first in each document's head, once.

### Overriding a recipe

Consumers are three kinds of code: vanilla DOM (the workbench's views, the webviews), Preact (the shell, admin) and
React (the diff), so a component can't be one framework's. Most of it is recipes: a class string fits `class=`,
`className=` and `element(tag, className)` alike, and the markup stays the consumer's. Where markup and behaviour
repeat, a composed component is a light-DOM custom element (`<app-window>`): not a shadow root, so utilities, recipes
and a consumer's override still cascade into it, and it works the same from every framework. Not DOM helper functions
(like the event sheet's `heading()`): React would need its own copy of each, so two implementations of everything.

Override and extend, from the least reach to the most:

1. **Variants**: the options a recipe offers (`density`, `size`), defined in the theme.
2. **Component tokens**: a recipe reads its own custom properties, Web Awesome's as the fallback, and sets them only
   by a variant, so an ancestor retunes it without CSS and a variant still wins on its element: Web Awesome's own
   pattern, and it reaches vanilla DOM and webviews too.
3. **A use-site override**: `toolbar({ "css": { … } })`, Stitches' own one-off, in `app.overrides`, so it wins by layer
   wherever it's inserted; `css-in-js-tokens` holds it to the tokens and the budget counts it.
4. **Extension**: a new recipe composed from one (`recipe(toolbar, { … })`), made in the theme, where it's reviewed.

### Why the shell skips native styles

Tried 2026-10-19: Web Awesome's native styles style bare elements and set `box-sizing` on every box, and the shell is
mostly other people's DOM (dockview, the codehike diff, the app and preview iframes). In the running shell the rail's
lucide icons shrank from 17px to 6px (`svg { max-width: 100% }`), the app iframe took a 24px bottom margin
(`iframe:has(+ *)`), and the dock's traffic-light `<button>`s would take a form control's height and padding. The
shell's own elements are Web Awesome components or Stitches classes, so native styles add nothing there. `theme/vscode`
leaves them out for the same reason: VS Code's own native elements, and a webview's default styles, would meet them.

### VS Code's look everywhere

Decided 2026-10-21 (the user's direction): the theme itself is a Web Awesome theme with VS Code's look, on every page
it's on: whatever the app draws with Web Awesome looks like VS Code's own UI in the active VS Code theme. (A first
reading, keeping Web Awesome's own look for admin, misunderstood it.)

- **Where VS Code is**, its live colours are followed: on `.monaco-workbench`, a webview's root, and the shell's body,
  where the workbench publishes them (`theme/vscode-colors`), so the shell and its dock don't read as a second app.
- **Where it isn't** (admin, the account pages), `vscodePalette` is a fixed copy of the editor's default themes'
  colours, Default Light+ and Dark+ (the ones the editor takes from the system's mode, read from VS Code 1.142), on the
  document's root, dark when it's `wa-dark`. VS Code's live colours, where they are, are lower in the tree or inline,
  so they win.
- **Close rather than exact** (the user's preference), mostly by tokens: VS Code defines its own shape tokens, so Web
  Awesome's radii map onto `--vscode-cornerRadius-*` and its shadows onto `--vscode-shadow-*`, and a control is VS
  Code's text button's (26px, a 4px corner, normal weight). `theme/vscode-skin` styles the parts no token reaches: a
  dropdown is VS Code's context menu, a checkbox VS Code's own box and check.
- **Left as Web Awesome's, on VS Code's colours**: badges and tags (they carry meaning by variant), the progress bar
  (VS Code's is a 2px strip), and callouts (VS Code has none).

### Published components

The user's direction: the recipes and composed components publish themselves from `components/`, one package each, as
monaco-vscode-api does (released by the same pipeline as `packages/*`, registry-less). The theme keeps the look's
source, the surfaces' styles, the rules and the budget.

- **Internal use is on the source.** A build goes stale until it's rebuilt, and this is UI edited all the time, so
  the source stays in the theme and each `components/<name>` re-exports it by relative path; util-publish bundles it
  with what it uses (each published one has its own Stitches instance, the layer order shared).
- **The theme's source imports nothing outside itself.** CI's pnpm copies the theme into its store as a `file:`
  dependency, where a relative path out of it doesn't resolve; here it's a symlink, where it does. (The sources first
  moved into `components/`, the theme re-exporting them, and the editor's build failed in CI and not here.)
- **A component is a function too** (`theme/component`): its definition (attributes, slots, events) gives it typed
  options, slots as arrays, `children` for the default one, and `on*` handlers with the `app-` / `wa-` prefix dropped,
  and gives the package its `custom-elements.json`. Preact and React use the same element in JSX. Recipes stay as they
  are, a function returning a class.
- **Web Awesome is an optional peer**, by deriving what it provides: `scripts/web-awesome.mjs` writes
  `src/web-awesome.ts` (its layer order; each token's default, which `recipe()` inlines as the `var()` fallback; each
  element's native counterpart, which `webAwesomeOr(tag)` makes when it isn't registered), and `test/web-awesome.mjs`
  fails when that's stale. Without Web Awesome a component is plainer but works, its handlers the same.
- **Stitches isn't a peer**: an implementation detail, bundled and pinned ([*Stitches only, in the theme*](#stitches-only-in-the-theme)).

### Web Awesome's cost

Measured 2026-10-20: Web Awesome with what it brings (lit, floating-ui) is 222 KB of the 3.9 MB workbench.js (by its
source map), 54 KB of its 930 KB gzipped: about 6%. The workbench's eleven components bundled alone (265 KB, 67 KB
gzipped) take about 16 ms to parse, run and define, cold, and 2 ms with the code cache, beside a warm boot of about
545 ms. Not worth a budget of its own; the boot budget covers it.

### Gotchas

- **React 18 and `className`.** React 18 sets `className` on a custom element as a literal `classname` attribute, so a
  custom element is given `class`.
- **`white-space: pre` reaches a shadow template.** A pane row is `pre`, which renders the whitespace in a Web Awesome
  button's shadow template: a hidden Mock… button was 59px tall, and every row grew a view zone under its line. The
  row's controls are `white-space: normal`, and no taller than the line (`--wa-form-control-height`).
- **`connect-src data:`.** Web Awesome fetches its system icons (a tag's ✕, a checkbox's check) as `data:` SVGs, so a
  page that shows them allows `connect-src data:`: the sign-in pages and the event sheet's webview do. A `data:` URL
  reaches no server.
- **Lit's constructed sheets.** Lit adopts one constructed stylesheet per component class, made in the document that
  loaded it, and another document refuses it, so in a docked window (an `about:blank` frame) a component didn't
  render. `theme/documents`, imported first in the workbench, says `ShadyCSS` shadow DOM isn't native, the one thing
  Lit decides that by, so Lit puts a `<style>` in each shadow root, which goes wherever its component goes. Nothing
  else reads it, and the browser shares identical `<style>`s' parsed contents (boot 1154 vs 1142 ms).
- **A webview's body padding.** VS Code's default webview styles give `body` padding, unlayered, so no layered rule
  can take it back: a webview's view is the `frame()` recipe (`position: fixed`), rather than a style on `body`.

### Open

- **The rest of VS Code's palette**: hover and selection (`list.*`), badges, tooltips (`editorHoverWidget.*`), errors
  and warnings (`errorForeground`, `editorWarning.*`), scrollbars, and high-contrast themes' borders
  (`contrastBorder`, `contrastActiveBorder`) aren't mapped.
- **`natives` maps tags only**: `wa-checkbox` would need `<input type="checkbox">`. Enough for `wa-button`, the one a
  component makes now.
- **The split-button fragment** waits for a second use: the pane's Allow ▾ (a `wa-button-group` of a button and a
  `wa-dropdown` on a caret, built by hand) is still its only one, and a custom element is made only where a structure
  keeps coming back.
- **The sign-in pages' sheet** stays CSS unless a flash of the unstyled page, until their script runs, is acceptable
  there.
