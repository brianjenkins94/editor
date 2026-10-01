/**
 * A context's records reach whoever collects them even when it logs before its link's interest has arrived (a worker
 * logging as it starts): held until someone listens, then sent in order.
 */
import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";
import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { installHubCollector, relayLoggerToHub } from "../src/index.ts";

async function flush(): Promise<void> {
	for (let round = 0; round < 5; round += 1) {
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	}
}

test("records logged before anyone listens are held, and sent in order once someone does", async () => {
	const worker = createHub({ "id": "worker" });
	const log = relayLoggerToHub(worker, "worker");

	log.info("first");
	log.info("second");

	const root = createHub({ "id": "root" });
	const records: LogRecord[] = [];
	const [up, down] = pipe();

	installHubCollector(root, (record) => { records.push(record); });
	await Promise.all([root.link(up).ready, worker.link(down).ready]);
	await flush();
	log.info("third");
	await flush();

	assert.deepEqual(records.map((record) => record.message).filter((message) => ["first", "second", "third"].includes(String(message))), ["first", "second", "third"]);
});
