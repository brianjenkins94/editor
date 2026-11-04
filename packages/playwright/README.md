# @brianjenkins94/playwright

The editor's own Playwright: `Page`, `Locator` and `expect` with Playwright's API, over a locator engine of our own that
runs where the page's DOM is. It's for `.locator` calls on the preview you have open, and for Playwright tests run in
the editor's debugger, where there's no browser to launch and no DevTools Protocol to drive one.

## How it's split

- **The engine** (`src/engine.ts`, also `./engine`) is DOM-only and serializable both ways: an `Op` (a locator's
  `steps`, an action, its arguments) goes in, an `Outcome` comes out — `done` with a value, not done yet with why (no
  element, not visible, covered by another), or an error that waiting won't fix (a strict mode violation). It finds
  (CSS, role, text, label, placeholder, alt text, title, test id, `nth`, `filter`), reads (states, text, value,
  attributes, the bounding box) and acts (click, fill, check, press, select…), one ask at a time.
- **The API** (`src/locator.ts`, `src/expect.ts`) is Playwright's, on a `Driver` that runs an `Op` somewhere. An
  action asks again, backing off, until it's done or its timeout passes (Playwright's auto-waiting); a locator's
  `expect` asks again until it holds. A locator finds nothing until it's used.
- **Drivers** say where the page is: `windowDriver(window)` (`src/driver.ts`) runs the engine on a window it can reach —
  a preview's frame is same-origin with the shell. In the debugger, the driver will be a request to the shell.

## What it promises

Playwright's semantics, held to Playwright itself: `test/engine.test.mjs` makes each Playwright call on both — a real
Playwright page in Chromium, and our `Page` running our engine in that same page — over one fixture
(`test/fixture.html`), and they must find the same elements.

- **Text** matches case-insensitively as a substring, whitespace collapsed, unless `exact`; `getByText` finds the
  smallest element that matches. A RegExp is tested as given.
- **Roles** are explicit or implicit (HTML-AAM's), and an element hidden from assistive technology isn't found unless
  `includeHidden`. Names are computed as accessible names are (`aria-labelledby`, `aria-label`, labels, `alt`, legend,
  caption, contents for the roles named from them, `title`, `placeholder`). `checked`, `disabled`, `expanded`, `level`,
  `pressed` and `selected` filter as Playwright's do (`expanded` without `aria-expanded` is neither; an `h3`'s level is
  3 whatever its `aria-level`).
- **Actions** are strict — two matches is an error, said at once — and wait until the element is visible, enabled
  (editable, to fill) and not covered where they'd click; a timeout says the last reason.
- **States** read as Playwright's: visible is a non-empty box and not `visibility: hidden`; disabled includes a disabled
  fieldset's descendants.

Not here: frames, `page.route`, screenshots, file uploads, drag and drop, and the `>>` selector syntax.

```bash
node --test packages/playwright/test/engine.test.mjs
```
