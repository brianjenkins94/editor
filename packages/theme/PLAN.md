# theme — evaluation and plan

The goal: write as little of our own CSS as possible. Web Awesome should cover nearly everything, and custom CSS
should appear only in extraordinary cases. That rule should be enforced by tooling, not by discipline. This document
evaluates [bamboocss](https://github.com/gajus/bamboocss) as a model for that enforcement, audits where custom CSS
lives today, and proposes what this package should become.

Status (2026-10-19):

- Enforcement steps 4.1–4.3 are built and set to **error**. Both halves are at **zero**: every native element
  ESLint found is a Web Awesome component now, every stylesheet left is a named exception in `src/exceptions/`
  (§3), and the stylesheet rules report nothing in any of them. Those rules are ESLint's now (§7.1): util's preset
  lints CSS, so `util-lint` and CI check stylesheets once that util is published; stylelint is gone.
  See [§6](#6-counts) for the counts.
- `theme/vscode` (§3) is built, and the go/no-go step ([§5](#5-migration-order) step 1) is a **go**.
- The `theme` entry (§3) is built: admin takes `theme`, the shell `theme/chrome` (no native styles), and the
  shell's Stitches `css({…})` is on `--wa-*` tokens (§1). The event sheet's webview takes `theme/vscode` too, and its
  inline styles are gone (§5 step 4), and so is the insights monitor's page CSS (§6). The budget (4.5) is built
  (7.6).
- Next (2026-10-20): confinement, all styling in this package and Web Awesome only through it ([§7](#7-confinement-all-styling-in-this-package)).

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

**Stitches stays** (and goes repo-wide, through `theme`: §7.5). The shell already has a CSS-in-JS layer: `@stitches/core`, set up in
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
- **`theme/vscode`** (the workbench document, and a webview's; built): `followVsCodeTheme(element)` in
  `src/vscode.js`, given `.monaco-workbench` or a webview's `body`. Neither document has a stylesheet to link, so the
  module imports the styles as text and adopts them into the document: Web Awesome's layers, default theme and utility classes, our brand tokens, then the bridge in
  `src/vscode.css`. Web Awesome's native styles are left out, because VS Code's own native elements would pick them
  up.
  - The bridge maps `--wa-*` onto `--vscode-*`: surfaces, text, links, focus, brand and neutral fills (VS Code's
    primary and secondary buttons), and form controls (VS Code's inputs). It also sets VS Code's fonts and density
    (`--wa-font-size-scale: 0.8125`, `--wa-space-scale`, tighter form-control padding, so buttons are 23px).
  - VS Code declares its variables on `.monaco-workbench`, so the bridge is declared there too. A custom property
    has to be resolved where the value it reads is defined. In a webview they're on `html`, and VS Code marks `body`
    with the theme's kind (`data-vscode-theme-kind`), so the bridge is also declared on `body[data-vscode-theme-kind]`.
  - A `MutationObserver` on that one element mirrors VS Code's theme type (`vs` / `vs-dark` / `hc-black` /
    `hc-light` on `.monaco-workbench`, `vscode-dark` / `vscode-high-contrast` and the light kinds in a webview) onto Web
    Awesome's `wa-light` / `wa-dark`. Every token the bridge doesn't map comes from Web Awesome's ramp for that mode.
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
2. **Stylelint for every `.css` file that remains** (new dependency; check the 7-day CI cooldown; moving into ESLint,
   §7.1):
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
   Done 2026-10-20: the repo's `CLAUDE.md` has a Styling section (components from `theme/components/*`, utilities
   and recipes, tokens, `theme/stitches`, the exception sheets and their budget), and `prefer-components` names the
   import too: "Use <wa-button> (import "theme/components/button") instead of the native <button>".

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
2. ~~Lint gaps 4.1–4.3 as errors, and the ESLint violations they report fixed.~~ Done 2026-10-19 (§6). ~~Then the
   stylelint errors in `src/exceptions/` (735), shrinking each file by replacing what Web Awesome covers.~~ Done
   2026-10-19: every file is at zero (§6). Left: getting CSS checked in CI, by moving the rules into ESLint in lib
   (§7.1).
3. ~~Convert the biggest file first: `architecture-view`, then `rule-editor`, then admin.~~ Done 2026-10-19 (§6).
4. ~~Event sheet inline styles → components plus utilities, keeping the sprite grid as an exception.~~ Done
   2026-10-19 (§6). The webview takes `theme/vscode` rather than staying a declared exception (§3).
5. ~~Add the budget (4.5) once the approach that replaces it is settled: that's confinement (§7), with the budget its
   last step (7.6).~~ Done 2026-10-20 (7.6).

Rough expectation, not measured: most of `architecture-view`, `rule-editor`, `rule-view`, `admin` and the event-sheet
inline styles go away. `pane-views`, the margin (`margin.css`) and the graph canvas mostly stay, as named
exceptions. (So it went: `pane-views` lost its buttons, menu and input to Web Awesome, and kept its line-aligned rows.)

## 6. Counts

Baseline taken 2026-10-19 when the rules were added, then again after the ESLint half was cleared the same day.
Re-run with `npx eslint .` (stylesheets included since §7.1; the counts below were stylelint's).

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
- What's left is the canvas's layout and the SVG diagram. (The side panel went on 2026-10-19, with its key/value grid,
  table and log rows: its data is debug-mcp's `architecture_state`, `violations` included.) It's in `@layer app`, on `--wa-*` tokens only. The diagram's
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

**Cleared (stylelint, the rule editor, Rule view, pane window, admin and account: 114 → 0):**

- `rule-editor.css` (36 → 0): the editor's rows are `wa-cluster`s and its groups, actions and lists `wa-stack`s or
  `wa-cluster`s, with the gap utilities; a list of lists' items take `wa-flex-nowrap` and its + `wa-align-self-start`;
  the "When" / "of these are true" / "Then" words are `wa-color-text-quiet`, and a place in the code is
  `wa-text-truncate`. Left in `@layer app`: each control's width in a row, where a row's list and its − + go, a
  group's indent rule, and the place's chip. The `rule-editor-*` classes the tours query stay as hooks.
- `rule-view.css` (15 → 0): the edit's panel is a `wa-card` (its `--spacing` set), the verdict
  `wa-color-text-quiet`; left: the view's padding and a refused verdict's danger colour. Both workbench sheets declare
  Web Awesome's layer order ending in `app`, as the architecture view's does: they're `<style>`s ahead of the adopted
  Web Awesome sheets.
- `window.css` (26 → 0): `.wa-win*` is `.pane-window*` now (the saved-position key in localStorage is unchanged, so
  windows keep their places). Its title bar and controls are `wa-cluster`s, the title `wa-text-truncate` and
  `wa-font-weight-semibold`. Both `::part()` rules are gone. The controls' compact padding is
  `--wa-form-control-padding-inline` on their row. A collapsed window used to hide the card's `body` part; now the
  card's `--spacing` is 0, the title bar and body pad themselves, and collapsing sets `hidden` on the body. The title
  bar also shrinks now, so a long title truncates instead of pushing − and ✕ out of the card. That was already broken
  before the change.
- `admin.css` (29 → 0) and `account.css` (8 → 0): wrapped in `@layer app`. The app imports Web Awesome's stylesheet
  first, so `app` already comes after its layers. The sign-in screen's centring, the filter, maintenance and code
  forms' `align-items`, and the pairs' `align-items` are utilities (`wa-align-items-*`, `wa-justify-content-center`).
  The stat cards and navigation links are `wa-link-plain`, a user agent cell is `wa-text-truncate`, and `html, body`
  was Web Awesome's native styles already. The QR code's `background: white` is gone: uqr's SVG draws its own white
  ground.
- Checked in the running editor: the Rule view with a nested group, process.argv's runs and a disabled −, in light and
  dark. Checked on a pane window: drag, collapse, expand, and the hairline before the caller's actions. Checked in the
  admin app, signed in as the harness's owner: Overview, Audit log filters, the architecture diagram and its detail
  pair, and Your account with an authenticator being set up. Traffic's agent table needs an analytics token, so it
  wasn't seen. The capabilities tour (which drives the rule editor) passes: 24/24.

**Cleared (stylelint, `pane-views.css` 163 → 0 and `margin.css` 61 → 0):**

- The pane's buttons are `wa-button`s (size `s`): an item's choices in a `wa-cluster`, and a choice with ways to go
  (Allow: this call, this run, always) a split button — a `wa-button-group` of the button and a `wa-dropdown` whose
  trigger is a caret `wa-button`, its ways `wa-dropdown-item`s. That retired `.live-values-split`, `.live-values-menu`,
  `.live-values-menu-item`, `.live-values-choice.more` and the hand-rolled outside-click and Escape handling. A typed
  value is a `wa-input`. The class names the tours query stay on the components, so `.live-values-choice`,
  `.live-values-split` and `.live-values-menu-item` still find them; the tours that clicked a row's `button` or filled
  an `input.live-values-input` now click `.live-values-choice` and fill the input inside `.live-values-input`.
- A row's controls are no taller than its line: `--wa-form-control-height` is the editor's line height
  (`--notes-margin-line-height`, which `pane.ts` now sets beside the code font), and the row's `white-space: pre` is
  kept out of them. Otherwise `pre` renders the whitespace in the button's shadow template, a hidden Mock… button is
  59px tall, and every row grows a view zone under its line.
- What's left is the line-aligned layout (rows, columns per turn, the gutter column's marks, a step card and its
  label, the tab strip, the sash), all inside `@layer app` on `--wa-*` tokens. Their literal colours became Web
  Awesome's fills and text tokens: coverage and a run's end are `success` / `warning` / `danger`, a tone's bar the
  variant's fill, a step's state the variant's `on-quiet`. The Margin's accent (`--margin-accent`) is the palette's
  `--wa-color-purple-60`, as the architecture view's hub links are, so it doesn't follow the light/dark mode.
  Spacing measured in the code's characters is `--live-values-ch` (`1ch`), named once, not a Web Awesome step.
- Two things Web Awesome has no token for went into the bridge (`vscode.css` / `vscode.js`), the one place
  `--vscode-*` is read:
  - a value's colours as VS Code's debugger shows them, `--code-value-name` / `-string` / `-number` / `-boolean`
    (not `--wa-*`, since they aren't Web Awesome's), so live values still read like the debugger's hover in any
    theme;
  - VS Code's UI font. `--vscode-font-family` is defined only in webviews, so in the workbench the bridge's
    `--wa-font-family-body` was empty and components fell back to inheriting. `followVsCodeTheme` now fills it from
    the workbench element's font, and `pane.ts` no longer sets `--vscode-font-family` / `-size` on the frame itself.
- Gone as dead: `.live-values-choice.allow` and `.live-values-choice.mock`, `.live-values-check`, `.live-values-row.mocking`
  and `.live-values-input.refused` (nothing set those classes). `pane-views.css` is 412 → 297 lines (183 → 107
  declarations); `margin.css` 168 → 189, its declarations the same less the font workaround, plus the layer and
  the accent tokens.
- Checked in the running editor, light (Light+) and dark (Dark+), switched live: a loop's turns in columns, the
  debugger's value colours, coverage marks, step cards and their labels, the tabs, and every row exactly one line
  (18px) with no view zones under them. In a debug run stopped at `fs.writeFileSync`, the ask showed Allow ▾ /
  Skip ▾ / Deny ▾ and Rule…; Allow's caret opened this call / this run / always over the pane (not clipped by the
  frame), and choosing this run let the write happen.

**Cleared (the event sheet's inline styles, 56 → 0; §5 step 4):**

- The webview takes `theme/vscode` (§3): `view.ts` calls `followVsCodeTheme(document.body)` and puts in its exception
  sheet, `src/exceptions/event-sheet.css`. Its 25 inline-style writes in `view.ts` and 31 in `authoring.ts` are gone,
  with both files' blanket `no-inline-styles` / `no-css-in-strings` / `prefer-components` disables and their
  `--vscode-*` literals with hex fallbacks.
- Buttons are `wa-button`s: Build / Map and Generate in VS Code's primary and secondary colours (`brand` /
  `neutral`), a paint tool's button `brand` while it's in hand and outlined otherwise, with its sprite in the `start`
  slot, and × / ＋ behavior plain. Behaviors are `wa-tag`s, an object's removable (`with-remove`). Rows, cards and
  headers are `wa-stack` / `wa-split` / `wa-cluster`, their type the text utilities (`wa-caption-xs`,
  `wa-font-weight-semibold`, `wa-text-uppercase`, `wa-color-text-quiet`, `wa-font-size-s`). A Map row's hover is CSS
  now, not two listeners per row.
- What's left (43 declarations): the view's frame, rows and cards ruled off, section padding, the code font, the
  opaque note's italic, and the sprite grid. The frame is `position: fixed` rather than styling `body`: VS Code's
  default webview styles give `body` padding, unlayered, so no layered rule can take it back. The grid's size and its
  floor and wall tiles are the level's, set as custom properties on it (`--columns`, `--rows`, `--cell`, `--floor`,
  `--wall`), and black off the map is `--wa-color-gray-05`.
- The page's policy allows `connect-src data:`: Web Awesome fetches its system icons (a tag's ✕) as `data:` SVGs, as
  on the sign-in pages. A `data:` URL reaches no server.
- Not checked in the running editor (no dev server to hand); the architecture suites build the webview's script and
  pass. The game files `library.ts` emits keep their own CSS: they're the game's, not the editor's.

**Cleared (the insights monitor's page, 2026-10-20):**

- Its page was one string: a `<style>` on `--vscode-*` and a script building its cards as HTML, behind
  `no-html-in-strings` / `no-css-in-strings` disables. The script is `extensions/insights/monitor-view.ts` now, built
  like the event sheet's (`bundledExtension`'s `script`, listed in the manifest's `files`) and inlined into the page
  `monitor.ts` serves; it builds its cards as elements, not markup. It calls `followVsCodeTheme(document.body)`.
- A card is a `wa-card` (outlined), its head a `wa-split`, its legend a `wa-cluster`, their type the text utilities.
  What's left is `src/exceptions/insights-monitor.css`: the frame (fixed, as the event sheet's) and the sparklines.
- Its line colours were VS Code's `--vscode-charts-*`; they're the palette's `-60`s now (blue, orange, green,
  purple, red, yellow), not a bridge entry: they only need to tell the lines apart, where the debugger's value colours
  had to match the debugger's. Like the Margin's purple, they don't follow the light/dark mode.
- Not checked in the running editor; the architecture suites build its script and pass (97).

**Before clearing** (the baseline):

**ESLint** (`webawesome/*`, in `.ts`/`.tsx`/`.js`):

| Rule | Errors | Where |
| --- | ---: | --- |
| `no-css-imports` (4.1) | 10 | 4 workbench `?raw` sheets, `pane.css?raw`, `git-panel`, `window`, `admin`, `account` (×2) |
| `prefer-components-wrapped` (4.3) | 31 → 30 | `api/public/sign-in.js` 19, `architecture-view.ts` 6 → 5, `rule-editor.ts` 5, `rule-view.ts` 1 |

`no-css-imports` is a plugin rule rather than a `no-restricted-imports` pattern. ESLint flat config replaces a rule's
options per file instead of merging them, so a second `no-restricted-imports` would silently undo the realm
boundaries.

**Stylelint** (`stylelint.config.js`, 4.2): 864 errors in 10 files at the baseline, 735 after the ESLint half, 0
now (by rule below, at the baseline). The exceptions stay held to every rule: the theme's own override covers
only `theme.css` and `vscode.css`.

| Rule | Baseline | Now |
| --- | ---: | ---: |
| `webawesome/no-unlayered-rules`: a rule outside `@layer` | 389 | 0 |
| `scale-unlimited/declaration-strict-value`: a literal color/space/type/radius where a `--wa-*` token belongs | 273 | 0 |
| `declaration-property-value-disallowed-list`: a `var(--vscode-*)` | 142 | 0 |
| `selector-disallowed-list`: selecting `wa-*` tags, `::part()`, or our own `.wa-*` classes | 58 | 0 |
| `declaration-no-important` | 2 | 0 |

The files are in `src/exceptions/` now; the paths are where each one came from.

| File | Baseline → now |
| --- | ---: |
| `editor/shell/git-panel.css` | 216 → 0 |
| `editor/workbench/architecture-view.css` | 205 → 0 |
| `editor/workbench/pane-views.css` | 163 → 0 |
| `editor/workbench/rule-editor.css` | 65 → 0 |
| `monaco-vscode-api/pane.css` (`margin.css`) | 61 → 0 |
| `api/public/sign-in.css` | 56 → 0 |
| `editor/workbench/rule-view.css` | 33 → 0 |
| `admin/src/admin.css` | 30 → 0 |
| `editor/shell/window.css` | 26 → 0 |
| `account/src/account.css` | 9 → 0 |

Most of the unlayered count is mechanical: wrapping each file in `@layer app { … }` clears it. The other rules
measure the real work. The ESLint errors fail CI's `lint` (lib's `util-lint`). Stylelint runs only through
`npm run lint:css`, because `util-lint` ran ESLint only (2026-10-19; since §7.1 ESLint lints CSS itself).

## 7. Confinement: all styling in this package

The next goal (2026-10-20): every bit of styling goes through `theme`, and other packages use only what it exports
(its classes and recipes, the Web Awesome components it allows, and its Stitches instance, 7.5). Web
Awesome is reached only through `theme` too, which makes it the place to curate the catalog and to add fragments of
our own, so consistency of look and layout is enforced in practice and not only by review. Each step adds a lint rule
that fails when styling turns up outside, so the confinement holds once it's reached.

Where it stands (2026-10-20):

- **Stylesheets** are confined already. Every `.css` file the editor uses is in `src/exceptions/`, and
  `webawesome/no-css-imports` fails any other stylesheet import. The one stray is `packages/api/public/sign-in.css`
  (15 lines): the API doesn't depend on `theme` (§3).
- **CSS-in-JS** isn't. Stitches is set up in `packages/editor/shared/theme.ts`, not `theme`, with about 70 `css()`
  calls in the shell (`shell.tsx` 49, `shell-preview.ts` 10, `shell-dock.ts` 8, `preview-devtools.ts` 1).
- **Web Awesome** is imported directly by 16 files outside `theme`, for 19 components: badge, button, button-group,
  callout, card, checkbox, dialog, divider, dropdown, dropdown-item, input, option, page, progress-bar,
  relative-time, select, spinner, tag, textarea. The most used tags are `wa-button` (79), `wa-callout` (37),
  `wa-badge` (21) and `wa-input` (18).
- **Inline styles** are behind 18 `no-inline-styles` disables, almost all runtime geometry (a window's drag position,
  a column as wide as its widest value, the pane frame's layout). Eight `style.setProperty` calls already hand
  geometry to a sheet as custom properties (the pane, the event sheet's grid).

### 7.1 The CSS rules move into ESLint (lib)

Done 2026-10-20 (lib and the editor committed; the editor's half needs that util published first — see below).

Stylelint is a second linter with its own config, which is why `util-lint` (ESLint only) never ran it and CI doesn't
check CSS (§6). ESLint lints CSS itself through its official plugin, `@eslint/css`, so the rules move into util's
ESLint preset, `util-lint` covers CSS in every consumer, and stylelint goes:

| Rule today (stylelint) | In ESLint |
| --- | --- |
| `webawesome/no-unlayered-rules`: every rule in an `@layer` | `css/use-layers` (built in) |
| `declaration-no-important` | `css/no-important` (built in) |
| `scale-unlimited/declaration-strict-value`: tokens, not literals | a `webawesome/*` rule, sharing `css-in-js-tokens`' logic so `.css` and Stitches are held to one token policy |
| `declaration-property-value-disallowed-list`: `--vscode-*` only in `src/vscode.css` | a `webawesome/*` rule |
| `selector-disallowed-list`: no `wa-*` tags, `::part()` or `.wa-*` classes of our own | a `webawesome/*` rule |

- A new rule with them: **no `.css` file outside `packages/theme`**. With CSS linted by ESLint, that's a rule on
  the file's path.
- `@eslint/css` 2.0.1 was published on 2026-10-15, inside CI's 7-day cooldown: pin the newest version that's a week
  old, or wait for 2.0.1 to clear it.
- Then the editor drops `stylelint`, `stylelint-declaration-strict-value`, `stylelint.config.js` and `lint:css`.

As built:

- **util** (`util/eslint.ts`): `@eslint/css` (`^2.0.0`, so CI's cooldown takes 2.0.0) for `**/*.css`, its recommended
  rules with the preset's severity meaning (auto-fixable warns, the rest errors), and `css/no-invalid-properties`
  allowing variables a file doesn't declare (a stylesheet on a design system's tokens reads them from the system).
  A config object with no `files` would apply JavaScript's rules to stylesheets, where they crash, so util's own leave
  CSS out (`ignores`), and a consumer's need `files` (the editor's `no-void` block got them).
- **eslint-plugin-webawesome**: `css-tokens` (one function, `tokenProblems`, behind it and `css-in-js-tokens`, so a
  stylesheet and a Stitches call get the same policy and messages), `css-no-vscode-variables`, `css-no-wa-selectors`
  and `css-only-in-theme`. The editor's config turns them on for `**/*.css` with `css/use-layers`, exempts
  `theme.css` / `vscode.css` (token definitions, unlayered on purpose) and `packages/api/public/sign-in.css` (§7.7),
  and allows `user-select` / `paint-order` under `css/use-baseline` (cosmetic where they fall short).
- One policy is a little looser than stylelint's was: literal `font-weight`, `line-height` and `font-family` aren't
  flagged (Stitches never was either). Planted violations of everything else are caught, with the step to use.
- It found a bug stylelint missed: `r: 5` in `architecture-view.css`, a unitless length CSS drops, so a hub's dot
  was drawn at its attribute's 4. It's `5px` now.
- Order: the editor's config names the `css` plugin's rules, which only util's new preset registers, so util is
  published before the editor's half is pushed, or CI's lint fails on a missing plugin.
- `theme.css` and `vscode.css` keep their override: unlayered on purpose, and `vscode.css` the one place
  `--vscode-*` is read.

### 7.2 Web Awesome only through `theme`, and a tag allowlist

Done 2026-10-20. As built:

- `src/components/<name>.js` re-exports Web Awesome's component (importing it registers the element) and
  `<name>.d.ts` its type, for the 19 the app uses: badge, button, button-group, callout, card, checkbox, dialog, divider,
  dropdown, dropdown-item, input, option, page, progress-bar, relative-time, select, spinner, tag, textarea.
  `package.json` exports them as `theme/components/*`. One module per component, so a document still loads only what
  it uses. The 59 imports in the editor and admin are on them now, types included (`import type WaButton from
  "theme/components/button"`).
- `webawesome/through-theme` fails any `@awesome.me/webawesome` import (static, dynamic, or a re-export) outside `theme`,
  naming the theme's way in. Exempt: `theme` itself, the API's sign-in bundler (`packages/api/scripts/webawesome.ts`,
  §7.7) and the lint plugin, whose maps name components as data.
- `webawesome/known-components` fails a `wa-*` component in JSX or given to a call (`createElement`, or a wrapper like
  the rule editor's `element("wa-select", …)`) that `theme` doesn't export. Its two lists come from folders in
  `eslint.config.js`: what `src/components/` holds (the allowlist), and Web Awesome's own `dist/components/` (the
  catalog, so `classList.add("wa-dark")` isn't mistaken for a component). Adding a component is a file in
  `src/components/`, visible in review.
- The JSX typings (`packages/editor/wa-jsx.d.ts`, `packages/admin/src/wa-jsx.d.ts`) list only exported components now, so
  TypeScript rejects the others in JSX too. They dropped `wa-icon`, `wa-tooltip`, `wa-drawer` and `wa-format-date`,
  which nothing registered.
- **Changed from the plan above:** Web Awesome stays a *peer* dependency of `theme`, not its own, and the consumers keep
  theirs. A peer resolves to the consumer's copy, which is exactly "one copy", and it needs no reinstall. The
  `resolve.dedupe` entries stay too: `packages/theme/node_modules` still has a stale 3.12 that `src/components/`'s
  imports would otherwise find.
- Checked: planted violations of both rules are caught (and a utility class and an exported tag aren't); ESLint 0
  errors; tsc's errors file for file what they were; the architecture suites pass (97); the admin app builds.

- `theme` re-exports each component it allows as `theme/components/<name>`: the side-effect registration and its
  types (`import type WaButton from "theme/components/button"`). Web Awesome becomes `theme`'s own dependency, and a
  plugin rule fails any `@awesome.me/webawesome` import outside `theme`. It's a plugin rule, not a
  `no-restricted-imports` pattern, for the reason `no-css-imports` is (§6): flat config replaces a rule's options per
  file, so a second `no-restricted-imports` would undo the realm boundaries.
- Blocking imports doesn't block use. Custom elements are registered globally, so once anything registers
  `wa-button`, any file can write `<wa-button>` or `createElement("wa-button")` with no import at all. The real
  enforcement is on tags: a `wa-*` element in JSX, `createElement` or markup must be one `theme` exports, and
  otherwise the rule names the component or fragment to use. `prefer-components` already finds these tags, so the
  rule is its extension (the element-side twin of `known-classes`, 7.4).
- The allowlist is the curated catalog. Adding a Web Awesome component is a change to `theme`, visible in review the
  way a new exception sheet is.
- It also tidies two things: one copy of Web Awesome (the `resolve.dedupe` entries in each Vite config, and the stale
  3.12 under `packages/theme/node_modules`, can go), and an upgrade is a change to one package.

### 7.3 Recipes and fragments

Done 2026-10-20 for the recipes; no fragment yet. As built:

- `src/recipes.css`, in every theme entry (`theme/chrome` imports it, so `theme` too; `theme/vscode` adopts it):
  `app-frame` (a document's whole view, fixed to the viewport, clear of a webview body's padding), `app-toolbar` (a
  bar of controls ruled off from what's under it) and `app-caption` (a section's or card's label: small, quiet,
  uppercase). The event sheet and the insights monitor take `app-frame`; the architecture view and the event sheet
  `app-toolbar`; the event sheet's headings, the monitor's card heads and the git panel's header `app-caption`. Their
  sheets lost those rules. The three captions had been three sizes (10, 11 and 12px) and two letter-spacings; the
  recipe makes them one (11px, 0.04em, semibold), which is the point.
- The layer-order prelude had been copied into the seven sheets a document gets as a `<style>` (`?raw`).
  `theme/sheet`'s `styleSheet(css)` makes that `<style>` and, once per document, puts the order first in its head:
  Web Awesome's own `@layer` statement (read from its `layers.css`, so an upgrade carries it) and then `app`. The seven
  sheets no longer declare it. `window.css` still does: the shell imports it as a stylesheet, not through the helper.
- Not extracted: dense controls. The pane's row controls (as tall as a code line) and a pane window's title bar
  (compact padding) want different things; two different needs aren't a recipe yet.
- The split-button fragment waits for a second use: the pane's Allow ▾ is still its only one, and the rule above is
  "a custom element only where a structure keeps coming back".
- Checked in the running editor (Brave, the dev server): the prelude first in the workbench's head, once; the
  architecture toolbar, the git panel's header, the insights monitor and the event sheet (its webview's first time
  seen running) on the recipes. The architecture suites pass (97); lint and tsc as before; admin builds.

What `theme` exports beyond Web Awesome's components: the shapes we keep building, so a surface composes them instead
of restyling. The realms differ (the shell is React; the workbench, webviews and extensions are plain DOM), so a
fragment has to work in both:

1. **Recipes: classes.** They work in every realm at no runtime cost. The first ones come from duplication already in
   `src/exceptions/`:
   - the fixed full-viewport webview frame, identical in `event-sheet.css` and `insights-monitor.css`;
   - the layer-order declaration, copied into every workbench and webview sheet (one shared prelude);
   - a toolbar: a bar with a rule under it (the event sheet's, the architecture view's);
   - the quiet uppercase section caption (the event sheet's headings and the architecture view's captions);
   - dense controls, no taller than a code line (the pane's row controls, a pane window's title bar).
2. **Fragments: custom elements of our own**, for structure that repeats and has behavior. Custom elements work in
   React and plain DOM alike. The first candidate is the split button: the pane's Allow ▾ is a `wa-button-group` of a
   button and a `wa-dropdown` on a caret, built by hand. A fragment would take an action and its ways, and give one
   element.
3. Not DOM helper functions (like the event sheet's `heading()`): React would need its own copy of each, so two
   implementations of everything.

Recipes first; a custom element only where a structure keeps coming back.

### 7.4 `known-classes`

Done 2026-10-20, as an error. As built:

- `webawesome/known-classes` reads the class names code sets as literals: JSX `class` / `className`, an object's
  `class` / `className` where the object goes straight to a call (`Object.assign(el, {…})`, `html(tag, {…})`; in plain
  data the key can mean something else), `el.className = …`, `classList` calls, `setAttribute("class", …)`, and the
  `element(tag, className)` helpers. Of a template literal it reads the whole words only (`tone-${tone}` is skipped).
- A name is known when something styles it: Web Awesome's own CSS (all of `dist/styles`: utilities, themes, native
  styles, layers), with its prefix families (`[class*='wa-stack']`); every class `packages/theme/src/**/*.css`
  declares (recipes, exception sheets); or a Stitches selector key in the editor's `css({…})` / `globalCss({…})`
  (`"&.open"`). `eslint.config.js` builds the lists from those files, so they follow the CSS.
- Measured first, in warn mode: 77 findings in 18 files. After narrowing object properties to call arguments and reading
  all of Web Awesome's styles, 16 were left, and every one was a real case:
  - **Dead classes, fixed:** `wa-font-family-code` (10 uses in admin: there's no such utility, so ids, releases and
    traces weren't monospace; §2 above wrongly listed it as one) is the new recipe `app-code`, which the event sheet's
    `.event-sheet-code` was too; `wa-color-danger-on-quiet` (a token's name, not a class) is admin's `.problem`.
  - **Classes nothing styles or reads, removed:** `maintenance`, `event-sheet`, `arch-toolbar`, `status-declared`,
    `is-collapsed`, `rule-editor-button`, `rule-editor-check`, `rule-editor-head`.
  - **Allowed, named in `eslint.config.js`:** VS Code's `codicon-*`, and the hooks the tours and the code query
    (`rule-panel-choice`, `rule-editor`, `rule-editor-then`, `live-values-split`, `live-values-menu-item`, `more`,
    `gp-expand`). A new hook is a new line there, visible in review.
- Exempt: the theme and the lint plugin (its messages say `class`). The other open question, Monaco's and codehike's DOM,
  needed no entries: our code sets none of their classes as literals, it only styles them, which the rule doesn't read.
- Checked: planted unknown classes are caught (utilities, recipes, prefix families, Stitches classes and data objects
  aren't); ESLint 0 errors; tsc as before; the architecture suites pass (97); admin builds.

§4.4: a `class` / `className` literal must be a Web Awesome utility (generated from the installed `utilities.css`)
or a class `theme` declares (in a recipe or an exception sheet). It's the class side of the contract that 7.2 is for
elements: code uses what `theme` exports and nothing else.

- Other people's DOM needs an allowlist: Monaco and VS Code, dockview and codehike have class names of their own, and
  some of ours style them (`git-panel.css` styles codehike's `sxs-*`). Without one, the rule would ban styling them
  at all.
- Runtime values go through custom properties: code may set `style.setProperty("--x", …)`, and a sheet in `theme`
  decides what it means (the pane and the event sheet's grid already do). Every other inline style stays an error,
  so `no-inline-styles` needs no disables for geometry.

### 7.5 Stitches, repo-wide, through `theme`

Done 2026-10-20, layered as Panda layers its own. As built:

- `theme/stitches` (`src/stitches.ts`, TypeScript so the instance keeps its types; Vite builds it from source, as it does
  the theme's other files) is the one instance: the palette and `css`, `globalCss`, `keyframes`, `theme`. The theme
  depends on `@stitches/core`, pinned at 1.2.8, its last release; the editor no longer does. `shared/theme.ts` keeps
  only the lucide icon helpers. The five importers (the shell's four files and `Workbench.tsx`) take `theme/stitches`.
- `webawesome/through-theme` fails an `@stitches/*` import outside the theme too, naming `theme/stitches`;
  `css-in-js-tokens` reads calls on `theme/stitches`' instance.
- **Spike, layers:** Stitches emits an `"@layer name"` key as an `@layer name { … }` block, for a style, its nested
  selectors, its variants and compound variants, and `globalCss` (checked with `getCssText()`), keeping its own order
  (base, variants, compound) inside the layer. So a wrapper can put every call in a layer, as Panda (Bamboo's base)
  does with `@layer reset, base, tokens, recipes, utilities`.
- **Spike, other documents:** VS Code copies into a docked window only the stylesheets it made (each marked
  `data-vscode`), so none of ours reached one: Workbench.tsx's Stitches (its classic look, 9c74eac, was missing there)
  and the exception sheets in the workbench's head. `theme/sheet`'s `mirrorStyles(document)` copies the unmarked
  `<style>`s (rules, not text, since Stitches inserts its) with the layer order first, and follows ones added after;
  `openDockedWindow` calls it, and stops it when the window closes. Checked in Brave: a docked editor's tabs are square
  now, its window holding the eight styles. A rule Stitches inserts later isn't followed (in VS Code's document its
  styles are global ones made at boot).
- **Layered** (decided 2026-10-20, as the spike above suggested). The order, lowest first, is theme/sheet's
  `layerOrder()`, which `theme/stitches` puts first in its document's head: `vendor`, Web Awesome's layers, then `app`,
  and in it `app.base` (`globalCss`), `app.recipes` (recipes.css), `app.styles` (`css()`, its variants and compound
  variants), then the exception sheets' own rules (in `app` itself). So precedence follows the layers, not
  specificity or insertion order: a Stitches class wins over a recipe and Web Awesome's utilities wherever it's
  inserted.
  - dockview's sheet (the shell adopts it, `shell-dock.ts`) is in `vendor`, so the shell's styles win over it by
    layer. It used to win ties, its adopted sheet coming last; checked in Brave that no rule of the shell's lost to it
    then (none of dockview's normal rules matches a shell element on a shared property at equal or higher specificity),
    and the shell has no `!important` for dockview's 43 to outrank now that they're layered.
  - VS Code's CSS isn't ours to layer, and unlayered CSS outranks every layer, so Workbench.tsx's two global styles
    over it are `unlayeredGlobalCss`, the instance's one way out (css-in-js-tokens reads it too). Its mount class is
    layered.
  - index.html's first-paint rule (`html, body`: a dark background until the shell's styles come) was unlayered and
    so outranked the shell's `globalCss` once that was layered: the body stayed #1e1e1e in light mode. It's in
    `app.base` now, before the shell's, so theirs win.
  - codehike styles inline, so nothing changes there.
- Checked: ESLint 0 errors; tsc as before; the architecture suites pass (97).

Decided 2026-10-20: Stitches is adopted repo-wide, wherever it helps (its variants, compound variants, token scales,
utils, `keyframes` and `globalCss`), not only in `theme`. What's confined is its setup: `theme` exports the one
configured instance (today's `packages/editor/shared/theme.ts`, its tokens all `--wa-*`), so every `css()` call in
the repo shares one token map and one place to change it.

- A rule fails a `@stitches/core` import outside `theme`: one instance, not one per package.
- `css-in-js-tokens` holds every `css()` / `globalCss()` / `keyframes()` call to the tokens, wherever it is, reading
  calls on `theme`'s instance instead of `shared/theme`'s.
- So 7's contract becomes "styling goes through what `theme` exports": its classes and recipes, the Web Awesome
  components it allows, and its Stitches instance. `.css` files stay confined to `theme` (7.1).
- Recipes (7.3) with variants are a natural Stitches export: a toolbar or a section caption with its sizes and tones
  as variants, one class to a consumer.
- Two things to settle in a spike before it spreads:
  - **Cascade layers.** `@stitches/core` inserts its rules unlayered (it has no `@layer` support), so a Stitches class
    outranks every Web Awesome layer and the `app`-layered sheets alike. That's usually the wanted result, but
    `css/use-layers` can't hold it, so precedence follows two systems. Find out whether its output can be put in a
    layer, or decide that Stitches is the top of the cascade.
  - **Other documents.** It injects into the `document.head` of the realm that loads it. A webview's policy allows
    that (`style-src 'unsafe-inline'`). VS Code's auxiliary windows copy the workbench's stylesheets, and whether
    that includes rules Stitches inserted (`insertRule`, not text) needs checking before the workbench uses it.
- It's finished, not maintained: 1.2.8 (May 2023) is its last release. It's small and has no dependencies, so it's a
  risk to watch, not a blocker; pin it rather than `latest`.

### 7.6 The budget

§4.5's two numbers, once everything they count is in one package: exception declarations (518 today, in 11 sheets)
and `webawesome/*` disables (39 lines today), both allowed only to go down, held in a committed file that a raise has to edit, as
`test/performance.mjs` holds the performance budgets. Stitches is repo-wide (7.5), so every `css()` declaration
counts with the sheets, wherever it is (`css-in-js-tokens` already reads them): moving a style from a sheet into
Stitches can't hide it.

Done 2026-10-20. As built:

- `packages/theme/budget.json` holds three numbers, and `test/budget.mjs` (the package's `test`, so CI's recursive
  `pnpm test` runs it) counts them over the repo's tracked files, the vendored components left out:
  - `exceptionDeclarations`, the declarations in `src/exceptions/*.css` (parsed with `@eslint/css-tree`, the
    parser ESLint's CSS language uses): 603. More than the 518 above, which was counted before admin's and
    account's sheets moved in (§7.1) and by stylelint's count;
  - `stitchesDeclarations`, every property in a `css` / `globalCss` / `unlayeredGlobalCss` / `keyframes` call on
    `theme/stitches`, wherever it is, its variants, compound variants and nested selectors included (parsed with
    TypeScript): 388, most of it the shell's (`shell.tsx` 219);
  - `webawesomeDisables`, the `eslint-disable…` comments that turn a `webawesome/*` rule off: 27, down from 39.
- It's a ratchet: over a budget fails, naming the files by count, and a raise means editing `budget.json`, where the
  diff shows it; under one fails too, until `budget.json` is lowered, so the room a removal made isn't spent unseen.
- Checked: a declaration planted in an exception sheet fails (604, budget 603), a loosened budget fails ("went down
  to 27, from 28"), and the counts as they are pass.
- Lowered 2026-10-20 to 600 / 328 / 27: the shell's four top-bar popovers (Run, Commit, Share, GitHub: each a
  backdrop, a positioned panel and hand-written menu rows) are a `wa-dropdown` and three `wa-popover`s
  (`theme/components/popover` added), and the diff's right-click menu a `wa-dropdown` opened at the click. Web
  Awesome puts them in the top layer, over the editor's iframe, with no z-index, and closes them on an outside click
  or Escape; the Run menu's keyboard navigation is its own now.
- Lowered 2026-10-20 to 600 / 227 / 15: the shell's Stitches mostly utilities now (wa-stack, wa-cluster, wa-split,
  wa-gap-*, wa-caption-*, wa-link, wa-text-truncate, the app-* recipes), only what's its own left in Stitches (a
  height, a padding, a border, a position) — close, not exact, by choice; and no-html-in-strings knows a placeholder
  (a bare `<name>`: `node <file>`, "<non-string>") and a whole document (`<!doctype html>…`, what a webview or an
  iframe takes, only as a string) from markup, and is off in tests (their fixtures' HTML), so 12 of its disables went.
  no-inline-styles sees `Object.assign(element.style, …)` too, which it missed (the margin's geometry, disabled now).
- Lowered 2026-10-20 to 600 / 309 / 27: the capability prompt is a `wa-dialog` over the shell, not a scrim and card
  over one preview window's app. Modal, so prompts are asked one at a time; closing it (Escape, its close button)
  denies, as an unanswered prompt does; the window whose app asked is still brought into view behind it; and the pane
  window that existed only to hold a prompt (no preview open) is gone. The diff overlay stays: it isn't a modal but a
  view over the editor, with the changes pane beside it live (picking files, a chunk's hover lighting its lines).

### 7.7 Documents outside the rule

Each needs either `theme` as a dependency or a declared exemption:

- the API's sign-in pages (their own Web Awesome bundle, §3, and `sign-in.css`);
- VS Code's own baseline in `packages/editor/workbench/Workbench.tsx`, on `--vscode-*`;
- the game files `extensions/event-sheet/library.ts` emits: the game's CSS, not the editor's.

### 7.8 Order

1. ~~The CSS rules into ESLint, in lib, with the no-CSS-outside-`theme` rule (7.1).~~ Done 2026-10-20.
2. ~~Web Awesome only through `theme`, and the tag allowlist (7.2).~~ Done 2026-10-20.
3. ~~Recipes, from the duplication above (7.3).~~ Done 2026-10-20 (the fragment waits for a second use).
4. ~~`known-classes` (7.4).~~ Done 2026-10-20.
5. ~~Stitches through `theme` (7.5): the spike on layers and auxiliary windows, then `theme` exports the instance and
   the shell imports it from there.~~ Done 2026-10-20, and layered (7.5).
6. ~~The budget (7.6).~~ Done 2026-10-20.

## 8. Stitches only, in this package, as components

Decided 2026-10-21 (the user's direction): all of the app's CSS is Stitches unless it can't be, all of it lives in
`packages/theme`, and the theme exports components (compositions of Web Awesome and Stitches) that a consumer can
override and extend, instead of a consumer styling things itself. §7 confined the CSS; this changes what the theme
hands out: no stylesheets and no `css()`, only components, recipes and tokens.

### 8.1 What can't be Stitches

Checked 2026-10-21. Stitches inserts its rules from JavaScript, into the document it runs in, so what it can't style
is what has no JavaScript of ours, or isn't ours:

- **Web Awesome's own stylesheets** and **dockview's** (vendors': loaded or adopted as CSS, in their layers).
- **`index.html`'s first-paint rule** (the shell's background before any script runs): one rule.
- **The game files the event sheet emits**: the game's CSS, written out as data (`extensions/event-sheet/library.ts`).
- **The API's sign-in pages** (`packages/api/public/sign-in.css`) could be (they load a script) but would paint
  unstyled until it runs. Left as the one declared CSS file unless a flash is acceptable there.

Everything else can: the shell and admin (Preact), the workbench's views (vanilla DOM, in VS Code's document; a docked
window gets them through `mirrorStyles`), the webviews (their policies allow `style-src 'unsafe-inline'`), the
codehike diff (React 18), and the theme's own token files (`theme.css`, `vscode.css`: `globalCss` of custom
properties, unlayered as now). Shadow parts are reachable the same way (`"&::part(input)"`).

### 8.2 Shape: what the theme exports

Consumers are three kinds of code: vanilla DOM (the workbench's views, the webviews), Preact (the shell, admin) and
React (the diff). So a component can't be one framework's. Two kinds, by need:

- **Recipes** (most of it): a named Stitches style with variants, for a Web Awesome element or plain markup, called
  for a class name: `toolbar({ "density": "compact" })`. Framework-free (a class string fits `class=`, `className=`
  and `element(tag, className)` alike). The markup stays the consumer's. Today's `app-*` classes become these, and so
  does what's in each exception sheet, per surface (`theme/styles/<surface>`).
- **Composed components** (where markup and behaviour repeat): a light-DOM custom element (`<app-window>`,
  `<app-popover-panel>`) the theme defines from Web Awesome elements and recipes. Light DOM, not a shadow root, so
  utilities, recipes and a consumer's override still cascade into it, and it works the same from every framework.
  The pane window (`shell/window.ts` + `window.css`) is the first candidate; a split button the second.

Override and extend, from the least to the most reach:

1. **Variants**: the options a component offers (`size`, `tone`, `density`), defined in the theme.
2. **Component tokens**: a recipe reads its values from its own custom properties, defaulting to Web Awesome's
   (`--app-toolbar-padding: var(--wa-space-xs)`), so a subtree, a document or a brand retunes one without CSS:
   Web Awesome's own pattern, and it reaches vanilla DOM and webviews too.
3. **A use-site override**: `toolbar({ "css": { … } })`, Stitches' own one-off. It goes in a layer above every recipe
   (`app.overrides`), so it wins by layer wherever it's inserted; `css-in-js-tokens` holds it to the tokens and the
   budget counts it.
4. **Extension**: a new recipe composed from one (`css(toolbar, { … })`), made in the theme, where it's reviewed.

### 8.3 Rules

- `theme/stitches` (`css`, `globalCss`, `keyframes`) is the theme's own: importing it outside `packages/theme` fails
  (`webawesome/through-theme`, widened). Consumers import `theme/styles/*`, `theme/components/*` and the recipes.
- A `.css` file anywhere but the declared few (8.1) fails; `theme/exceptions/` and `theme/sheet`'s `styleSheet` go
  once the last sheet is converted.
- The budget becomes two numbers: Stitches declarations (the theme's surface styles plus use-site overrides) and
  `webawesome/*` disables. Recipes and components aren't budgeted: they're the vocabulary, not exceptions.
- Lost in the move: `@eslint/css`'s checks (`use-baseline`, `no-invalid-properties`) apply to `.css` only. Extend
  `css-in-js-tokens` to the property-validity half, or accept it.

### 8.4 Order

0. ~~**Spike the shape** on two cases, used from Preact and from vanilla DOM: a recipe with variants, component tokens
   and a use-site override (the toolbar / caption family), and a composed component (the pane window). Check that the
   override wins by layer, tokens retune it, a docked window mirrors it, and a webview gets it.~~ Done 2026-10-21:
   - `theme/stitches` has `recipe()` (into `app.recipes`) beside `css()` (`app.styles`), and every component it makes
     is wrapped so a use-site `css` goes into `app.overrides`, the last of the order; the wrapper keeps Stitches'
     descriptors (its internal symbol among them), so `css(recipe, { … })` still composes.
   - `theme/recipes`: `toolbar` (variants `density`, `ruled`; tokens `--app-toolbar-padding-block`, `-padding-inline`,
     `-rule`) and `caption` (variant `size`; tokens `--app-caption-color`, `-size`). A token is read with Web Awesome's
     as its fallback and set only by a variant, so an ancestor retunes it and a variant still wins on its element.
     `.app-toolbar` / `.app-caption` are gone from recipes.css; their callers take the recipes: the shell and the git
     panel (Preact), the architecture view (vanilla, VS Code's document), the event sheet and the insights monitor
     (webviews). Two of the shell's `css()` became use-site overrides (`toolbar({ "density": "compact", "css": … })`).
   - `theme/app-window`: `<app-window>`, light DOM. It adds its chrome (a title, its drag handle; collapse and close)
     as children and never moves the ones it's given; a grid places them (`slot="header-actions"` beside the title, the
     rest in the body), and collapsing is the body's row at 0, clipped by the frame, so it holds whatever display the
     body's content is given. Its place and whether it's collapsed are kept under `storage-key` (the key the old window
     used). `shell/window.ts` is a thin factory over it (the `PaneWindow` the previews and the dock share), and
     window.css is gone.
   - Checked in Brave: the order ends `app.overrides`, and a more specific rule in `app.styles` loses to a use-site
     override; variants apply (compact padding, the 2xs caption); setting `--app-caption-color` on the git panel and
     `--app-toolbar-padding-inline` on the architecture view's host retunes them; a docked window (the architecture view
     moved into one) has the toolbar recipe, mirrored; the insights monitor's webview has the caption recipe and the
     layer order. `<app-window>` made by hand and rendered by Preact (then re-rendered, its children replaced in place)
     both drag, collapse (193 → 49px), expand and close, their events fired.
   - Found: a Web Awesome component in a docked window doesn't render (Lit adopts one constructed stylesheet in every
     document, which a second document refuses: "Sharing constructed stylesheets in multiple documents is not
     allowed"), so the architecture view's buttons are missing there. Not the spike's; fixed in §9.2.4.
   - `css-in-js-tokens` reads the theme's own `recipe()` / `css()` calls (`./stitches`) and a use-site override's `css`
     (a call on `theme/recipes`); the budget counts the overrides with the Stitches declarations.
1. ~~The shell's Stitches (227 declarations) into `theme/styles/shell*`; then the rule restricting `theme/stitches`.~~
   Done 2026-10-21: every Stitches definition the editor made (the shell's, the dock's, the preview's and DevTools',
   and Workbench.tsx's over VS Code) is in `theme/styles/shell`, `dock`, `preview` and `workbench`, the editor
   importing their names; `webawesome/through-theme` fails a `theme/stitches` import outside the theme (checked on a
   planted one); `theme/styles/workbench` keeps the exemption Workbench.tsx had (VS Code's baseline, §7.7);
   `known-classes` reads the theme's Stitches selector keys too; the budget counts `theme/styles/*` as the surfaces'
   declarations (227, unchanged by the move).
2. ~~`recipes.css` into recipes.~~ Done 2026-10-21: `frame` and `code` join `toolbar` and `caption` in theme/recipes;
   their callers (admin's ids and traces, the event sheet's webview, the insights monitor's, the diff overlay's title)
   call them; recipes.css is gone, and theme/chrome and theme/vscode no longer load it.
3. ~~The exception sheets, one surface per commit, smallest first: rule-view, account, insights-monitor (webview),
   rule-editor, window (as `<app-window>`), event-sheet (webview), admin, margin, architecture-view, pane-views,
   git-panel.~~ Done 2026-10-21: each sheet is `theme/styles/<surface>`, its rules by selector through
   theme/stitches' `stylesheet()` (in `app.styles`, the markup's class names unchanged), converted with its comments,
   and called once where the sheet was appended or imported; `theme/exceptions/` and `styleSheet()` are gone.
   `mirrorStyles` now follows what Stitches inserts after the copy (into its sheet and the groups it keeps), since a
   style's rules are made on its first use. One sheet declared a selector twice (pane-views' `.live-values-mock`):
   merged.
4. ~~The token files into `globalCss`.~~ Done 2026-10-21: `theme/tokens` (`brandTokens`, `vscodeTokens`), unlayered;
   theme/chrome, theme/vscode and theme/vscode-colors call them. The only stylesheet left is the API's sign-in pages'
   (8.1).
5. ~~The rules and the budget's new shape (8.3).~~ Done 2026-10-21: `css-only-in-theme` fails any stylesheet but the
   one exempted by name (sign-in.css); the budget is two numbers, Stitches declarations (801: the surfaces' and the
   use-site overrides') and `webawesome/*` disables (15), the exception sheets' count gone with them (and the CSS parser
   the budget needed). @eslint/css's `use-baseline` and `no-invalid-properties` now check only sign-in.css: accepted.

Risks: everything rides on Stitches, which is finished, not maintained (1.2.8, May 2023). It's small and has no
dependencies, so vendoring it into the theme is the fallback if it ever breaks. Everything styles after its script
runs, which is already so for everything but the sign-in pages and the first paint.

## 9. Web Awesome as VS Code

Decided 2026-10-21 (the user's direction): the end state is Web Awesome themed as VS Code. Whatever the app draws with
Web Awesome looks like VS Code's own UI in the active VS Code theme, wherever it is: the shell around the editor, the
workbench's views, the webviews, docked windows. §8 is how (the theme's components and recipes are where the look
lives); this is what they look like.

### 9.1 What's there

`theme/vscode` maps 26 of Web Awesome's tokens onto `--vscode-*` in VS Code's document and in webviews: type (VS
Code's UI font, a 13px scale), density (space ×0.75, radii ×0.5), surfaces and text, the brand fill (VS Code's button
blue), focus, and form controls (input background, border, value, placeholder). It follows a theme switch live, and
picks `wa-dark` / `wa-light` from VS Code's theme type.

### 9.2 What's missing

1. **The shell doesn't follow VS Code.** It's `theme/chrome`: Web Awesome's default theme retoned for the brand,
   following the system's light/dark mode, not VS Code's theme. VS Code's `--vscode-*` variables exist only in the
   workbench's document. The shell would mirror them: the workbench publishes the active theme's variables (on start
   and on every theme change) and the shell sets them on its root, so `theme/vscode`'s mapping applies there too, and
   to the dock, the popovers and the dialogs. Done 2026-10-21: `theme/vscode-colors` reads the active theme's
   `--vscode-*` (825, not the icons') and its kind from `.monaco-workbench`; the workbench publishes them on
   `theme.colors` at boot and on each theme change, and the shell sets them on its body with `data-vscode-theme-kind`
   and Web Awesome's mode, so `vscode.css` maps the shell's tokens as it does VS Code's. `vscode.css` maps dockview's
   too: a window's bar is VS Code's title bar (`titleBar.*`), groups and separators its editor groups'. Seen from the
   docked window (the user's report: its top bar, the dock's, and its status bar, VS Code's, looked like two apps):
   now one, light and dark (Dark Modern set in VS Code, the shell, its rails and the dock's bar went with it). Also
   found: a docked window VS Code restores at boot had none of theme/vscode's styles (it's made before the editor's
   document adopts them), so its Web Awesome had no tokens; `followVsCodeThemeIn(document)` adopts them into each docked
   document, and follows its `.monaco-workbench` once VS Code makes it.
2. **Shapes, not only colours.** Tokens give VS Code's colours and density, but Web Awesome's controls still look like
   Web Awesome: a button's height, weight and radius; a dropdown that should read as VS Code's context menu (tight
   rows, the list's active-selection colours, separators); a select, checkbox, badge, tag, dialog, tooltip and progress
   bar as VS Code draws them. Each becomes a theme component (§8.2): the Web Awesome element plus the theme's Stitches
   for its parts (`wa-button::part(base)`), on `--vscode-*` through the tokens, in one place per component.
3. **The rest of VS Code's palette**: hover and selection (`list.*`), menus (`menu.*`), badges, tooltips
   (`editorHoverWidget.*`), dialogs (`editorWidget.*`), errors and warnings (`errorForeground`, `editorWarning.*`),
   scrollbars, and high-contrast themes' borders (`contrastBorder`, `contrastActiveBorder`).
4. ~~**Docked windows.** Web Awesome components don't render in a docked editor window (Lit adopts one constructed
   stylesheet per component class, and a second document refuses it), so a view moved out of the editor area loses
   its controls. With Web Awesome everywhere this has to be fixed first.~~ Fixed 2026-10-21: a docked window is an
   `about:blank` frame, a realm of its own, and a component rendered in VS Code's document lost all its sheets when
   moved there (4 → 0), and one rendered there threw. `theme/documents`, imported first in the workbench, has Lit
   take its other way (a `<style>` in each shadow root, which goes wherever its component goes) by saying, before Lit
   loads, that `ShadyCSS` shadow DOM isn't native: the one thing Lit decides that by, and nothing else in the
   workbench's bundle or VS Code's reads it. Checked in Brave: the architecture view docked keeps its buttons and
   select (VS Code's colours, full size), no errors; a button rendered in VS Code's document keeps its look moved into
   the docked window and back. Cost, the performance suite run with and without it locally: the workbench realm
   237.4 vs 233.9 MB, boot 1154 vs 1142 ms, total memory the same (the browser shares identical `<style>`s' parsed
   contents).
5. **Documents without VS Code**: admin and the account pages. Either a fixed VS Code theme (Dark Modern / Light
   Modern's colours, following the system's mode) or Web Awesome's own look; to decide. Decided 2026-10-21, and
   corrected the same day: a first reading ("keep Web Awesome's own look") misunderstood the user, who wants the theme
   itself to be a Web Awesome theme with VS Code's look, on every page it's on. Built: `theme/tokens`' `vscodePalette`,
   a fixed copy of the editor's default themes' colours (Default Light+ / Default Dark+, the ones the editor takes from
   the system's mode, read from VS Code 1.142: the 42 the bridge and skin read, plus VS Code's font stacks), declared
   as VS Code declares them, on the document's root, dark when it's `wa-dark`; the bridge and `theme/vscode-skin` apply
   everywhere now, not only where VS Code is. Where VS Code's live colours are (`.monaco-workbench`, a webview's root,
   the shell's body), they're lower in the tree or inline, so they win and the active theme is followed. theme/chrome
   (so `theme`, admin's) sets it all up. Checked in Brave: admin is VS Code's look in light and dark (Light+'s and
   Dark+'s surfaces, text and button, VS Code's font, 26px buttons with 4px corners); with the system light and VS Code
   on Dark Modern, the shell's body and VS Code's document are dark (live) over the root's fixed light copy.

### 9.3 Order

1. ~~Docked windows (9.2.4).~~ Done 2026-10-21.
2. ~~The shell follows the active VS Code theme (9.2.1), so one mapping applies everywhere.~~ Done 2026-10-21.
3. The components, one at a time, each checked beside VS Code's own (9.2.2, 9.2.3): button, input and textarea,
   dropdown (as the context menu), select, checkbox, badge and tag, dialog and popover, callout, progress bar. Done 2026-10-21,
   close rather than exact (the user's preference), mostly by tokens: VS Code 1.142 defines its own shape tokens, so
   Web Awesome's radii map onto `--vscode-cornerRadius-*` and its shadows onto `--vscode-shadow-*`, and a control is
   VS Code's text button's (26px, 8px in, a 4px corner, normal weight; an 18px checkbox) — which reaches buttons,
   inputs, textareas, selects, dialogs and popovers at once. `theme/vscode-skin` styles the parts no token reaches, only
   where the VS Code theme is (admin keeps Web Awesome's look): a dropdown is VS Code's context menu (`menu.*`: its
   background, border, corner, depth and selection colours), a checkbox VS Code's own box and check, not a filled square.
   Checked in Brave, light and dark: a brand button and the select at 26px / 4px / normal weight on VS Code's colours,
   the Run menu and the Changes checkboxes as VS Code's. Not done, left as Web Awesome's on VS Code's colours: badges
   and tags (they carry meaning by variant), the progress bar (VS Code's is a 2px strip), callouts (VS Code has none).
4. ~~Admin and the account pages (9.2.5).~~ Done 2026-10-21: the theme is VS Code's look everywhere (9.2.5).

## 10. Publishing the components

The user's direction (2026-10-21): the recipes and composed components should eventually publish themselves as
components from `components/`, as monaco-vscode-api does (a package built to `dist`, released by the same pipeline as
`packages/*`, registry-less). Not now: what it opens up is below, each with where it leans.

- **How we keep using them.** monaco-vscode-api is consumed internally as its build, which goes stale until rebuilt.
  For UI that's edited all the time, internal use should stay on the source (Vite builds the theme's TypeScript
  already) and the build should be for others: one package, `exports` with a source condition for us and `dist` by
  default.
- **How others would use them.** Framework-free forms: recipes (a class from a call), and components as functions or
  as the light-DOM custom elements they make (`<app-window>`), which register themselves. Others also need tokens: VS Code's mapping if they're
  in VS Code (a webview, an extension), a fixed theme if not (the question §9.2.5 asks of admin).
- **A component as a function: slots and wiring.** The canonical form a function that takes the component's options,
  its slots as arrays (of nodes, strings or other components' results) and its handlers, and returns the element:
  `appWindow({ "label": "Preview", "actions": [toolbar], "body": [frame], "onClose": close })`. Slots are named arrays
  the function places (into a light-DOM custom element's slots, or a Web Awesome element's); interactivity is `on*`
  handlers for the component's own events, normalized (one `onSelect` whichever element fired it), plus the returned
  element's properties for imperative control. Preact and React use the same element in JSX (children with `slot=`),
  or a thin wrapper over the function. Recipes stay as they are (a function returning a class).
- **Web Awesome an optional peer, by deriving what it provides.** Web Awesome's manifest
  (`dist/custom-elements.json`, 73 components) says for each one its slots, attributes, events, parts, states and the
  components it needs (`wa-button` needs `wa-icon` and `wa-spinner`); its default theme defines its 237 tokens. A
  theme build step reads them with our components and writes our own manifest: for each component, the Web Awesome
  elements it needs (transitively), the slots, events and attributes it exposes, and the tokens it reads. From that:
  - types for a component's slots and handlers, and its docs;
  - tokens that degrade: every `var(--wa-…)` a recipe reads gets Web Awesome's default as its fallback, inlined
    (`var(--wa-space-xs, 0.75rem)`), so a page without Web Awesome's theme still lays out;
  - a native fallback for each Web Awesome element a component needs, used when it isn't registered
    (`customElements.get(tag) === undefined`): `<button>`, `<input>`, `<dialog>`, a `<details>` or the popover API for
    a dropdown, a checkbox. That's the reverse of `prefer-components`' native-to-Web-Awesome map, which already
    exists. Styled by the same tokens; the component's events stay the same, so handlers don't care which rendered.
  - then Web Awesome is `peerDependenciesMeta: { optional: true }`: with it, the full components; without it, the
    native fallbacks, plainer but working (a dropdown without its keyboard navigation, say).
  Cost: two renderings for each component published, so only for those, and checked both ways (a page with Web
  Awesome and one without).
- **Stitches** is not a peer: an implementation detail (the user's framing in §7.5), bundled and pinned at its last
  release, with vendoring it as the fallback.
- **What moves.** Whether `components/` gets the recipes and composed components alone, with `theme` keeping the
  tokens, the VS Code mapping and the rules, or the theme package as a whole. Leaning: components alone, depending on
  the theme for tokens.

### 10.1 Done (2026-10-21)

- **Flat, one package per component** (the user's call): `components/app-window`, `components/toolbar`,
  `components/caption`, `components/frame`, `components/code`, each `@brianjenkins94/<name>`, released by cd.yml's
  `components/*` like any package (a draft until its version is bumped). The theme keeps the look (theme/tokens, the
  VS Code bridge, the skin), the surfaces' styles, the rules and the budget.
- **Internal use is on the source**, which stays in the theme (theme/recipes, theme/app-window), and each
  `components/<name>` is the package that publishes one: its entry re-exports it by relative path, and util-publish
  bundles it, with what it uses (theme/stitches, theme/sheet, theme/component, theme/web-awesome): each published one
  has its own Stitches instance, the layer order shared. (The sources first moved into components/, the theme
  re-exporting them by relative path; CI's pnpm copies the theme into its store as a `file:` dependency, where a path
  out of it doesn't resolve, so the editor's build failed there and not here, where it's a symlink. The theme imports
  nothing outside itself.)
- **The function form** is theme/component: a component's `definition` (attributes, slots, events) gives
  `appWindow()` its typed options (camelCased attributes, slots as arrays, `children` for the default one, `on*`
  handlers with the `app-`/`wa-` prefix dropped) and gives the package its custom-elements.json. shell/window.ts uses
  it, and registers Web Awesome's button first (theme/app-window doesn't, so the published one needn't have it).
- **Derived from Web Awesome**: scripts/web-awesome.mjs writes src/web-awesome.ts (Web Awesome's layer order, so
  theme/sheet no longer imports its layers.css; the resolved default of each `--wa-*` token a component reads; each
  element's native counterpart, the reverse of `prefer-components`' map) and each element's custom-elements.json (its
  definition, its tokens with their defaults, the Web Awesome elements it makes, transitively). test/web-awesome.mjs
  fails when they're stale.
- **Web Awesome optional**: `recipe()` gives each `var(--wa-…)` its default as the fallback; `webAwesomeOr(tag)` makes
  the native counterpart when the Web Awesome element isn't registered; app-window uses plain rules where it used Web
  Awesome's utility classes; each package's Web Awesome peer is optional. Checked in Brave with the published tarballs
  (util-publish, locally): a page without Web Awesome (native buttons, the defaults' corners and spacing, the handlers
  firing) and one with its CDN build (its buttons and font).

Then util-publish (lib, the user's go-ahead 2026-10-21), so the tarballs carry what the package says:

- it ships the file a package's `customElements` names (the field tools find a Custom Elements Manifest by), exported
  at its own path, so app-window's custom-elements.json is in its tarball;
- it re-aims a declaration's relative imports from where its source is in the repo to where the declaration is in the
  tarball (app-window's `../../../packages/theme/src/component` became `../packages/theme/src/component`; debug-mcp's
  imports of observability were wrong the same way, checked, and are fixed with it), and ships a sibling's declaration
  that a shipped one imports, though the build has no module for it (a type-only import);
- and the recipes have a type their declarations can name (theme/component's `Recipe`): Stitches' inferred one can't be
  written outside its package, so tsc emitted none for them.

Checked by typechecking a project against the unpacked tarballs (strict, the libraries' declarations checked too): the
options, the element, and the recipes' variants are typed, and a misspelt attribute, handler or variant is an error.

And the look (2026-10-21): theme/vscode-theme is the theme's look in one call, `vscodeTheme(element?)`: VS Code's palette
(the fixed Default Light+/Dark+ copy), the bridge onto it, the skin, and Web Awesome's mode kept in step, with VS
Code's theme kind inside VS Code (`.monaco-workbench`, a webview's marked `body`, where the live colours win) and with
the system's mode anywhere else, where it also gives the root its font, text and background from the tokens (what Web
Awesome's own theme would). It loads none of Web Awesome. theme/chrome and theme/vscode call it (each adding the brand
and Web Awesome's sheets), and components/vscode-theme publishes it: importing it applies it where the page is.
Checked in Brave with the published tarballs: a page without Web Awesome and one with it (VS Code's font and colours,
the brand button VS Code's #007acc at 26px with a 4px corner, VS Code's checkbox), and a stand-in dark webview (the body
`wa-dark`, the live editor background over the fixed copy); and the editor's shell and the admin app as before.

Left:

- `natives` maps tags only (`wa-checkbox` would need `<input type="checkbox">`): enough for `wa-button`, the one a
  component makes now.

## Open questions

- ~~Is the per-document cost of loading Web Awesome components in the workbench iframe acceptable for initial load?~~
  Yes (measured 2026-10-20). Web Awesome with what it brings (lit, floating-ui) is 222 KB of the 3.9 MB workbench.js
  (by its source map), 54 KB of its 930 KB gzipped: about 6%. The workbench's eleven components bundled alone (265 KB,
  67 KB gzipped) take about 16 ms to parse, run and define, cold, and 2 ms with the code cache, beside a warm boot of
  about 545 ms. Not worth a budget of its own; the boot budget covers it.
- ~~Should webviews (event sheet, insights monitor) get `theme/vscode` too, or stay as declared exceptions?~~ They get
  it (2026-10-19): one bridge, declared on a webview's `body` as well as `.monaco-workbench`, rather than a second
  setup for webviews. The event sheet's and the insights monitor's do (§6). A webview's page has to allow
  `connect-src data:` if it shows Web Awesome's icons.
- ~~Is `known-classes` too strict for third-party DOM, such as Monaco and codehike?~~ No (7.4): our code sets none of
  their classes as literals; VS Code's `codicon-*` is the one allowed family.
