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

## This starter

Dark-first, matching the editor shell's chrome, with the brand ramp set to the editor's blue accent (`#3794ff` at the
mid step). Every value is a starting point — iterate here rather than in component styles.
