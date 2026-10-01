/**
 * observe() / observeApp(): one call per context, one at the top — a child's logs and architecture reach the app's
 * root, which keeps them.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { observe, observeApp } from "../src/index.ts";

test("a context's logs and architecture reach its app's root, under the name its link knows it by", async () => {
	const [up, down] = pipe();
	const root = createHub({ "id": "page" });
	const worker = createHub({ "id": "placeholder" });
	const app = observeApp(root, { "keep": 2 });
	const child = observe(worker, { "source": "client-0" });

	await Promise.all([root.link(up, { "peer": "client-0" }).ready, worker.link(down, { "uplink": true }).ready]);
	child.log.info("one");
	child.log.info("two");
	child.log.info("three");
	await new Promise((resolve) => { setTimeout(resolve, 400); });

	assert.deepEqual(app.records.map((record) => [record.context?.["source"], record.message]), [["client-0", "two"], ["client-0", "three"]], "the newest `keep`, tagged by source");
	assert.equal(app.store.nodes.get("client-0")?.state, "alive", "it reports as its source, not its hub's own id");
	assert.equal(app.store.nodes.has("placeholder"), false);
	assert.equal(app.tab, undefined, "debugging is off outside localhost / ?debug");
	child.dispose();
	app.dispose();
});
