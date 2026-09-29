/** @jsxImportSource preact */
/**
 * The VS Code workbench host.
 *
 * VS Code lays out the workbench itself (the component's "workbench" layout): activity bar, sidebar, editors, panel,
 * auxiliary bar and status bar, with its own sashes, movable views and a remembered layout. This renders the element it
 * mounts into and hands it to `boot()` (via `onReady`), plus the few document-level styles our minimal host.html lacks.
 *
 * Styling is stitches (`theme`), which injects into this document's head — this whole tree is rendered *inside the
 * iframe* by `workbench-entry.tsx`.
 */
import { css, globalCss } from "./theme";

const mountCss = css({ "position": "absolute", "inset": 0 });

const injectGlobals = globalCss({
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
