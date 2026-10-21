/** @jsxImportSource preact */
/**
 * The VS Code workbench host.
 *
 * VS Code lays out the workbench itself (the component's "workbench" layout): activity bar, sidebar, editors, panel,
 * auxiliary bar and status bar, with its own sashes, movable views and a remembered layout. This renders the element it
 * mounts into and hands it to `boot()` (via `onReady`), plus the few document-level styles our minimal host.html lacks.
 *
 * Styling is stitches (`theme`), which injects into this document's head — this whole tree is rendered *inside the
 * iframe* by `workbench-entry.tsx`. Its global styles here are over VS Code's CSS, which isn't layered and outranks every
 * layer, so they're `unlayeredGlobalCss`: theme/stitches' one way out of the layers.
 */
import { css, unlayeredGlobalCss } from "theme/stitches";

const mountCss = css({ "position": "absolute", "inset": 0 });

/** Where Modern UI is on (VS Code 1.142's `workbench.experimental.modernUI`), and an editor group's title within it. */
const MODERN = ".monaco-workbench.modern-ui";
const TITLE = `${MODERN} .part.editor > .content .editor-group-container > .title`;

/**
 * The workbench as it looked before Modern UI, with Modern UI on (VS Code's own look, so on --vscode-*). Its
 * settings do most of it — compact density takes the gaps between the parts away, uppercase view headers bring those back
 * (workbench-entry.tsx's configurationDefaults) — and this puts back what no setting reaches: square tabs on the tab bar's
 * own background, each ruled off from the next, the active one's top border; flat pane headers and list rows; the classic
 * type in titles and headers; a status bar without padding or its shadow line. Its rules are `!important` as Modern UI's
 * are. What the layout sizes in code stays as Modern UI has it: the tab bar's height, the activity bar's width, the status
 * bar's and the pane headers' heights.
 */
const classicLook = unlayeredGlobalCss({
	// Tabs: Modern UI draws the active one as a filled, outlined card joined to the editor ("connected"); classic tabs are
	// plain boxes with a border between them.
	[`${TITLE}, ${TITLE} .tabs-and-actions-container`]: { "backgroundColor": "var(--vscode-editorGroupHeader-tabsBackground) !important" },
	[`${TITLE} .tabs-container`]: { "padding": "0 !important", "gap": "0 !important" },
	[`${TITLE} .tabs-container > .tab`]: {
		"margin": "0 !important",
		"padding": "0 0 0 10px !important",
		"borderRadius": "0 !important",
		"borderRight": "1px solid var(--vscode-tab-border) !important",
		"backgroundColor": "var(--vscode-tab-inactiveBackground) !important",
		"minWidth": "fit-content !important",
		"boxShadow": "none !important"
	},
	[`${TITLE} .tabs-container > .tab.active`]: { "backgroundColor": "var(--vscode-tab-activeBackground) !important" },
	[`${TITLE} .tab > .tab-fill, ${TITLE} .tab > .tab-connected-edge, ${TITLE} .tab > .tab-divider, ${TITLE} .tab-connected-overflow-edge`]: { "display": "none !important" },
	[`${TITLE} .tab > .tab-border-top-container`]: { "display": "block !important", "top": "0 !important" },
	[`${TITLE} .tab .tab-label`]: {
		"margin": "0 !important",
		"height": "var(--editor-group-tab-height) !important",
		"lineHeight": "var(--editor-group-tab-height) !important",
		"color": "var(--vscode-tab-inactiveForeground) !important"
	},
	[`${TITLE} .tab.active .tab-label`]: { "color": "var(--vscode-tab-activeForeground) !important" },
	[`${TITLE} .tab .tab-actions`]: { "margin": "auto 0 !important", "border": "0 !important", "borderRadius": "0 !important", "width": "28px !important", "height": "20px !important" },
	[`${TITLE} .editor-actions`]: { "paddingRight": "8px !important", "marginBottom": "0 !important" },
	// The side bar's title and its views' headers: classic type, and headers flat across the bar.
	[`${MODERN} .part.sidebar > .composite.title`]: { "padding": "0 8px !important" },
	[`${MODERN} .part.sidebar > .composite.title .title-label h2`]: { "fontSize": "11px !important", "fontWeight": "400 !important", "textTransform": "uppercase !important" },
	[`${MODERN} .pane-header`]: { "margin": "0 !important", "paddingLeft": "0 !important", "borderRadius": "0 !important", "backgroundColor": "transparent !important" },
	[`${MODERN} .pane-header .title`]: { "fontSize": "11px !important", "fontWeight": "700 !important", "textTransform": "uppercase !important" },
	[`${MODERN} .monaco-list-row`]: { "borderRadius": "0 !important" },
	// The status bar: edge to edge, its items square.
	[`${MODERN} .part.statusbar`]: { "padding": "0 !important", "boxShadow": "none !important" },
	[`${MODERN} .part.statusbar .statusbar-item`]: { "paddingLeft": "2px !important", "borderRadius": "0 !important" },
	[`${MODERN} .part.statusbar .statusbar-item > a`]: { "padding": "0 8px !important", "borderRadius": "0 !important" }
});

