import assert from "node:assert/strict";
import { test } from "node:test";

import { invocationOf } from "./node.ts";

test("node's arguments, read as node reads them", () => {
	assert.deepEqual(invocationOf(["--inspect", "app.ts", "a", "-b"]), { "file": "app.ts", "args": ["a", "-b"] }, "options before the file; the program's after");
	assert.deepEqual(invocationOf(["-e", "console.log(1)", "x"]), { "code": "console.log(1)", "print": false, "args": ["x"] });
	assert.deepEqual(invocationOf(["-p", "1 + 1"]), { "code": "1 + 1", "print": true, "args": [] });
	assert.deepEqual(invocationOf(["-v"]), { "code": "process.version", "print": true, "args": [] }, "the runtime's own version");
	assert.match(invocationOf(["--test"]).unsupported, /node:test/u);
	assert.match(invocationOf([]).unsupported, /no REPL/u);
	assert.match(invocationOf(["-e"]).unsupported, /requires an argument/u);
});
