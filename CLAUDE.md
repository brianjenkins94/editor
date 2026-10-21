# CLAUDE.md

## Styling

All styling goes through `packages/theme` (its README is the vocabulary; PLAN.md is why). ESLint enforces it, and its
messages name what to use instead.

- **Components:** Web Awesome's, imported from `theme/components/<name>` (the allowed set is that folder;
  [Web Awesome's docs](https://webawesome.com/docs/components/) describe each). Never `@awesome.me/webawesome`
  directly, and never a native element Web Awesome has a complement for.
- **Layout and type:** Web Awesome's utility classes (`wa-stack`, `wa-cluster`, `wa-gap-*`, `wa-heading-*`, …), then
  the theme's recipes (`app-frame`, `app-toolbar`, `app-code`, `app-caption`). Class names are a closed set.
- **Values:** `--wa-*` tokens, never literal colors, sizes or radii; in VS Code's document `theme/vscode` maps them onto
  `--vscode-*`.
- **CSS-in-JS:** `css` / `globalCss` from `theme/stitches` (layered; `unlayeredGlobalCss` only over VS Code's own CSS).
- **Anything else** is an exception sheet in `packages/theme/src/exceptions/`, and it's budgeted:
  `packages/theme/budget.json` may only go down (`node --test packages/theme/test/budget.mjs`). If you remove styling,
  lower the budget; if you must add, raise it there, where the diff shows it.
