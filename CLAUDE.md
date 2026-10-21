# CLAUDE.md

## Styling

All styling goes through `packages/theme` (its README is the vocabulary; PLAN.md is why). ESLint enforces it, and its
messages name what to use instead.

- **Components:** Web Awesome's, imported from `theme/components/<name>` (the allowed set is that folder;
  [Web Awesome's docs](https://webawesome.com/docs/components/) describe each), and the theme's own composed ones
  (`theme/app-window`), which with the recipes live and publish in `components/<name>` (PLAN.md §10). Never `@awesome.me/webawesome` directly, and never a native element Web Awesome has a
  complement for.
- **Layout and type:** Web Awesome's utility classes (`wa-stack`, `wa-cluster`, `wa-gap-*`, `wa-heading-*`, …), then
  the theme's recipes, functions that return a class: `toolbar()`, `caption()`, `frame()`, `code()` from
  `theme/recipes`, with variants (`toolbar({ "density": "compact" })`) and a use-site override when needed
  (`toolbar({ "css": { … } })`). Class names are a closed set.
- **Values:** `--wa-*` tokens, never literal colors, sizes or radii; in VS Code's document and the shell `theme/vscode`
  maps them onto `--vscode-*`.
- **Anything else** is a surface's styles: Stitches, in `packages/theme/src/styles/<surface>.ts`, imported from
  `theme/styles/<surface>`. Nothing outside the theme calls Stitches (`theme/stitches` is the theme's own) or has a
  stylesheet. It's budgeted: `packages/theme/budget.json` may only go down
  (`node --test packages/theme/test/budget.mjs`). If you remove styling, lower the budget; if you must add, raise it
  there, where the diff shows it.
