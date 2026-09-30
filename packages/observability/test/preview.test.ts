import * as assert from "node:assert/strict";

import { test } from "node:test";
import { previewHost } from "../src/index.ts";

/** Run `body` with `window` and `location` stubbed as a page whose parent is `parent`. */
function asPage(pathname: string, parent: unknown, body: () => void): void {
	const globals = globalThis as unknown as { "window"?: unknown; "location"?: unknown };
	const saved = { "window": globals.window, "location": globals.location };
	const self: { "parent"?: unknown } = {};

	self.parent = parent ?? self;
	globals.window = self;
	globals.location = { pathname };

	try {
		body();
	} finally {
		globals.window = saved.window;
		globals.location = saved.location;
	}
}

test("previewHost is the editor window for a preview's top frame, and nothing for anything else", () => {
	const editor = { "location": { "pathname": "/" } };

	asPage("/__virtual__/t1/5173/", editor, () => { assert.equal(previewHost(), editor, "a preview's top frame"); });
	asPage("/__virtual__/t1/5173/instance.html", { "location": { "pathname": "/__virtual__/t1/5173/" } }, () => {
		assert.equal(previewHost(), undefined, "a frame the app nests (it reaches the editor through the app's tree)");
	});
	asPage("/", editor, () => { assert.equal(previewHost(), undefined, "not a preview"); });
	asPage("/__virtual__/t1/5173/", undefined, () => { assert.equal(previewHost(), undefined, "a top-level window"); });
	asPage("/__virtual__/t1/5173/", { get "location"() { throw new Error("cross-origin"); } }, () => {
		assert.equal(previewHost(), undefined, "a cross-origin parent isn't the editor");
	});
});
