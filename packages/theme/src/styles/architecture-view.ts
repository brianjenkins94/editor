/**
 * theme/styles/architecture-view — The architecture view (editor/workbench/architecture-view.ts): what Web Awesome's components and utility classes
 * don't cover. The toolbar is theirs: its badges, buttons, select and cluster. What's left is the canvas's layout and
 * the SVG diagram, all on --wa-* tokens (theme/vscode maps them onto the VS Code theme). What the diagram shows as data
 * (a channel's traffic, what needs review) is debug-mcp's architecture_state.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const architectureViewStyles = stylesheet({
	".arch-root": {
		// The diagram's colors: a message kind's matches its chip's variant (KIND_VARIANTS); hub links are purple.
		"--arch-request": "var(--wa-color-brand-fill-loud)",
		"--arch-reply": "var(--wa-color-success-fill-loud)",
		"--arch-event": "var(--wa-color-text-quiet)",
		"--arch-message": "var(--wa-color-warning-fill-loud)",
		"--arch-error": "var(--wa-color-danger-fill-loud)",
		"--arch-hub": "var(--wa-color-purple-60)",
		"width": "100%",
		"height": "100%",
		"overflow": "hidden",
		"background": "var(--wa-color-surface-default)"
	},
	".arch-body": {
		"display": "flex",
		"flex": "1",
		"minHeight": "0"
	},
	".arch-canvas": {
		"position": "relative",
		"flex": "1",
		"minWidth": "0",
		"overflow": "auto"
	},
	".arch-violations": {
		"color": "var(--wa-color-danger-on-quiet)"
	},
	// Diagram
	".arch-svg": {
		"display": "block",
		"userSelect": "none"
	},
	".arch-container rect, .arch-node rect, .arch-component-row rect": {
		"fill": "var(--wa-color-surface-raised)",
		"stroke": "var(--wa-color-surface-border)",
		"strokeWidth": "1"
	},
	".arch-container rect": {
		"fillOpacity": "0.55"
	},
	".arch-container.kind-origin rect, .arch-container.kind-remote rect": {
		"strokeDasharray": "5 3"
	},
	".arch-container.kind-group rect": {
		"fill": "none"
	},
	".arch-container-label, .arch-node-label": {
		"fill": "var(--wa-color-text-normal)",
		"fontSize": "var(--wa-font-size-s)",
		"fontWeight": "var(--wa-font-weight-semibold)"
	},
	".arch-container-caption, .arch-node-detail, .arch-node-badge": {
		"fill": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-xs)"
	},
	".arch-node": {
		"cursor": "pointer"
	},
	".arch-node rect": {
		"transition": "stroke 0.2s"
	},
	".arch-node rect.undeclared": {
		"stroke": "var(--arch-error)",
		"strokeDasharray": "4 2"
	},
	".arch-node.active rect": {
		"stroke": "var(--wa-color-focus)"
	},
	".arch-node.selected rect": {
		"stroke": "var(--wa-color-focus)",
		"strokeWidth": "2"
	},
	".arch-node-dot": {
		"fill": "var(--wa-color-text-quiet)"
	},
	// A box that stands for a node (the service worker's Network box) shows that node's status dot.
	":is(.arch-node, .arch-container.is-node).state-alive .arch-node-dot": {
		"fill": "var(--arch-reply)"
	},
	":is(.arch-node, .arch-container.is-node).state-unresponsive .arch-node-dot": {
		"fill": "var(--arch-error)"
	},
	":is(.arch-node, .arch-container.is-node).is-hub .arch-node-dot": {
		"r": "5px"
	},
	".arch-node.state-declared, .arch-node.state-terminated": {
		"opacity": "0.45"
	},
	".arch-node.state-declared rect": {
		"strokeDasharray": "3 3"
	},
	".arch-edge": {
		"fill": "none",
		"stroke": "var(--arch-request)",
		"strokeOpacity": "0.45",
		"strokeWidth": "1.5"
	},
	".arch-edge.status-undeclared": {
		"stroke": "var(--arch-error)",
		"strokeOpacity": "0.8"
	},
	// Idle (declared, not seen): tick() leaves its width alone.
	".arch-edge.status-ghost": {
		"stroke": "var(--wa-color-text-quiet)",
		"strokeOpacity": "0.35",
		"strokeDasharray": "4 4",
		"strokeWidth": "1"
	},
	".arch-edge-hit": {
		"fill": "none",
		"stroke": "transparent",
		"strokeWidth": "12",
		"cursor": "pointer"
	},
	".arch-edge-label": {
		"fill": "var(--wa-color-text-quiet)",
		"fontSize": "var(--wa-font-size-xs)",
		"textAnchor": "middle",
		"paintOrder": "stroke",
		"stroke": "var(--wa-color-surface-default)",
		"strokeWidth": "3px",
		"pointerEvents": "none"
	},
	"g:is(.hover, .focus, .selected) > .arch-edge": {
		"strokeOpacity": "1"
	},
	"g.selected > .arch-edge": {
		"stroke": "var(--wa-color-focus)"
	},
	".arch-svg.has-focus :is(.arch-node, .arch-component-row):not(.focus)": {
		"opacity": "0.35"
	},
	".arch-svg.has-focus g[data-edge]:not(.focus)": {
		"opacity": "0.15"
	},
	".arch-svg.has-focus g.focus .arch-edge-label": {
		"fill": "var(--wa-color-text-normal)"
	},
	// Discovered, not declared: extensions' commands, and what's written to stores and read from them
	".arch-edge.type-discovered": {
		"stroke": "var(--arch-reply)",
		"strokeOpacity": "0.5"
	},
	// Hub links: the tree the hubs federate over — drawn heavier than probed channels
	".arch-edge.type-hub": {
		"stroke": "var(--arch-hub)",
		"strokeOpacity": "0.55"
	},
	".arch-edge.type-hub.status-ghost": {
		"stroke": "var(--wa-color-text-quiet)"
	},
	// A box that stands for a node (the service worker's Network box): its header is the node's hit target.
	".arch-container-hit": {
		"fill": "transparent",
		"stroke": "none",
		"pointerEvents": "all",
		"cursor": "pointer"
	},
	// A collapsible box's chevron; lines into a collapsed box overlap, so their numbers are hidden.
	".arch-container-chevron": {
		"fill": "none",
		"stroke": "var(--wa-color-text-quiet)",
		"strokeWidth": "1.5",
		"strokeLinecap": "round",
		"strokeLinejoin": "round"
	},
	".into-collapsed .arch-edge-label": {
		"display": "none"
	},
	// A hub's components: rows in its box, and the lines of the messages each handles
	".arch-component-row rect": {
		"cursor": "pointer"
	},
	".arch-component-label": {
		"fill": "var(--wa-color-text-normal)",
		"fontSize": "var(--wa-font-size-xs)",
		"pointerEvents": "none"
	},
	".arch-edge.type-component": {
		"stroke": "var(--arch-hub)",
		"strokeOpacity": "0.4",
		"strokeWidth": "1.25"
	},
	// Messages in flight, in their kind's color
	".arch-pulse": {
		"fill": "var(--arch-event)",
		"pointerEvents": "none",
		"&.k-request": {
			"fill": "var(--arch-request)"
		},
		"&.k-reply": {
			"fill": "var(--arch-reply)"
		},
		"&.k-message": {
			"fill": "var(--arch-message)"
		},
		"&.k-error": {
			"fill": "var(--arch-error)"
		}
	}
});
