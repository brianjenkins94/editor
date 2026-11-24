/**
 * A script over the workspace (`script.run`): what it read and was refused, nothing written or outside.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/workspace-scripts.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("workspace-scripts");
const { ask } = session;

test("a script over the workspace, an agent's: a count across files and what it touched, the network refused, nothing written or outside", async () => {
	await ask("files.write", { "path": "scripted/a.json", "content": "{ \"n\": 2 }\n" });
	await ask("files.write", { "path": "scripted/b.json", "content": "{ \"n\": 3 }\n" });

	const run = async (code, timeoutMs) => session.request("script.run", { "code": code, ...timeoutMs === undefined ? {} : { "timeoutMs": timeoutMs } }, 60_000);
	const counted = await run("const files = await workspace.glob(\"scripted/*.json\");\nlet total = 0;\n\nfor (const file of files) {\n\ttotal += (await workspace.json(file)).n;\n}\n\nconsole.log(\"files\", files.length);\n\nreturn { files, total };");

	assert.deepEqual(counted.value, { "files": ["scripted/a.json", "scripted/b.json"], "total": 5 }, JSON.stringify(counted));
	assert.deepEqual(counted.logs, ["files 2"]);
	assert.deepEqual([counted.touched.read, counted.touched.globs, counted.touched.refused], [["scripted/a.json", "scripted/b.json"], ["scripted/*.json"], []]);

	const fetched = await run("try {\n\tawait fetch(\"https://example.com/\");\n} catch (error) {\n\treturn error.message;\n}");

	assert.match(fetched.value, /capability 'net:\*' is not available/u, JSON.stringify(fetched));
	assert.deepEqual(fetched.touched.refused, ["net:*"]);
	assert.match((await run("return require(\"node:fs\");")).error, /no require/u);
	assert.match((await run("return workspace.read(\"/etc/hosts\");")).error, /outside the workspace/u);
	assert.match((await run("for (;;) {}", 1000)).error, /timed out after 1000 ms/u);
	assert.equal((await run("return 1 + 1;")).value, 2, "a realm again after one was stopped");
	await ask("files.delete", { "path": "scripted" });
});
