/**
 * A first load, on a host that sends the isolation headers itself: the page doesn't reload under its service worker, so
 * the shell waits for the worker before it opens the app's frame, and the workbench's in it — one opened first isn't the
 * worker's: every package the workbench asks the CDN for is a 404, and a preview can't reach its server, whose link to the
 * worker is the app's (app/coi.ts `serviceWorkerActive`). The worker held back here, as a slow one would be.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/controlled.mjs
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("controlled");

test("on a first load the app and the workbench open under the service worker, however slow the worker is to come", async () => {
	const context = await session.page.context().browser().newContext();

	try {
		// (a developer's own debug-mcp kept out, as the harness does)
		await context.routeWebSocket(/:7378/u, (socket) => { socket.close(); });
		await context.addInitScript(() => {
			// (only the page's own: in a frame's first blank page, looking at navigator.serviceWorker makes one that stays)
			if (window !== window.top) {
				return;
			}

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

		// (its frame once it's the workbench's page: before that it's a blank one, nobody's)
		const workbench = await session.eventually("the workbench's frame", async () => {
			const found = page.frames().find((frame) => frame.url().includes("/__vscode__/host.html"));

			return await found?.evaluate(() => location.pathname.endsWith("/host.html")).catch(() => false) ? found : undefined;
		}, 60_000);

		// Each came through the worker.
		const throughWorker = () => performance.getEntriesByType("navigation")[0].workerStart > 0 && navigator.serviceWorker.controller !== null;

		assert.equal(await workbench.parentFrame().evaluate(throughWorker), true, "the app's frame");
		assert.equal(await workbench.evaluate(throughWorker), true, "the workbench's frame");
		await workbench.locator("[role=treeitem]").first().waitFor({ "timeout": 60_000 });
	} finally {
		await context.close();
	}
});
