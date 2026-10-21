/**
 * theme/styles/shell — the shell's chrome (editor/shell/shell.tsx): its page, top bar, panes, rails, project list and the diff overlay, besides Web Awesome and the recipes (PLAN.md §8.4 step 1: Stitches only in the theme).
 */
import { css, globalCss } from "../stitches";

// Structural CSS — the little that wa-page doesn't give us: full-viewport height, the editor iframe filling `main`,
// the diff overlay, and the collapse widths. All via theme tokens (stitches objects, not CSS strings).
export const injectGlobals = globalCss({
	// `clip`, not `hidden`: the shell page must never scroll, and a hidden overflow still scrolls programmatically — as
	// when VS Code focuses an editor in a dock panel mid-layout and the browser scrolls the page to show it.
	"html, body": { "height": "100%", "margin": 0, "overflow": "clip" },
	"body": { "backgroundColor": "var(--wa-color-surface-default)", "color": "var(--wa-color-text-normal)", "fontFamily": "var(--wa-font-family-body)" },
	// The shell fills the viewport; its menu/aside widths are theme-driven and collapse to 0 via the classes below.
	".wa-shell": { "height": "100vh", "--menu-width": "260px", "--aside-width": "380px" },
	// Collapsed = a slim rail, not hidden (the effect drives the exact value; these are the first-paint fallback).
	".wa-shell.lhs-collapsed": { "--menu-width": "68px" },
	".wa-shell.rhs-collapsed": { "--aside-width": "68px" }
});

// The top bar: branding + icon actions, spread across the header. wa-button (plain) for every control.
export const topBar = css({ "height": "40px", "padding": "0 var(--wa-space-s)", "borderBottom": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });

export const spacer = css({ "flex": "1 1 auto" });

// The top bar's popovers (Run's menu is a wa-dropdown; Commit, Share and GitHub are wa-popovers anchored to their
// buttons): Web Awesome positions them in the top layer, over the editor's iframe, and closes them on an outside click
// or Escape. A popover's content is a column this wide, to hold a token or a link.
export const popoverBody = css({ "width": "300px", "maxWidth": "80vw" });

export const ghError = css({ "color": "var(--wa-color-danger-on-quiet)" });

// An uncaught error's id (shell/reporting.ts), to quote: over everything, bottom right, until dismissed or a minute on.
export const errorNotice = css({ "position": "fixed", "insetInlineEnd": "var(--wa-space-m)", "insetBlockEnd": "var(--wa-space-m)", "zIndex": 2147483000, "maxWidth": "360px", "fontSize": "var(--wa-font-size-xs)" });

export const ghOk = css({ "color": "var(--wa-color-success-on-quiet)" });

// The menu/aside regions are full-height flex columns: a fixed header strip, then a scrolling body — so the projects
// list and the git panel each fill their side and scroll internally. `--header-height` is published by wa-page.
export const sideCol = css({ "height": "calc(100dvh - var(--header-height, 40px))", "minHeight": 0 });

// The panes flanking the editor get a border on the edge that meets it: the LHS project pane on its right, the RHS
// changes pane on its left. `position: relative` anchors the absolute resize grip on that inner edge.
export const navPane = css({ "position": "relative", "borderInlineEnd": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });

export const asidePane = css({ "position": "relative", "borderInlineStart": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)" });

// A thin drag grip straddling a pane's inner edge (the border meeting the editor) — absolute so it never shifts
// layout, with a wider hit area than the 1px border and a hover/active accent. Pointer-capture drives the drag so
// it keeps tracking even as the cursor passes over the editor iframe.
export const resizer = css({
	"position": "absolute",
	"top": 0,
	"bottom": 0,
	"width": "7px",
	"zIndex": 5,
	"cursor": "col-resize",
	"touchAction": "none",
	"&:hover": { "backgroundColor": "var(--wa-color-brand-fill-quiet)" },
	"&:active": { "backgroundColor": "var(--wa-color-brand-fill-loud)" },
	"&:focus-visible": { "outline": "var(--wa-focus-ring)", "outlineOffset": "calc(-1 * var(--wa-focus-ring-width))" }
});

export const resizerRight = css({ "insetInlineEnd": "-3px" }); // nav pane: grip on its right edge

export const resizerLeft = css({ "insetInlineStart": "-3px" }); // aside pane: grip on its left edge

// A bare vertical column of icon-buttons, top-aligned and centered in the rail — no card, no region padding (the
// wa-page menu/aside parts already have none), just the stack.
export const railRegion = css({ "height": "calc(100dvh - var(--header-height, 40px))", "paddingBlockStart": "var(--wa-space-2xs)", "overflow": "hidden" });

// Caption hugs its icon (tight) while the gap BETWEEN items (railRegion, above) is larger — so each icon+caption
// reads as one unit.
// Keeps an imperatively-mounted region (the git panel) in the DOM but out of view while its pane is collapsed.
export const sideBody = css({ "flex": "1 1 0", "minHeight": 0, "overflowY": "auto" });

export const sideHost = css({ "flex": "1 1 0", "minHeight": 0 });

// Navigation (projects) region.
export const picker = css({ "padding": "var(--wa-space-xs)" });

export const projectCard = css({
	"cursor": "pointer",
	"--spacing": "var(--wa-space-xs)",
	"&:focus-visible": { "outline": "var(--wa-focus-ring)", "outlineOffset": "var(--wa-focus-ring-offset)" },
	"&.selected::part(body)": { "backgroundColor": "var(--wa-color-brand-fill-quiet)" },
	"&.selected": { "borderInlineStart": "var(--wa-border-width-m) var(--wa-border-style) var(--wa-color-brand-fill-loud)" }
});

// The dock fills the `main` region (the editor iframe is its fixed panel); the diff overlay covers it when a file is opened.
export const dockHostCss = css({ "position": "absolute", "inset": 0 });

export const mainWrap = css({ "position": "relative", "height": "100%" });

export const overlay = css({
	"position": "absolute",
	"inset": 0,
	"zIndex": 20,
	"display": "none",
	"flexDirection": "column",
	"backgroundColor": "var(--wa-color-surface-default)",
	"&.open": { "display": "flex" }
});

export const overlayTitle = css({ "flex": "1 1 auto" });

export const overlayBody = css({ "flex": "1 1 auto", "overflow": "auto", "minHeight": 0 });
