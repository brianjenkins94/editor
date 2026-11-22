const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

export const configuration: Record<string, unknown> = {
	"workbench.colorTheme": prefersDark ? "Default Dark+" : "Default Light+",
	"workbench.iconTheme": "vs-seti",
	"editor.fontSize": 12,
	"editor.semanticHighlighting.enabled": true,
	"editor.bracketPairColorization.enabled": false,
	"editor.scrollBeyondLastLine": true,
	"editor.mouseWheelZoom": true,
	"files.autoSave": "off",
	"javascript.updateImportsOnFileMove.enabled": "never",
	"typescript.updateImportsOnFileMove.enabled": "never",
	"workbench.sideBar.location": "left",
	"files.exclude": { "**/node_modules": true }
};

export const keybindings: unknown[] = [
	{ "key": "ctrl+d", "command": "editor.action.deleteLines", "when": "editorTextFocus" }
];
