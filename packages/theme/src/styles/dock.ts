/**
 * theme/styles/dock — the shell's dock (editor/shell/shell-dock.ts): its panels, the drop hint, a window's header actions and traffic lights.
 */
import { css, globalCss } from "../stitches";

// A panel's content box, and the iframe filling it.
export const fillCss = css({ "width": "100%", "height": "100%" });

export const frameCss = css({ "display": "block", "width": "100%", "height": "100%", "border": 0 });

// A window panel's body: what its owner puts in it fills it (an iframe, or the iframe over DevTools).
export const paneBodyCss = css({ "position": "relative", "width": "100%", "height": "100%", "overflow": "hidden", "& > iframe": { "display": "block", "width": "100%", "height": "100%", "border": 0 } });

// The editor's box, and what it shows while a window panel dragged over it would go into a VS Code editor.
export const editorBoxCss = css({ "position": "relative" });

export const dropHintCss = css({
	"position": "absolute",
	"inset": "var(--wa-space-s)",
	"pointerEvents": "none",
	"border": "var(--wa-border-width-m) dashed var(--wa-color-brand-fill-loud)",
	"borderRadius": "var(--wa-border-radius-m)",
	"backgroundColor": "color-mix(in srgb, var(--wa-color-brand-fill-loud) 12%, transparent)",
	"&[hidden]": { "display": "none" }
});

// A window panel's header actions, shown in its group's tab bar while it's the group's active panel.
export const paneActionsCss = css({ "display": "flex", "alignItems": "center", "height": "100%", "gap": "var(--wa-space-3xs)", "paddingInline": "var(--wa-space-2xs)" });

// A group's window controls, macOS style — at the head of its tab bar, or a floating window's title bar: grey where
// they do nothing, and in a group that isn't the active one until hovered; their glyphs show on hover. In a title bar
// they're a utility panel's (an inspector's): smaller, to match the bar.
/* eslint-disable webawesome/css-in-js-tokens -- macOS's traffic lights: their colours and geometry are the point, in either mode */
export const trafficLightsCss = css({
	"display": "flex",
	"alignItems": "center",
	"gap": "8px",
	"height": "100%",
	"paddingInline": "12px 8px",
	"& > button": {
		"display": "grid",
		"placeItems": "center",
		"width": "12px",
		"height": "12px",
		"padding": 0,
		"border": 0,
		"borderRadius": "50%",
		"boxShadow": "inset 0 0 0 0.5px rgb(0 0 0 / 0.2)",
		"color": "rgb(0 0 0 / 0.55)",
		"cursor": "default"
	},
	"& > button > svg": { "width": "100%", "height": "100%", "opacity": 0 },
	"&:hover > button:enabled > svg": { "opacity": 1 },
	"& > [data-control=close]": { "backgroundColor": "#ff5f57" },
	"& > [data-control=minimize]": { "backgroundColor": "#febc2e" },
	"& > [data-control=zoom]": { "backgroundColor": "#28c840" },
	"& > button:disabled, .dv-inactive-group &:not(:hover) > button": { "backgroundColor": "rgb(128 128 128 / 0.35)", "boxShadow": "none" },
	".dv-floating-titlebar > &": { "gap": "5px", "paddingInline": "6px", "& > button": { "width": "9px", "height": "9px" } }
});

/* eslint-enable webawesome/css-in-js-tokens */
// A floating window's title bar, inspector-height (dockview's is 22px).
export const injectDockGlobals = globalCss({ ".dv-floating-titlebar": { "--dv-floating-titlebar-height": "16px" } });
