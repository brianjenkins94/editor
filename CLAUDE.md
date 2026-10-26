# CLAUDE.md

## Styling

All styling goes through `packages/theme` (its README is the vocabulary, and the why after it). ESLint enforces it, and its
messages name what to use instead.

- **Components:** Web Awesome's, imported from `theme/components/<name>` (the allowed set is that folder;
  [Web Awesome's docs](https://webawesome.com/docs/components/) describe each), and the theme's own composed ones
  (`theme/app-window`), which with the recipes publish as packages from `components/<name>` (the README's *Published components*). Never `@awesome.me/webawesome` directly, and never a native element Web Awesome has a
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

## Features

The feature ledger (`.silo/features.json`; packages/silo/README.md, *The feature ledger*) is what's been decided about
features, and `silo check` (CI's lint) holds the code to it:

- **Replacing an approach removes the old one in the same change** — `silo remove "<name>" "<why>"` (what only it
  reaches, its manifest entries, a tombstone), or delete it and `silo status` it removed with where it went.
- **A new way in goes in the manifest** — `.silo/manifest.json` names every feature and the ways in it owns (packages/silo/README.md,
  *The feature manifest*): a new command, view, setting, tool or hub request goes into the feature it serves, or a new
  one, in the same change; `silo check` fails on one no feature owns.
- **An experiment starts with an entry** — `silo status "<name>" experiment "<why>" --until <date>`; it expires by
  default, and `silo check` says so.
- **A dormant way in** (`silo check` lists them: their files load in CI's runs, their code never runs) is a decision to
  make, not to ignore: remove it, or keep it with a reason that expires (`active --until`, 90 days on).

