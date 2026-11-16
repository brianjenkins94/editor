/**
 * The editor's node:test (extensions/tsval/node-test.js), run here by Node as the debugger runs it: a test's `timeout`
 * fails it as node's does once it hasn't settled in time, and one that settles within it passes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

/** What `body` (tests declared with `test` from the editor's node:test) prints when Node runs it. */
function ran(body) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "node-test-"));

	try {
		// (CommonJS, as the debugger loads it: its own folder's package is a module one)
		fs.copyFileSync(new URL("../extensions/tsval/node-test.js", import.meta.url), path.join(folder, "node-test.cjs"));
		fs.writeFileSync(path.join(folder, "tests.cjs"), `const test = require("./node-test.cjs");\n${body}\n`);

		return execFileSync(process.execPath, [
			path.join(folder, "tests.cjs")
		], { "encoding": "utf8" });
	} finally {
		fs.rmSync(folder, { "recursive": true, "force": true });
	}
}

test("a test's timeout fails it as node's does when it hasn't settled in time; one that settles in time passes", () => {
	const printed = ran([
		"test(\"never settles\", { timeout: 30 }, () => new Promise(() => {}));",
		"test(\"settles in time\", { timeout: 1000 }, () => new Promise((resolve) => { setTimeout(resolve, 10); }));",
		"test(\"no timeout\", () => {});"
	].join("\n"));

	assert.match(printed, /✖ never settles\n\s+(?:\S.*)?test timed out after 30ms/u, printed);
	assert.match(printed, /✔ settles in time/u, printed);
	assert.match(printed, /✔ no timeout/u, printed);
	assert.match(printed, /ℹ pass 2\nℹ fail 1/u, printed);
});
