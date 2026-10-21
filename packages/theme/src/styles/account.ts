/**
 * theme/styles/account — Your account (packages/account/src/account.tsx): the authenticator app's QR code, recovery codes and monospace text —
 * on --wa-* tokens. Its code forms align with wa-align-items-end, its quiet text is wa-color-text-quiet.
 *
 * PLAN.md §8.4 step 3: an exception sheet, now Stitches in the theme (app.styles).
 */
import { stylesheet } from "../stitches";

export const accountStyles = stylesheet({
	".account-mono": {
		"fontFamily": "var(--wa-font-family-code)",
		"fontSize": "var(--wa-font-size-s)"
	},
	// The QR code's SVG draws its own white background (and quiet zone), so it scans in a dark theme too.
	".account-qr": {
		"width": "12rem",
		"height": "12rem",
		"imageRendering": "pixelated"
	},
	".account-recovery": {
		"display": "grid",
		"gridTemplateColumns": "repeat(2, max-content)",
		"gap": "var(--wa-space-2xs) var(--wa-space-l)"
	},
	// The editor shows it in a dialog (its shell/account-dialog.tsx): wide enough for the QR code beside its text.
	".account-dialog": {
		"--width": "38rem"
	},
	// There, without Web Awesome's native styles (the editor loads its theme and utilities only): the table's spacing.
	".account-dialog td": {
		"padding": "var(--wa-space-3xs) var(--wa-space-l) var(--wa-space-3xs) 0"
	}
});
