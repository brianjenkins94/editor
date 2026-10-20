# eslint-plugin-webawesome

Guardrails for the "author the UI with as little hand-rolled markup as possible" goal: reach for a Web Awesome
component whenever one exists, and write markup as JSX (never as HTML in a string).

## Rules

### `webawesome/prefer-components`

Errors on a native HTML element that has a Web Awesome complement — whether written as JSX or built with
`document.createElement`.

```tsx
<button>Save</button>                    // ✗ use <wa-button>
document.createElement("select")         // ✗ use document.createElement("wa-select")
<input type="checkbox" />                // ✗ use <wa-checkbox>
```

The native→component map covers the clear complements only (`button`, `input`, `textarea`, `select`, `option`,
`dialog`, `details`, `hr`, `progress`, `meter`), refining `<input>` by its `type`. Layout elements (`div`, `span`,
`main`, `aside`, …) stay native — Web Awesome has no 1:1 complement for them.

### `webawesome/no-html-in-strings`

Errors on HTML markup embedded in a string or template literal (`innerHTML = "<div>…"`, a `MARKUP` constant). Author
it as a JSX component instead. The check requires a real tag name (a known HTML element or a hyphenated custom element)
and a closing `>`, so `a < b` and `List<T>` mentions don't false-fire. CSS in template strings is *not* flagged by
this rule — reducing custom CSS is handled by adopting the theme package, not here.

### `webawesome/prefer-components-wrapped`

The same check as `prefer-components`, applied to calls through a local wrapper. A wrapper is a function in the same
file that passes one of its parameters to `createElement` as the tag.

```ts
function html(tag, attributes) { const element = document.createElement(tag); … }
html("button", { class: "arch-button" })  // ✗ use "wa-button"
```

### `webawesome/no-css-in-strings`, `webawesome/no-inline-styles`

Flag CSS in a string or template literal, and inline styles: a JSX `style`, `el.style.… =`, or
`setAttribute("style", …)`.

### `webawesome/no-css-imports`

Flags a stylesheet import, static or dynamic (`?raw` and `?inline` included), unless it comes from Web Awesome or the
theme package. You can pass different package prefixes with `{ allow: [...] }`. A feature's own `.css` file is the
custom CSS the theme is meant to replace. The CSS that remains is checked by the stylesheet rules below.

### `webawesome/css-in-js-tokens`

The CSS-in-JS half of the token policy (`css-tokens` is the stylesheet half). It applies to the object literals passed to Stitches' `css`,
`globalCss` and `keyframes` (imported from the editor's `shared/theme`, or from modules matching
`{ sources: [regex, ...] }`), nested selectors included. It flags:

- a literal colour: a hex value, a colour function, a named colour, or one used as a `var()` fallback;
- a literal font size (a bare number is pixels to Stitches);
- a literal length in `padding`, `margin` or `gap`;
- a literal radius.

The message names the `--wa-*` step to use, or the nearest one.

```ts
css({ "fontSize": "12px" })                          // ✗ var(--wa-font-size-xs)
css({ "padding": "0 4px" })                          // ✗ var(--wa-space-2xs)
css({ "color": "var(--wa-color-text-quiet, #888)" })  // ✗ drop the fallback
```

Layout geometry (`width`, `height`, `top`, `inset`, …) has no token and isn't checked; nor are line heights yet.

## Stylesheets

These four run in ESLint's CSS language (`@eslint/css`), which util's preset registers for `**/*.css`; enable them for
the same files. Layers and `!important` are the language's own rules (`css/use-layers`, `css/no-important`).

### `webawesome/css-tokens`

The stylesheet half of the token policy: the same checks as `css-in-js-tokens` (a literal colour, font size, spacing
length or radius, each with the step to use), on a `.css` file's declarations. Layout geometry (`width`, `top`, …) has
no token, so it isn't checked.

### `webawesome/css-no-vscode-variables`

Flags `var(--vscode-*)`. VS Code's theme is read through the theme package's mapping (`packages/theme/src/vscode.css`)
only; turn it off for that file.

### `webawesome/css-no-wa-selectors`

Flags selecting a Web Awesome component (a `wa-*` type selector), reaching into one (`::part()`), and a `.wa-*` class
of our own. Style a component through its tokens.

### `webawesome/css-only-in-theme`

Flags every stylesheet it's enabled for. Enable it for `**/*.css` and turn it off for the theme package (and any
declared exemption), so a stylesheet anywhere else fails.

## Usage

Loaded directly in the repo's flat config (`eslint.config.js`) by relative path — no install needed — and scoped to the
shell/UI surface so sample content, grammars, and fixtures aren't caught:

```js
import webawesome from "./packages/eslint-plugin-webawesome/src/index.js";

export default [
  {
    "files": ["packages/editor/shell/**/*.ts", "packages/editor/**/*.tsx"],
    "ignores": ["packages/editor/demo/**", "**/*.test.*"],
    "plugins": { "webawesome": webawesome },
    "rules": {
      "webawesome/prefer-components": "error",
      "webawesome/no-html-in-strings": "error"
    }
  }
];
```
