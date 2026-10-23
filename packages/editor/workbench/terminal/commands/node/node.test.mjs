import assert from "node:assert/strict";
import { test } from "node:test";
import { juvy } from "@brianjenkins94/util/juvy";

import definition from "./command.ts";
import { invocationOf, isTestFile } from "./node.ts";

/** node's arguments, as juvy parses them by its definition. */
const parsed = async (args) => invocationOf(await juvy(definition.options, { "stopEarly": true }).parse(args));

test("node's arguments, read as node reads them", async () => {
	assert.deepEqual(await parsed(["--inspect", "app.ts", "a", "--port", "3"]), { "file": "app.ts", "args": ["a", "--port", "3"] }, "node's options before the file; the program's after, unparsed");
	assert.deepEqual(await parsed(["-e", "console.log(1)", "x"]), { "code": "console.log(1)", "print": false, "args": ["x"] });
	assert.deepEqual(await parsed(["-p", "1 + 1"]), { "code": "1 + 1", "print": true, "args": [] });
	assert.deepEqual(await parsed(["-v"]), { "code": "process.version", "print": true, "args": [] }, "the runtime's own version");
	assert.deepEqual(await parsed(["--test"]), { "tests": [] }, "the test files under the directory");
	assert.deepEqual(await parsed(["--test", "a.test.js", "b.test.mjs"]), { "tests": ["a.test.js", "b.test.mjs"] });
	assert.deepEqual(await parsed([]), { "unsupported": "node: there's no REPL here yet — `node -e` runs a line of code, `node` with a file runs a program", "exitCode": 0 });
	await assert.rejects(parsed(["-e"]), /argument missing/u);
	await assert.rejects(parsed(["--nope", "app.ts"]), /Unknown option '--nope'/u, "node's own options are checked");
});

test("node --test finds test files as node does", () => {
	assert.deepEqual(["math.test.js", "src/util-test.mjs", "a_test.ts", "test-a.cjs", "test/helpers.js", "test.js"].filter(isTestFile).length, 6);
	assert.deepEqual(["math.js", "testing.js", "node_modules/x/test/a.js", ".silo/test/a.js", "test/data.json", "latest.js"].filter(isTestFile), []);
});
