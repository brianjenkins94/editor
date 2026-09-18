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

## Usage

Loaded directly in the repo's flat config (`eslint.config.js`) by relative path — no install needed — and scoped to the
shell/UI surface so sample content, grammars, and fixtures aren't caught:

```js
import webawesome from "./packages/eslint-plugin-webawesome/src/index.js";

export default [
  {
    "files": ["packages/vscode/shell.ts", "packages/vscode/window.ts", "packages/vscode/git-panel.ts", "packages/vscode/**/*.tsx"],
    "ignores": ["packages/vscode/demo/**", "**/*.test.*"],
    "plugins": { "webawesome": webawesome },
    "rules": {
      "webawesome/prefer-components": "error",
      "webawesome/no-html-in-strings": "error"
    }
  }
];
```
