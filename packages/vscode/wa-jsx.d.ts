/**
 * JSX typing for the Web Awesome custom elements we author in preact `.tsx`.
 *
 * Preact's `JSX.IntrinsicElements` only knows the standard HTML tags, so `<wa-button>` would otherwise be a type
 * error. This augments it with the `wa-*` elements the shell uses. Each carries preact's full `HTMLAttributes` (so
 * `class`, `onClick`, `onInput`, `ref`, `id`, `slot`, … stay typed) plus an open index for the components' own
 * attributes (`appearance`, `size`, `with-header`, …) and custom-event handlers — kept permissive on purpose so the
 * markup reads naturally without re-deriving Web Awesome's full prop types here.
 */
/* eslint-disable ts/naming-convention -- custom-element tag names are hyphenated by spec (wa-button, …), not camelCase */
import type { JSX as PreactJSX } from "preact";

type WaAttributes = PreactJSX.HTMLAttributes<HTMLElement> & Record<string, unknown>;

declare module "preact" {
	namespace JSX {
		interface IntrinsicElements {
			"wa-button": WaAttributes;
			"wa-card": WaAttributes;
			"wa-input": WaAttributes;
			"wa-textarea": WaAttributes;
			"wa-checkbox": WaAttributes;
			"wa-badge": WaAttributes;
			"wa-divider": WaAttributes;
			"wa-icon": WaAttributes;
			"wa-tooltip": WaAttributes;
			"wa-callout": WaAttributes;
			"wa-spinner": WaAttributes;
			"wa-dialog": WaAttributes;
			"wa-drawer": WaAttributes;
		}
	}
}
