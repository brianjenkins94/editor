/**
 * A context's records reach whoever collects them even when it logs before its link's interest has arrived (a worker
 * logging as it starts): held until someone listens, then sent in order.
 */
import type { LogRecord } from "@brianjenkins94/util/logger";
import { sinks } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";
import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { CONSOLE_ECHO, consoleCollector, installHubCollector, relayLoggerToHub } from "../src/index.ts";

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

test("while a relayed record is echoed to the console, CONSOLE_ECHO says so — so a console tap can leave it to the hub", () => {
	const flag = (): unknown => (globalThis as Record<symbol, unknown>)[CONSOLE_ECHO];
	const seen: unknown[] = [];

	// A console sink (util's default prints each record): the relay marks what it prints as an echo.
	sinks.unshift(() => { seen.push(flag()); });

	const log = relayLoggerToHub(createHub({ "id": "echoed" }), "echoed");

	log.info("relayed, and echoed");
	assert.equal(seen.at(-1), true, "marked while the console sink prints it");
	assert.notEqual(flag(), true, "and only then");
	assert.equal(Symbol.for("@brianjenkins94/observability.consoleEcho"), CONSOLE_ECHO, "a registered symbol: a tap can name it without importing this");
});

test("the console collector prints a record from another realm that carries no attrs — it doesn't throw on it", () => {
	const printed: unknown[][] = [];
	const original = console.log;

	console.log = (...args: unknown[]) => { printed.push(args); };

	try {
		consoleCollector({ "kind": "log", "level": "info", "message": "from a tap", "context": { "source": "preview:5173" }, "time": 0, "depth": 0 } as unknown as LogRecord);
	} finally {
		console.log = original;
	}

	assert.equal(printed[0]?.[0], "[preview:5173] from a tap");
});

