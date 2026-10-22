/**
 * What the components need from Web Awesome, derived from Web Awesome (scripts/web-awesome.mjs: generated, don't edit):
 * its layer order, the default of each token a component reads, and each element's native counterpart.
 */
export const layers = "@layer wa-native, wa-base, wa-utilities, wa-color-palette, wa-color-variant, wa-theme, wa-theme-dimension, wa-theme-overrides;";

export const tokens: Readonly<Record<string, string>> = {
	"--wa-border-radius-s": "calc(1 * 0.1875rem)",
	"--wa-border-style": "solid",
	"--wa-border-width-s": "calc(1 * 0.0625rem)",
	"--wa-color-surface-border": "#e4e5e9",
	"--wa-color-surface-default": "white",
	"--wa-color-surface-raised": "white",
	"--wa-color-text-normal": "#1b1d26",
	"--wa-color-text-quiet": "#545868",
	"--wa-font-family-body": "ui-sans-serif, system-ui, sans-serif",
	"--wa-font-family-code": "ui-monospace, monospace",
	"--wa-font-size-2xs": "round(calc(round(calc(round(calc(calc(1rem * 1) / 1.125), 1px) / 1.125), 1px) / 1.125), 1px)",
	"--wa-font-size-xs": "round(calc(round(calc(calc(1rem * 1) / 1.125), 1px) / 1.125), 1px)",
	"--wa-font-weight-semibold": "500",
	"--wa-panel-border-radius": "calc(1 * 0.75rem)",
	"--wa-panel-border-style": "solid",
	"--wa-panel-border-width": "calc(1 * 0.0625rem)",
	"--wa-shadow-l": "calc(0 * 0.5rem) calc(1 * 0.5rem) calc(1 * 0.5rem) calc(-0.5 * 0.5rem) color-mix( in oklab, #101219 calc(1 * 4% + 8%), transparent )",
	"--wa-space-2xs": "calc(1 * 0.25rem)",
	"--wa-space-3xs": "calc(1 * 0.125rem)",
	"--wa-space-m": "calc(1 * 1rem)",
	"--wa-space-s": "calc(1 * 0.75rem)",
	"--wa-space-xs": "calc(1 * 0.5rem)"
};

export const natives = {
	"wa-button": "button",
	"wa-details": "details",
	"wa-dialog": "dialog",
	"wa-divider": "hr",
	"wa-input": "input",
	"wa-option": "option",
	"wa-progress-bar": "progress",
	"wa-progress-ring": "meter",
	"wa-select": "select",
	"wa-textarea": "textarea"
} as const;
