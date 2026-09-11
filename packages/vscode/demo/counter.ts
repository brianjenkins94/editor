// A minimal VNode-like shape, kept LOCAL rather than `import type { VNode } from "preact"`. The demo used
// the bare `preact` import to showcase external type resolution (types from the baked snapshot, source from
// the unpkg CDN overlay), but resolving an external package makes the in-browser tsserver reach across origins,
// which stalls under the cross-origin isolation GitHub Pages needs (SharedArrayBuffer). Keeping the demo
// self-contained means index.ts (which imports this) analyzes cleanly everywhere, including Pages.
interface VNode {
	"type": string;
	"props": { "children": string };
	"key": null;
}

export class Counter {
	constructor(public value: number) {}

	increment(): void { this.value += 1; }

	/** A trivial node, just to exercise a typed return in the demo. */
	render(): VNode {
		return { "type": "span", "props": { "children": String(this.value) }, "key": null };
	}
}