const injectGlobals = unlayeredGlobalCss({
	// VS Code scopes the UI font to `.monaco-workbench-part` descendants only, so body-level
	// overlays (context menus, the command palette) — which render in a bare `.context-view`
	// appended to the body — miss it and fall back to the browser's serif default. Set the
	// platform font on the workbench root so it cascades to those too. The editor sets its
	// own monospace font explicitly, so this doesn't affect it.
	".monaco-workbench.mac": { "fontFamily": "-apple-system, BlinkMacSystemFont, sans-serif" },
	".monaco-workbench.windows": { "fontFamily": "\"Segoe WPC\", \"Segoe UI\", sans-serif" },
	".monaco-workbench.linux": { "fontFamily": "system-ui, \"Ubuntu\", \"Droid Sans\", sans-serif" },
	// Safe root defaults from the reference host (monaco-vscode-api demo's style.css) that our minimal host.html omits.
	// NB: we deliberately do NOT force `-webkit-font-smoothing: antialiased` / `text-rendering: optimizeLegibility`
	// here — those render text thin/pale; letting the OS default (subpixel) apply matches the real editor's weight
	// better. Keep only the harmless ones: no faux-bold synthesis, and no mobile text-size inflation.
	":root": {
		"fontSynthesis": "none",
		"WebkitTextSizeAdjust": "100%"
	},
	// Base styles the reference sets that our minimal host.html omits. Body-level overlays that don't set their own
	// (notifications, context menus, the command palette) would otherwise inherit browser defaults — 16px, BLACK text,
	// transparent background: too big, black-on-dark (unreadable). Pin VS Code's UI size (13px) and the theme fg/bg.
	".monaco-workbench": {
		"fontSize": 13,
		"color": "var(--vscode-foreground)",
		"backgroundColor": "var(--vscode-editor-background)"
	},
	// No Manage (gear) or Accounts menu at the foot of the activity bar: VS Code has no setting for them, and what they
	// open is on the keyboard (Settings ⌘, · Command Palette ⇧⌘P · Keyboard Shortcuts ⌘K ⌘S).
	".part.activitybar li.action-item:has(> a.codicon-settings-view-bar-icon), .part.activitybar li.action-item:has(> a.codicon-accounts-view-bar-icon)": {
		"display": "none !important" // over VS Code's own (more specific) activity-bar item rule
	}
});

/** Render the element the workbench mounts into, and report it once mounted. */
export function Workbench({ onReady }: { "onReady": (container: HTMLElement) => void }) {
	injectGlobals();
	classicLook();

	return (
		<main
			class={mountCss()}
			ref={(element) => {
				if (element !== null) {
					onReady(element);
				}
			}}
		/>
	);
}
