/**
 * A first load, on a host that sends the isolation headers itself: the page doesn't reload under its service worker, so
 * the workbench waits for the worker before it opens — a frame opened first isn't the worker's, and every package it asks
 * the CDN for is a 404 (app/coi.ts `serviceWorkerActive`). The worker held back here, as a slow one would be.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/controlled.mjs
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("controlled");

test("on a first load the workbench opens under the service worker, however slow the worker is to come", async () => {
	const context = await session.page.context().browser().newContext();

	try {
		// (a developer's own debug-mcp kept out, as the harness does)
		await context.routeWebSocket(/:7378/u, (socket) => { socket.close(); });
		await context.addInitScript(() => {
			globalThis.__controlledAtStart = navigator.serviceWorker?.controller !== null;

			const register = navigator.serviceWorker?.register.bind(navigator.serviceWorker);

			if (register !== undefined) {
				navigator.serviceWorker.register = async (...args) => {
					await new Promise((resolve) => { setTimeout(resolve, 2000); });

					return register(...args);
				};
			}
		});

		const page = await context.newPage();

		await page.goto(new URL("/", session.page.url()).href);

		const workbench = await session.eventually("the workbench's frame", async () => page.frames().find((frame) => frame.url().includes("/__vscode__/host.html")), 60_000);

		assert.equal(await workbench.evaluate(() => globalThis.__controlledAtStart), true);
		await workbench.locator("[role=treeitem]").first().waitFor({ "timeout": 60_000 });
	} finally {
		await context.close();
	}
});
