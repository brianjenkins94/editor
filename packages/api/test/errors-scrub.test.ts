/**
 * What an error report keeps (src/errors.ts): secrets and addresses scrubbed from its message and stack, and a
 * fingerprint that ignores line numbers but not functions. Pure, so it runs anywhere — in the editor's debugger too;
 * errors.test.ts tests error ids, grouping and alerts in workerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fingerprintOf, scrub, scrubStack } from "../src/errors.ts";

test("scrubbing keeps secrets and addresses out; a fingerprint ignores line numbers but not functions", async () => {
	assert.equal(scrub("no account for someone@example.com, token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", 500), "no account for «email», token «redacted»");

	// A stack's frame locations are kept, so they can be mapped: a hashed chunk's name isn't a token, a scoped
	// package's path isn't an address, and a query is dropped. What's between them is scrubbed as a message is.
	assert.equal(scrubStack("Error: for someone@example.com\n    at r (https://editor.unusuallygood.dev/assets/index-CDt7ol2B.js:1:11797)\n    at https://localhost:5173/node_modules/.vite/deps/@brianjenkins94_hub.js?v=1a2b3c4d:1113:13\n    at ghp_abcdefghijklmnopqrstuvwxyz0123456789AB (worker.js:1:1)\n    @https://editor.unusuallygood.dev/__vscode__/assets/editor.worker-it7rT9B4.js:12:67730", 4000), "Error: for «email»\n    at r (https://editor.unusuallygood.dev/assets/index-CDt7ol2B.js:1:11797)\n    at https://localhost:5173/node_modules/.vite/deps/@brianjenkins94_hub.js:1113:13\n    at «redacted» (worker.js:1:1)\n    @https://editor.unusuallygood.dev/__vscode__/assets/editor.worker-it7rT9B4.js:12:67730");

	const stack = (line: number): string => `TypeError: x\n    at accountEndpoint (worker.js:${line}:10)\n    at async dispatch (worker.js:${line + 5}:3)`;

	assert.equal(await fingerprintOf("api", "TypeError", stack(100), "GET /account"), await fingerprintOf("api", "TypeError", stack(900), "GET /account"));
	assert.notEqual(await fingerprintOf("api", "TypeError", stack(100), "GET /account"), await fingerprintOf("api", "TypeError", "TypeError: x\n    at otherEndpoint (worker.js:1:1)", "GET /account"));
	// With no stack, the message tells two errors from one place apart (2026-11-26: a ResizeObserver notice was grouped
	// with "Missing method $init", both stackless from the workbench); its numbers don't.
	assert.notEqual(await fingerprintOf("editor", "Error", undefined, "editor workbench", "ResizeObserver loop completed with undelivered notifications."), await fingerprintOf("editor", "Error", undefined, "editor workbench", "Missing method $init on worker thread channel default"));
	assert.equal(await fingerprintOf("editor", "Error", undefined, "editor workbench", "took 12 ms"), await fingerprintOf("editor", "Error", undefined, "editor workbench", "took 340 ms"));
});
