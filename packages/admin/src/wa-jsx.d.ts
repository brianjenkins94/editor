/**
 * JSX typing for the Web Awesome elements the admin app uses (as packages/editor/wa-jsx.d.ts does for the shell): preact's
 * own attributes, plus an open index for each component's.
 */
/* eslint-disable ts/naming-convention -- custom-element tag names are hyphenated by spec */
import type { HTMLAttributes } from "preact";

type WaAttributes = HTMLAttributes<HTMLElement> & Record<string, unknown>;

declare module "preact" {
	namespace JSX {
		interface IntrinsicElements {
			"wa-page": WaAttributes;
			"wa-card": WaAttributes;
			"wa-button": WaAttributes;
			"wa-badge": WaAttributes;
			"wa-callout": WaAttributes;
			"wa-spinner": WaAttributes;
			"wa-input": WaAttributes;
			"wa-checkbox": WaAttributes;
			"wa-select": WaAttributes;
			"wa-option": WaAttributes;
			"wa-relative-time": WaAttributes;
			"wa-divider": WaAttributes;
			"wa-dialog": WaAttributes;
			"wa-progress-bar": WaAttributes;
		}
	}
}
