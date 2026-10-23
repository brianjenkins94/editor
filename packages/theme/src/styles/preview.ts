/**
 * theme/styles/preview — the preview windows (editor/shell/shell-preview.ts, preview-devtools.ts): a window's body, DevTools docked under it, the popped-out note, the capability prompt's text.
 */
import { css } from "../stitches";

// A preview window's body anchors what covers its app (the popped-out note).
export const bodyRelative = css({ "position": "relative" });

// With DevTools open, the body splits: the app on top, DevTools docked below it (preview-devtools.ts).
export const bodySplit = css({ "display": "flex", "flexDirection": "column", "& > iframe": { "flex": "1 1 0", "height": "auto", "minHeight": 0 } });

// What a preview window shows while its page is popped out into a browser window of its own.
export const poppedLayer = css({
	"position": "absolute",
	"inset": 0,
	"zIndex": 4,
	"display": "flex",
	"flexDirection": "column",
	"alignItems": "center",
	"justifyContent": "center",
	"gap": "var(--wa-space-s)",
	"backgroundColor": "var(--wa-color-surface-default)",
	"color": "var(--wa-color-text-quiet)",
	"&[hidden]": { "display": "none" }
});

export const promptScope = css({ "display": "block", "fontFamily": "var(--wa-font-family-code)", "fontSize": "var(--wa-font-size-xs)", "wordBreak": "break-all", "color": "var(--wa-color-text-quiet)", "marginBlockEnd": "var(--wa-space-s)" });

export const promptWhy = css({ "display": "block", "fontSize": "var(--wa-font-size-xs)", "marginBlockEnd": "var(--wa-space-s)" });

export const promptNote = css({ "display": "block", "fontSize": "var(--wa-font-size-2xs)", "color": "var(--wa-color-text-quiet)", "textAlign": "end", "marginBlockStart": "var(--wa-space-2xs)" });
export const panelClass = css({ "flex": "0 0 45%", "minHeight": 0, "borderBlockStart": "var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border)", "& > iframe": { "display": "block", "border": 0, "width": "100%", "height": "100%" } });
