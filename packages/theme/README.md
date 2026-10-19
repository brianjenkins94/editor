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

Import **after** Web Awesome's default theme so the overrides win:

```ts
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/styles/utilities.css";
import "theme";
```

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

## This starter

Dark-first, matching the editor shell's chrome, with the brand ramp set to the editor's blue accent (`#3794ff` at the
mid step). Every value is a starting point — iterate here rather than in component styles.
