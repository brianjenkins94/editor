import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub } from "@brianjenkins94/hub";
import { isCancellation, LOG_SUBJECT, tapConsoleAndErrors } from "../src/index.ts";

/** Stand in a browser global's error events: Node's globalThis has no addEventListener. */
function withGlobalEvents(run: (reject: (reason: unknown) => void) => void): void {
	const target = new EventTarget();
	const global = globalThis as Record<string, unknown>;

	global.addEventListener = target.addEventListener.bind(target);
	global.removeEventListener = target.removeEventListener.bind(target);

	try {
		run((reason) => { target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { "reason": reason })); });
	} finally {
		delete global.addEventListener;
		delete global.removeEventListener;
	}
}

function cancellation(): Error {
	const error = new Error("Canceled");

	error.name = "Canceled";

	return error;
}

test("an unhandled rejection is published, unless it's only a cancellation", () => {
	const hub = createHub({ "id": "page" });
	const seen: string[] = [];

	hub.subscribe(LOG_SUBJECT + ".>", (data) => { seen.push((data as LogRecord).message); });

	withGlobalEvents((reject) => {
		const dispose = tapConsoleAndErrors(hub, "page");

		reject(new Error("boom"));
		reject(cancellation());
		reject(new DOMException("The operation was aborted.", "AbortError"));
		dispose();
	});

	assert.deepEqual(seen, ["unhandledrejection: boom"]);
});

test("a cancellation is VS Code's CancellationError or the platform's AbortError, nothing that merely says so", () => {
	assert.equal(isCancellation(cancellation()), true);
	assert.equal(isCancellation(new DOMException("aborted", "AbortError")), true);
	assert.equal(isCancellation(new Error("Canceled")), false);
	assert.equal(isCancellation("Canceled"), false);
	assert.equal(isCancellation(undefined), false);
});
