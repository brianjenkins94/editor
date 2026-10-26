/**
 * theme/styles/features-map — The features map (editor/workbench/features-map.ts): the Insights monitor's cards
 * (theme/styles/insights-monitor, whose series colors its blocks and legend take), with a block chart where the monitor
 * has a sparkline. What's here is the chart, the code no feature owns, and the feature in focus. On --wa-* tokens.
 */
import { stylesheet } from "../stitches";

export const featuresMapStyles = stylesheet({
	// The view's whole width (its body is a flex row).
	".fm-root": {
		"flex": "1"
	},
	".fm-chart": {
		"display": "block",
		"width": "100%",
		"height": "64px"
	},
	".fm-chart rect": {
		"fill": "var(--line)",
		"stroke": "var(--wa-color-surface-default)",
		"strokeWidth": "1px",
		"vectorEffect": "non-scaling-stroke",
		"cursor": "pointer"
	},
	".fm-none": {
		"--line": "var(--wa-color-red-80)"
	},
	"span.fm-none": {
		"color": "var(--wa-color-text-quiet)"
	},
	// The feature in focus: its block outlined, its name underlined.
	".fm-chart rect.fm-focused, .fm-chart rect:hover": {
		"stroke": "var(--wa-color-text-normal)",
		"strokeWidth": "2px"
	},
	"span.fm-focused": {
		"textDecoration": "underline"
	},
	".monitor .wa-cluster span": {
		"cursor": "pointer"
	}
});
