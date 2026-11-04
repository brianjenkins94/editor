import assert from "node:assert/strict";
import { test } from "node:test";

import { parseVirtual, virtualUrl } from "../shared/virtual-path.ts";

test("a dev server's address: built, and found anywhere in a path", () => {
	assert.equal(virtualUrl("https://x.dev/editor/", "tab", 5173), "https://x.dev/editor/__virtual__/tab/5173/");
	assert.deepEqual(parseVirtual("/editor/__virtual__/tab/5173/src/main.ts"), { "tab": "tab", "port": 5173, "rest": "/src/main.ts", "prefix": "/editor/__virtual__/tab/5173" });
	assert.equal(parseVirtual("/__virtual__/tab/5173")?.rest, "");
	assert.equal(parseVirtual("/workspace/src/main.ts"), undefined);
	assert.equal(parseVirtual("/__virtual__/tab/notaport/"), undefined);
});
