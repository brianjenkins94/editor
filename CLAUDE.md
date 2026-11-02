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

## Spans

Anything someone may one day need to explain is a span, from `@brianjenkins94/util/logger` through the context's
source logger (observability's `relayLoggerToHub`), so it shows in the monitor, `metrics_query` and `logs_query`
without a profiler. Not `console.*`, and not a pair of `performance.now()`s.

- **What gets one:** whatever crosses a boundary (a realm, a hub request, a filesystem layer, the network, a worker,
  IndexedDB), waits, or does work a person waits on (a load, a parse, a walk, an install, a command, a tool call).
- **The function form:** `parent.span("<feature>.<operation>", attrs, async (span) => …)`, which ends itself on
  return or throw. A handle only when the end is an event somewhere else, then `using` or an `end()` on every path.
- **Parentage is passed, not found:** hand the span down (it's a logger) and open children off it; across a hub
  message, send `traceContext` and `continueSpan` on the far side.
- **The name is where it is, then one word for what it does:** the file's path from the repository's root (no
  leading `packages/`, no `src/`, no extension; `index`, `extension` or a file named after its folder drops out; `/`
  as `.`), then the word: in `packages/editor/extensions/history/ledger.ts`, `editor.extensions.history.ledger.reach`.
  ESLint holds it (`logger/span-names`, util's): `--fix` writes the place and keeps the word, so a moved file's
  names follow it. The feature a span belongs to is joined from its path at read time, through the ledger's paths.
- **Attributes** say who asked (`caller`), what (`op`, `path`) and how much (`bytes`, `count`); results go on
  `end({ … })`. No secrets, no contents.
- **Hot paths are counted, not spanned:** something done thousands of times a second (a zen-fs lookup, a provider
  `stat`) adds its count and time to the span that caused it (`end({ "stats": n, "statMs": t })`) and to a
  metrics-plane gauge. A span per call only when asked for, as `editor_trace` keeps VS Code's log.

## Features

The feature ledger (`.silo/features.json`; packages/silo/README.md, *The feature ledger*) is what's been decided about
features, and `silo check` (CI's lint) holds the code to it:

- **Replacing an approach removes the old one in the same change** — `silo remove "<name>" "<why>"` (what only it
  reaches, its manifest entries, a tombstone), or delete it and `silo status` it removed with where it went.
- **The manifest is superseded, not maintained** — `.silo/manifest.json` was a one-off, AI-written enumeration of
  every feature and the ways in it owns (packages/silo/README.md, *The feature manifest*). Tracking features and their
  tests, and attributing code to features from them (*Tests by feature, in your face*), supersedes it; it isn't kept
  up into that. Until that's built, `silo check` still fails on a way in no feature owns, so a new command, view,
  setting, tool or hub request is placed in the feature it serves, only to keep CI green.
- **An experiment starts with an entry** — `silo status "<name>" experiment "<why>" --until <date>`; it expires by
  default, and `silo check` says so.
- **A dormant way in** (`silo check` lists them: their files load in CI's runs, their code never runs) is a decision to
  make, not to ignore: remove it, or keep it with a reason that expires (`active --until`, 90 days on).


## Agent tools

An agent's tool (`packages/editor/app/tools/<family>`, debug-mcp's) lets an agent do what a person already can in the
editor; it isn't a way in of its own. What it does has a command, view or panel first, and the tool asks the same hub
request or runs the same command. A tool only an agent could use is a gap in the editor: build its UI, then the tool.
Reading what's on screen (`editor_state`, `editor_problems`) counts, and so do tools about the agent's own connection
(`tabs_list`, `tree_state`). The tools from before this rule that have no UI (NEXT.md item 3, *Agent-only tools*) get
one or go as the rewrite reaches their feature.
