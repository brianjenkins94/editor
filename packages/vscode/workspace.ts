/**
 * Default workbench settings. Files come from the host over postMessage, so only the editor
 * settings/keybindings live here.
 */

/** Whether the OS currently prefers dark — picks the initial editor theme so boot matches the shell (no flash).
 *  Live switching is wired in workbench-entry.tsx (autoDetectColorScheme isn't hooked to matchMedia in this build). */
const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

/** VS Code user settings (settings.json), passed to `boot({ configuration })`. */
export const configuration: Record<string, unknown> = {
	// Follow the OS light/dark preference, like the shell chrome. Initial pick here; workbench-entry.tsx updates it live.
	"workbench.colorTheme": prefersDark ? "Default Dark+" : "Default Light+",
	"workbench.iconTheme": "vs-seti",
	"editor.fontSize": 12,
	"editor.semanticHighlighting.enabled": true,
	"editor.bracketPairColorization.enabled": false,
	"editor.scrollBeyondLastLine": true,
	"editor.mouseWheelZoom": true,
	"files.autoSave": "off",
	"workbench.sideBar.location": "left",
	// Keep the seeded node_modules type surface out of the explorer/search (a UI filter — doesn't affect
	// module resolution). The root editor-ambient.d.ts stays visible, like a conventional env.d.ts.
	"files.exclude": { "**/node_modules": true }
};

/** Keybindings (keybindings.json), passed to `boot({ keybindings })`. */
export const keybindings: unknown[] = [
	{ "key": "ctrl+d", "command": "editor.action.deleteLines", "when": "editorTextFocus" }
];
