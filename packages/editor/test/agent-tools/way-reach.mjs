/**
 * What a way in reaches (`code.reach`), as History: What a Way In Reaches… shows it.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/way-reach.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("way-reach");
const { ask } = session;

test("what a way in reaches, as History: What a Way In Reaches… shows it: where it's registered, what only it reaches, who names it", async () => {
	// (in the workspace's own TypeScript project, the one History reads: a folder of its own is another, nobody opened)
	await ask("files.write", { "path": "src/reached/hub.ts", "content": "export const hub = {};\n\nexport function serve(_hub: object, _name: string, handler: () => unknown): () => unknown {\n\treturn handler;\n}\n" });
	await ask("files.write", { "path": "src/reached/app.ts", "content": "import { hub, serve } from \"./hub\";\n\nfunction greet(): string {\n\treturn \"hello\";\n}\n\nserve(hub, \"demo.reached\", greet);\n" });
	await ask("files.write", { "path": "src/reached/caller.ts", "content": "export const asks = \"demo.reached\";\n" });

	// (History reads the program as its files change: asked until its reading has them all — the way in, and the file that
	// names it, written last: once, on CI, it had the first and not yet the other)
	let reach;

	for (let tries = 0; (reach?.way === undefined || (reach.named ?? []).length === 0) && tries < 30; tries += 1) {
		if (tries > 0) {
			await new Promise((resolve) => {
				setTimeout(resolve, 2000);
			});
		}

		reach = await session.request("code.reach", { "target": "hub request|demo.reached" }, 120_000);
	}

	try {
		assert.equal(reach.way?.key, "hub request|demo.reached", JSON.stringify(reach));
		assert.deepEqual(reach.registered.map(({ file, line }) => `${file}:${String(line)}`), ["src/reached/app.ts:7"]);
		assert.ok(reach.frees.declarations >= 1, JSON.stringify(reach.frees));
		assert.deepEqual(reach.named.map(({ file, line }) => `${file}:${String(line)}`), ["src/reached/caller.ts:1"]);
		assert.ok((await session.request("code.reach", { "target": "demo.reach" }, 120_000)).matches.includes("hub request|demo.reached"));
	} finally {
		await ask("files.delete", { "path": "src/reached" });
	}
});
