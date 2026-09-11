import type { VNode } from "preact";

// A bare `preact` import: `preact` isn't in the baked snapshot, so its TYPES come from the
// synchronously-seeded declaration surface (editor:types) and its SOURCE (for go-to-definition) streams
// from the unpkg CDN overlay on demand — now fetched SAME-ORIGIN through the `__proxy__` service worker,
// so it resolves under the cross-origin isolation Pages needs (see proxy.ts). The "clever filesystem
// fallback" in one line.

export class Counter {
	constructor(public value: number) {}

	increment(): void { this.value += 1; }

	/** A trivial preact node, just to exercise the external type import. */
	render(): VNode {
		return { "type": "span", "props": { "children": String(this.value) }, "key": null } as unknown as VNode;
	}
}
