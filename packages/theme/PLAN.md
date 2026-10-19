# theme — evaluation and plan

The goal: write as little of our own CSS as possible. Web Awesome should cover nearly everything, and custom CSS
should appear only in extraordinary cases. That rule should be enforced by tooling, not by discipline. This document
evaluates [bamboocss](https://github.com/gajus/bamboocss) as a model for that enforcement, audits where custom CSS
lives today, and proposes what this package should become.

Status (2026-10-19):

- Enforcement steps 4.1–4.3 are built and set to **error**. The ESLint half is at **zero**: every native element
  it found is a Web Awesome component now, and every stylesheet left is a named exception in
  `src/exceptions/` (§3). Stylelint still reports 554 errors in those exceptions (`architecture-view.css` is at
  zero), and runs only via `npm run lint:css`. See [§6](#6-counts) for the counts.
- `theme/vscode` (§3) is built, and the go/no-go step ([§5](#5-migration-order) step 1) is a **go**.
- The `theme` entry (§3) is built: admin takes `theme`, the shell `theme/chrome` (no native styles), and the
  shell's Stitches `css({…})` is on `--wa-*` tokens (§1). The budget (4.5) isn't built yet.

## 1. bamboocss: borrow the ideas, don't adopt the library

Bamboo is a fork of Panda CSS: a build-time, zero-runtime CSS-in-JS compiler (Rust/Oxc, Vite only) that turns
`css({ … })` calls into atomic classes. It enforces discipline in four ways:

1. **A closed vocabulary.** Styles are written against generated, typed tokens, recipes and patterns. A value that
   isn't a token is the exception.
2. **The build rejects what it can't verify.** A style call the compiler can't statically analyze fails the build,
   and a reference to a token or pattern that doesn't exist fails with `ERR_BAMBOO_DEAD_IMPORT`.
3. **Escape hatches are distinct syntax.** An arbitrary value is written `[…]`, so `no-escape-hatch` can find and
   count it.
4. **Lint covers where styles actually live.** Its eslint plugin has 26 rules. The relevant ones are `prefer-token`,
   `no-hardcoded-color`, `no-escape-hatch`, `no-unlayered-override`, `no-important`, `no-descendant-selectors` and
   `no-dynamic-styling`.

**Why not adopt it.** Bamboo is a *second styling system*. Adopting it means writing styles in `css()` calls next to
Web Awesome, which is the opposite of "Web Awesome has everything." Its enforcement covers its own `css()` calls and
says nothing about whether a `<wa-*>` component should have been used. It would also need its Vite plugin and a native
binary in every realm that renders UI: shell, workbench, webviews, admin and account. That adds connections and
connection types, not fewer.

**What to take from it.** Make Web Awesome's tokens, components and utility classes the closed vocabulary. Make every
step outside that vocabulary detectable, counted and budgeted. Lint the files that actually hold CSS.

**Stitches stays.** The shell already has a CSS-in-JS layer: `@stitches/core`, set up in
`editor/shared/theme.ts` (about 66 `css({…})` calls, almost all in `shell/`). Bamboo could replace it, but it would
bring the Vite and native-binary requirements above with it. Stitches needs neither, so it stays as the shell's way
to write the CSS that remains, on Web Awesome tokens. Two follow-ups:

- ~~Its `palette` of hard-coded hex values should become `--wa-*` tokens.~~ Done 2026-10-19. `palette` (and so
  Stitches' `$` colors) is `var(--wa-*)` strings now, so it follows the theme and the light/dark mode. The `css({…})`
  calls in the shell (`shell.tsx`, `shell-dock.ts`, `shell-preview.ts`, `preview-devtools.ts`) were mostly tokens
  already; their literal font sizes, small gaps, popover offsets, borders and focus rings are tokens now too
  (`--wa-font-size-3xs`…`s`, `--wa-space-3xs`/`2xs`, `--wa-border-width-*` with `--wa-border-style`,
  `--wa-focus-ring`), and the hex fallbacks inside `var()` are gone. What's left as literals is layout geometry with
  no token (the 40px top bar, the 260/380px side widths, the 68px rail, popover widths), a few line heights between
  Web Awesome's steps, and the dock's macOS traffic lights (their colours and 12px geometry are the point).
  `workbench/Workbench.tsx` stays on `--vscode-*`: its rules pin VS Code's own baseline in VS Code's document, where
  the `--wa-*` bridge may not be adopted yet.
- ~~The token rule (4.2) should eventually check `css({…})` values too, since today no rule reads them.~~ Done
  2026-10-19: `webawesome/css-in-js-tokens`, an error. It reads the object literals given to Stitches' `css` /
  `globalCss` / `keyframes` from `shared/theme`, nested selectors included. It flags literal colours (including
  `var()` fallbacks), font sizes, `padding` / `margin` / `gap` lengths and radii, and its message names the step to
  use. Layout geometry and line heights aren't checked. The one exception today is the dock's traffic lights, behind
  a reasoned disable. `Workbench.tsx` is outside every `webawesome/*` rule already.

## 2. Where custom CSS lives today

About 1,750 lines of hand-written CSS in 11 files, plus inline styles behind `eslint-disable`:

| File | Lines | Tokens it uses | What it rebuilds |
| --- | ---: | --- | --- |
| `editor/workbench/architecture-view.css` | 671 | `--vscode-*` (34), 26 hex/rgb | toolbar, buttons, tabs, tables, inputs, chips, key/value lists, plus the graph canvas |
| `editor/workbench/pane-views.css` | 412 | `--vscode-*` (59), 21 hex/rgb | live-values rows/cells aligned to code lines (mostly bespoke) |
| `editor/workbench/rule-editor.css` | 199 | `--vscode-*` (23) | selects, inputs, buttons, nested lists |
| `components/monaco-vscode-api/pane.css` | 168 | `--vscode-*` (26) | margin sash/gutter (bespoke), plus tabs |
| `editor/shell/git-panel.css` | 118 | `--wa-*` (3), 25 hex/rgb | file list, chunk rows, diff verdict dots |
| `editor/workbench/rule-view.css` | 64 | `--vscode-*` (16) | |
| `admin/src/admin.css` | 33 | `--wa-*` (30) | `.table`, `.stat`, `.muted`, `.mono` (Web Awesome has native table styles and `wa-color-text-quiet` / `wa-font-family-code`) |
| `theme`, `account`, `window`, `sign-in` | ~90 | `--wa-*` | mostly tokens |

Plus about 56 `style.cssText` / `.style.x =` writes in `extensions/event-sheet/` and 38 `eslint-disable` comments
for `webawesome/*` rules across the repo.

### Why it got past the lint

The eslint plugin is doing its job on `.ts`/`.tsx`. The CSS reached the codebase through four gaps:

1. **`.css` files aren't linted at all.** Most of the custom CSS is in them. Nothing stops a new `foo.css` with
   `.foo-button { … }` and `import "./foo.css"`.
2. **Wrapper helpers hide native elements.** `prefer-components` checks JSX tags and `document.createElement("…")`
   literals. `html("button", { class: "arch-button" })` in `architecture-view.ts` and `element("select", …)` in
   `rule-editor.ts` go through local helpers, so the rule never sees them, and each comes with a bespoke class and
   CSS file.
3. **Class names are unchecked.** Any `class`/`className` is allowed, so a bespoke class plus a CSS file is the
   path of least resistance. A `wa-` prefix proves nothing: `wa-diff-body` was our own class, styled in
   `git-panel.css` (gone since the panel's rebuild, §6).
4. **Disables are free.** A reasoned `eslint-disable` comment is accepted. All 38 have plausible reasons, and that
   is the problem: there is no budget, so the count only grows.

### The root cause in the workbench

Web Awesome isn't loaded in VS Code's document. The workbench views (architecture, pane views, rule editor, margin)
and the webviews render where `<wa-*>` doesn't exist, so the only themed option was hand-written CSS on
`--vscode-*` variables. That accounts for about 1,500 of the 1,750 lines. Lint alone can't fix it. The theme
package has to make Web Awesome usable there.

## 3. What this package becomes

`theme` stays a token-only package, and it becomes the **one place** a document gets its styling from:

- **`theme`** (admin, and the account page in it; built): `src/index.js`. Web Awesome's layers, native styles,
  utilities and default theme, then our brand tokens (`src/theme.css`), in one import. It also keeps the root's
  `wa-light` / `wa-dark` class in step with `prefers-color-scheme`, live, since Web Awesome switches mode by that class
  and not by the media query; the shell did that by hand before, and admin was always light.
- **`theme/chrome`** (the shell, and the account dialog in it; built): `src/chrome.js`, the same setup without Web
  Awesome's native styles, and `theme` is this plus `native.css`. One file holds the setup, and the two entries
  differ only in that sheet.
  - **The shell doesn't take native styles.** Tried 2026-10-19: they style bare elements and set `box-sizing` on
    every box, and the shell is mostly other people's DOM (dockview, the codehike diff, the app and preview
    iframes). In the running shell the rail's lucide icons shrank from 17px to 6px (`svg { max-width: 100% }`), the
    app iframe took a 24px bottom margin (`iframe:has(+ *)`), and the dock's traffic-light `<button>`s would take a
    form control's height and padding. The shell's own elements are Web Awesome components or Stitches classes, so
    native styles would add nothing there. This is the same call as `theme/vscode`.
  - Both entries import Web Awesome from the consumer's copy, so admin's and the editor's Vite configs (`dev.ts`
    too, not only `build.ts`) list `@awesome.me/webawesome` in `resolve.dedupe`; without it the stale 3.12 in
    `packages/theme/node_modules` is picked up.
  - Not moved: the API's sign-in pages bundle Web Awesome's own `webawesome.css` with esbuild
    (`api/scripts/webawesome.ts`), since the api doesn't depend on `theme`. Moving them means adding that dependency,
    and they'd follow the system's mode too.
- **`theme/vscode`** (the workbench document; built): `followVsCodeTheme(workbench)` in `src/vscode.js`. The
  workbench build emits no stylesheet to link, so the module imports the styles as text and adopts them into the
  document: Web Awesome's layers, default theme and utility classes, our brand tokens, then the bridge in
  `src/vscode.css`. Web Awesome's native styles are left out, because VS Code's own native elements would pick them
  up.
  - The bridge maps `--wa-*` onto `--vscode-*`: surfaces, text, links, focus, brand and neutral fills (VS Code's
    primary and secondary buttons), and form controls (VS Code's inputs). It also sets VS Code's fonts and density
    (`--wa-font-size-scale: 0.8125`, `--wa-space-scale`, tighter form-control padding, so buttons are 23px).
  - VS Code declares its variables on `.monaco-workbench`, so the bridge is declared there too. A custom property
    has to be resolved where the value it reads is defined.
  - A `MutationObserver` on that one element mirrors VS Code's theme type (`vs` / `vs-dark` / `hc-black` /
    `hc-light`) onto Web Awesome's `wa-light` / `wa-dark`. Every token the bridge doesn't map comes from Web
    Awesome's ramp for that mode.
  - `src/vscode.css` is the **only** place a `--vscode-*` variable may appear.
- **`theme/exceptions/*`** (built): the custom CSS that's left, one file per surface. These are the only
  stylesheets code may import besides Web Awesome's and the theme's own (4.1). A new file here is the visible "this
  needs custom CSS" in review. Each file is held to every stylelint rule, unlike `theme.css` and `vscode.css`.
  The workbench views import theirs as text (`?raw`), and the shell and admin import theirs as stylesheets.
  `margin.css` used to be the monaco component's own `pane.css`; the editor's `pane-views.ts` now puts it into the
  document, so the component ships no CSS.
- **No component CSS in the tokens.** `theme.css` and `vscode.css` hold token assignments only. A rule that targets
  a component (`wa-button { … }`, `::part(…)`) isn't a theme; it belongs in an exception.

## 4. Enforcement: make the discipline mechanical

In priority order. Each step closes one of the gaps above.

1. **Only `theme` and `@awesome.me/webawesome` may be imported as CSS.** Add a `no-restricted-imports` pattern for
   `*.css` everywhere else. This is the strongest single rule: a feature can't ship its own stylesheet without an
   explicit exception.
2. **Stylelint for every `.css` file that remains** (new dependency; check the 7-day CI cooldown):
   - Colors, lengths, font sizes, radii and shadows must be `var(--wa-*)`
     (`stylelint-declaration-strict-value`). This is the equivalent of Bamboo's `prefer-token` /
     `no-hardcoded-color`. `webawesome/css-in-js-tokens` holds Stitches' `css({…})` to the same tokens (§1).
   - `--vscode-*` is allowed only in `theme/src/vscode.css`.
   - No `!important`. No selectors on `wa-*` tags or their internals (use `::part` only through the theme).
   - Every rule must be inside a declared `@layer` after Web Awesome's. This is the equivalent of
     `no-unlayered-override`, and Web Awesome 3.14 already declares its layer order in `layers.css`.
3. **`prefer-components` sees through wrappers.** Flag any call whose first argument is a string literal naming a
   native tag with a complement (`html("button")`, `element("select")`), not only `document.createElement`.
4. **Class names are a closed set (`webawesome/known-classes`).** A `class`/`className` literal must be a Web Awesome
   utility class (generated from the installed `utilities.css`, so it follows upgrades) or a class declared in an
   allowed exception file. This is Bamboo's "dead reference fails the build", and it is what makes a bespoke class
   visible in review.
5. **Exceptions are budgeted, not just justified.** Remaining custom CSS (the graph canvas, the live-values grid
   aligned to code lines, the sprite grid) goes in files named `*.exception.css`. A CI check holds two numbers in a
   committed budget: exception CSS declarations and `webawesome/*` disables. Both may only go down. Raising either
   means editing the budget file, which shows up in the diff. The repo's performance budgets (`test/performance.mjs`)
   already work this way.
6. **Tell agents the vocabulary.** Add a short `CLAUDE.md` section that points at the Web Awesome component list and
   this file. Lint messages should name the component to use, not only what's wrong. (Bamboo ships an MCP server for
   this. A lint message that names the component is the cheaper version of the same idea.)

## 5. Migration order

1. ~~`theme/vscode` and the bridge; prove `<wa-button>` follows a VS Code theme switch in the workbench document.~~
   **Go** (2026-10-19). The architecture toolbar's ten buttons are `<wa-button>`s, and their 18 lines of
   `.arch-button` CSS are gone. Checked in the running editor:
   - Light+ gives `wa-light`, with Web Awesome's brand fill set to VS Code's button blue.
   - Switching to Dark+ re-colors the buttons live, with no reload. A toggle's on state is the `brand` variant.
   - VS Code's own font and layout are unchanged, and nothing was logged to the console.
   - Web Awesome's copy in `packages/theme/node_modules` is a stale 3.12, so the editor build now dedupes
     `@awesome.me/webawesome` to its own 3.14.
   The `theme` entry for the shell, admin and account, which replaces their separate setups, is built too (§3).
2. ~~Lint gaps 4.1–4.3 as errors, and the ESLint violations they report fixed.~~ Done 2026-10-19 (§6). Next: the
   stylelint errors in `src/exceptions/` (735, now 338), shrinking each file by replacing what Web Awesome covers.
   `architecture-view` and `git-panel` are done (§6).
3. ~~Convert the biggest file first: `architecture-view`.~~ Done 2026-10-19 (§6). Then `rule-editor`, then admin
   (native tables plus utilities, which should get close to zero CSS).
4. Event sheet inline styles → components plus utilities, keeping the sprite grid as an exception.
5. Add the budget (4.5) once the approach that replaces it is settled.

Rough expectation, not measured: most of `architecture-view`, `rule-editor`, `rule-view`, `admin` and the event-sheet
inline styles go away. `pane-views`, the margin (`margin.css`) and the graph canvas mostly stay, as named
exceptions.

## 6. Counts

Baseline taken 2026-10-19 when the rules were added, then again after the ESLint half was cleared the same day.
Re-run with `npx eslint .` and `npm run lint:css`.

**Cleared (ESLint, 40 → 0):**

- The architecture view's select, filter and tabs are `wa-select`, `wa-input` and a `wa-tab-group`. The tab group
  holds only tabs; the view's one panel draws the open one, so the open tab is read from the group after a click or
  a key, since the group emits no `wa-tab-show` without panels.
- The rule editor's controls are `wa-select`, `wa-input`, `wa-checkbox`, and plain `wa-button` icon buttons. Its
  examples were a `<datalist>`, which a shadow-DOM input can't use, so they're a `wa-dropdown` at the input's end
  now. The rule view's buttons are `wa-button`s.
- The API's sign-in and passkey pages are `wa-card`, `wa-input`, `wa-button`, `wa-checkbox` and `wa-callout`, plus
  utility classes, and `sign-in.css` is down to centring the card. The pages still load only their own origin's
  files: `scripts/webawesome.ts` bundles the five components and Web Awesome's stylesheet into
  `public/webawesome.{js,css}` (build output, gitignored), and wrangler's `build.command` runs it before `dev` and
  `deploy`, and in the test harness. One CSP change was needed: `/sign-in*` allows `connect-src data:`, because
  the checkbox fetches its checkmark as a `data:` SVG. A `data:` URL reaches no server. Checked against the real
  CSP in the harness: a full email-code sign-in works (submitting by click and by Enter), with no CSP errors.
- `.muted` / `.account-muted` became Web Awesome's `wa-color-text-quiet` (30 uses), and their rules are gone.

**Cleared (stylelint, `architecture-view.css`: 181 → 0, 607 → 382 lines):**

- The view is Web Awesome markup now. Message kinds are `wa-badge`s (request brand, reply success, event neutral,
  message warning, error danger, an ack neutral and outlined), states are outlined pill badges, subjects are
  `wa-tag`s. The toolbar is a `wa-split` of two `wa-cluster`s. The side panel and its sections are `wa-stack`s, with
  `wa-heading-*` titles and `wa-caption-xs` section captions; links are `wa-link`, muted text `wa-color-text-quiet`,
  log rows `wa-cluster`s with `wa-text-truncate` cells. That retired `.arch-chip`, `.arch-legend`, `.arch-spacer`,
  `.arch-state`, `.arch-subject(s)`, `.arch-section`, `.arch-muted`, `.arch-link`, `.arch-list` and most of the
  `.arch-event-*` and `.arch-flow*` rules.
- What's left is the canvas and side panel's layout (and its narrow-editor container query), the key/value grid, the
  table, a few log-row details, and the SVG diagram. It's in `@layer app`, on `--wa-*` tokens only. The diagram's
  pulses use the same variant tokens as the kind badges; hub links are the palette's `--wa-color-purple-60`, which
  doesn't follow the light/dark mode.
- The sheet declares the layer order, ending in `app`. The view's `<style>` comes before the adopted Web Awesome
  sheets in the document, so an `app` layer it merely opened would rank below every Web Awesome layer.
- A ghost edge's thin stroke no longer needs `!important`: `tick()` leaves its width to the stylesheet.
- `theme/vscode` now falls back to Web Awesome's code font: VS Code sets `--vscode-editor-font-family` on each
  editor, not on `.monaco-workbench`, so outside an editor the mapping was empty.

**Cleared (stylelint, `git-panel.css` 216 → 0):**

- The shell's review panel lays out with `wa-stack`, `wa-cluster` and `wa-split`, and its type and colour come from
  the text utilities (`wa-font-size-*`, `wa-color-text-quiet`, `wa-text-truncate`, `wa-text-uppercase`). The empty
  state, the header count and the chunk rows need no CSS of their own.
- The A/M/D letters are `wa-badge`s in the `success` / `warning` / `danger` variants, and a chunk's edit count is an
  outlined neutral `wa-badge`. The diff's verdict banner takes Web Awesome's variant classes (`wa-neutral` /
  `wa-warning` / `wa-danger`), so its text and dot read the generic `--wa-color-on-quiet` / `--wa-color-fill-loud`.
- `.wa-diff-body` is gone rather than renamed: the diff's classes (`sxs-*`) are unique, so they need no scoping class,
  and the shell's overlay no longer has to declare one in its JSX. The `.gp .commit wa-textarea` width rule went too,
  since a stack stretches its children. The shell's legacy `--bg` / `--line` / `--fg` / `--muted` / `--accent` aliases
  had no reader left, and are gone.
- The diff's flex boxes (gutter cells, fold slot, hunk bar, pick toggle) take `wa-cluster` and the alignment
  utilities, and its right-click discard menu is a danger `wa-button` at the pointer, with no menu CSS. (React 18
  sets `className` on a custom element as a literal `classname` attribute, so that button is given `class`.)
- What's left is 151 declarations in 54 rules, from 249 in 74: the panel's sizing and padding, the rows' hover and
  current states, and the codehike side-by-side grid, all inside `@layer app` and on `--wa-*` tokens. Its 25 literal
  colours became Web Awesome's fills (`neutral`, `brand`, `success`, `warning`, `danger`) and surfaces.
- `git-panel.tsx` imports the shell's Web Awesome setup before the sheet, so the `app` layer is declared after Web
  Awesome's own layers: the shell imports the panel before that setup. A layer declared first ranks lowest.
- Checked in the running editor, dark and light: a commit, `M` rows, the semantic-change banner,
  the chunk timeline and its spotlight on the diff, a partial selection, a hunk discarded from the menu, and a file
  row's two-step discard.

**Before clearing** (the baseline):

**ESLint** (`webawesome/*`, in `.ts`/`.tsx`/`.js`):

| Rule | Errors | Where |
| --- | ---: | --- |
| `no-css-imports` (4.1) | 10 | 4 workbench `?raw` sheets, `pane.css?raw`, `git-panel`, `window`, `admin`, `account` (×2) |
| `prefer-components-wrapped` (4.3) | 31 → 30 | `api/public/sign-in.js` 19, `architecture-view.ts` 6 → 5, `rule-editor.ts` 5, `rule-view.ts` 1 |

`no-css-imports` is a plugin rule rather than a `no-restricted-imports` pattern. ESLint flat config replaces a rule's
options per file instead of merging them, so a second `no-restricted-imports` would silently undo the realm
boundaries.

**Stylelint** (`stylelint.config.js`, 4.2): 864 errors in 10 files at the baseline, 735 after the ESLint half, 338
in 7 now (by rule below, at the baseline). The exceptions stay held to every rule: the theme's own override covers
only `theme.css` and `vscode.css`.

| Rule | Baseline | Now |
| --- | ---: | ---: |
| `webawesome/no-unlayered-rules`: a rule outside `@layer` | 389 | 234 |
| `scale-unlimited/declaration-strict-value`: a literal color/space/type/radius where a `--wa-*` token belongs | 273 | 175 |
| `declaration-property-value-disallowed-list`: a `var(--vscode-*)` | 142 | 87 |
| `selector-disallowed-list`: selecting `wa-*` tags, `::part()`, or our own `.wa-*` classes | 58 | 58 |
| `declaration-no-important` | 2 | 0 |

The files are in `src/exceptions/` now; the paths are where each one came from.

| File | Baseline → now |
| --- | ---: |
| `editor/shell/git-panel.css` | 216 → 0 |
| `editor/workbench/architecture-view.css` | 205 → 0 |
| `editor/workbench/pane-views.css` | 163 |
| `editor/workbench/rule-editor.css` | 65 → 36 |
| `monaco-vscode-api/pane.css` (`margin.css`) | 61 |
| `api/public/sign-in.css` | 56 → 0 |
| `editor/workbench/rule-view.css` | 33 → 15 |
| `admin/src/admin.css` | 30 → 29 (all unlayered; its values are already tokens) |
| `editor/shell/window.css` | 26 (`.wa-win*` is our class with a Web Awesome prefix, plus `::part`) |
| `account/src/account.css` | 9 → 8 |

Most of the unlayered count is mechanical: wrapping each file in `@layer app { … }` clears it. The other rules
measure the real work. The ESLint errors fail CI's `lint` (lib's `util-lint`). Stylelint runs only through
`npm run lint:css`, because `util-lint` runs ESLint only. Wiring stylelint into CI is a lib change.

## Open questions

- Is the per-document cost of loading Web Awesome components in the workbench iframe acceptable for initial load?
  Components are imported individually, so it is probably small. Measure it with the performance budgets.
- Should webviews (event sheet, insights monitor) get `theme/vscode` too, or stay as declared exceptions? They are
  separate documents with their own CSP, and VS Code's variables reach them on `html`, not `.monaco-workbench`.
- Is `known-classes` too strict for third-party DOM, such as Monaco and codehike? It probably needs a per-file
  allowlist for vendored markup.
