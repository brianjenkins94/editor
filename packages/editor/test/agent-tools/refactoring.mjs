/**
 * Refactoring as an agent asks it (`code.references`, `code.rename`, `code.move`), as a person does it.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/refactoring.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("refactoring");
const { ask } = session;

test("refactoring, as a person does it: where a name's used, renamed everywhere, and a file moved with its imports kept right", async () => {
	await ask("files.write", { "path": "refactor/tsconfig.json", "content": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n" });
	await ask("files.write", { "path": "refactor/rate.mjs", "content": "export const rate = 2;\n" });
	await ask("files.write", { "path": "refactor/total.mjs", "content": "import { rate } from \"./rate.mjs\";\n\nexport const total = rate * 10;\n" });

	const used = await session.request("code.references", { "path": "refactor/rate.mjs", "line": 1, "name": "rate" }, 120_000);

	assert.deepEqual(used.places.map(({ file, line }) => `${file}:${String(line)}`).toSorted(), ["refactor/rate.mjs:1", "refactor/total.mjs:1", "refactor/total.mjs:3"]);

	const renamed = await session.request("code.rename", { "path": "refactor/rate.mjs", "line": 1, "name": "rate", "to": "price" }, 120_000);

	assert.deepEqual(renamed.files.toSorted(), ["refactor/rate.mjs", "refactor/total.mjs"]);
	assert.equal((await ask("files.read", { "path": "refactor/total.mjs" })).content.split("\n")[2], "3\texport const total = price * 10;");

	// Moved into a folder: its importer follows, and it's saved.
	const moved = await session.request("code.move", { "from": "refactor/rate.mjs", "to": "refactor/prices/rate.mjs" }, 120_000);

	assert.deepEqual(moved.updated, ["refactor/total.mjs"]);
	assert.match((await ask("files.read", { "path": "refactor/total.mjs" })).content, /from "\.\/prices\/rate\.mjs"/u);
	assert.equal((await ask("files.read", { "path": "refactor/total.mjs" })).dirty, false);
	await assert.rejects(session.request("code.move", { "from": "refactor/total.mjs", "to": "refactor/prices/rate.mjs" }, 30_000), /there already/u);
});
