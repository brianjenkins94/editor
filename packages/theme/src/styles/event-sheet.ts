/**
 * theme/styles/event-sheet — The event sheet's webview (extensions/event-sheet: view.ts and authoring.ts): what Web Awesome's components and
 * utility classes don't cover. Its buttons, tags, stacks and clusters are theirs, and its frame, toolbar and headings'
 * type are recipes (theme/recipes); what's left is its rows, its sections' padding, and the level's sprite grid, all on --wa-* tokens (theme/vscode maps them onto the VS Code theme
 * in a webview too).
 */
import { stylesheet } from "../stitches";

export const eventSheetStyles = stylesheet({
	".event-sheet-body": {
		"flex": "1",
		"minHeight": "0",
		"overflow": "auto",
		"paddingBottom": "var(--wa-space-m)"
	},
	".event-sheet-message": {
		"padding": "var(--wa-space-m)"
	},
	".event-sheet-heading": {
		"padding": "var(--wa-space-s) var(--wa-space-s) var(--wa-space-2xs)"
	},
	".event-sheet-heading.divided": {
		"borderTop": "var(--wa-border-width-s) solid var(--wa-color-surface-border)"
	},
	".event-sheet-section": {
		"padding": "var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-s)"
	},
	// A row (the Map's) or a card (Build's): one thing, ruled off from the next. A row opens its code.
	".event-sheet-row, .event-sheet-card": {
		"padding": "var(--wa-space-xs) var(--wa-space-s)",
		"borderBottom": "var(--wa-border-width-s) solid var(--wa-color-surface-border)"
	},
	".event-sheet-row": {
		"cursor": "pointer"
	},
	".event-sheet-row:hover": {
		"background": "var(--wa-color-neutral-fill-quiet)"
	},
	// A rule's event→action rows and its note, under it.
	".event-sheet-nested": {
		"paddingLeft": "var(--wa-space-2xl)"
	},
	".event-sheet-note": {
		"fontStyle": "italic"
	},
	// The level's sprite grid (a level, painted): pixel art at its own size, a cell per tile, black off the map. The
	// size and the two tiles are the level's, set on the grid (authoring.ts).
	".event-sheet-scroll": {
		"overflow": "auto"
	},
	".event-sheet-grid": {
		"display": "grid",
		"gridTemplateColumns": "repeat(var(--columns), var(--cell))",
		"gridTemplateRows": "repeat(var(--rows), var(--cell))",
		"width": "max-content",
		"background": "var(--wa-color-gray-05)",
		"border": "var(--wa-border-width-s) solid var(--wa-color-surface-border)"
	},
	".event-sheet-grid > div": {
		"boxSizing": "border-box",
		"backgroundImage": "var(--wall)",
		"backgroundSize": "cover",
		"imageRendering": "pixelated"
	},
	".event-sheet-grid > div.floor": {
		"backgroundImage": "var(--floor)"
	},
	".event-sheet-grid img": {
		"width": "100%",
		"height": "100%",
		"imageRendering": "pixelated",
		"pointerEvents": "none"
	},
	// A tool's sprite, on its button.
	".event-sheet-sprite": {
		"width": "14px",
		"height": "14px",
		"imageRendering": "pixelated"
	}
});
