/**
 * observe() / observeApp(): one call per context, one at the top — a child's logs and architecture reach the app's
 * root, which keeps them.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import type { ArchReport } from "../src/index.ts";
import { collectArchReports, linkDebugMcp, observe, observeApp, scopedTransport } from "../src/index.ts";
import { until } from "./until.ts";

test("a context's logs and architecture reach its app's root, under the name the edge gives it", async (t) => {
	const [up, down] = pipe();
	const root = createHub({ "id": "page" });
	const worker = createHub({ "id": "placeholder" });
	const app = observeApp(root, { "keep": 2 });
	const child = observe(worker);

	t.after(() => {
		child.dispose();
		app.dispose();
	});
	await Promise.all([root.link(scopedTransport(up, "client-0", { "keep": (id) => id === "page" }), { "peer": "client-0" }).ready, worker.link(down, { "uplink": true }).ready]);
	child.log.info("one");
	child.log.info("two");
	child.log.info("three");
	await until("the newest records, and the context's node", () => app.records.some((record) => record.message === "three") && app.store.nodes.get("client-0")?.state === "alive");

	assert.deepEqual(app.records.map((record) => [record.context?.["source"], record.message]), [["client-0", "two"], ["client-0", "three"]], "the newest `keep`, tagged by source");
	assert.equal(app.store.nodes.get("client-0")?.state, "alive", "named by the edge, not by its hub's own id");
	assert.equal(app.store.nodes.has("placeholder"), false);
	assert.equal(app.tab, undefined, "debugging is off outside localhost / ?debug");
});

/** A page at `hostname` whose every WebSocket fails to connect, as with no debug-mcp running: the URLs it tried. */
function pageWithoutDebugMcp(t: { "after": (fn: () => void) => void }, hostname: string): string[] {
	const tried: string[] = [];
	const globals = globalThis as { "location"?: unknown; "WebSocket"?: unknown };
	const saved = { "location": globals.location, "WebSocket": globals.WebSocket };

	globals.location = { "hostname": hostname, "search": "" };
	globals.WebSocket = class extends EventTarget {
		public constructor(url: string) {
			super();
			tried.push(url);
			queueMicrotask(() => {
				this.dispatchEvent(new Event("error"));
				this.dispatchEvent(new Event("close"));
			});
		}

		public close(): void { /* never opened */ }
	};
	t.after(() => {
		globals.location = saved.location;
		globals.WebSocket = saved.WebSocket;
	});

	return tried;
}

test("debug-mcp: one quiet attempt by default; `retryMs` keeps trying; `false` tries none", async (t) => {
	const tried = pageWithoutDebugMcp(t, "[::1]");

	const stop = linkDebugMcp(createHub({ "id": "once" }));

	await until("the one attempt", () => tried.length === 1);
	await new Promise((resolve) => { setTimeout(resolve, 50); });
	stop();
	assert.deepEqual(tried, ["ws://localhost:7378"], "an IPv6 localhost page links, once");

	tried.length = 0;
	const retrying = observeApp(createHub({ "id": "retrying" }), { "debugMcp": { "url": "ws://localhost:9999", "retryMs": 5 } });

	await until("attempts after the first", () => tried.length >= 3);
	retrying.dispose();
	assert.ok(tried.every((url) => url === "ws://localhost:9999"), "at the URL it was given");

	const stopped = tried.length;
	const app = observeApp(createHub({ "id": "none" }), { "debugMcp": false });

	await new Promise((resolve) => { setTimeout(resolve, 50); });
	app.dispose();
	assert.equal(tried.length, stopped, "disposing stops the retrying, and `false` tries none");
});

test("a multi-homed leaf named by its uplink: its edge keeps the other tree's name in every report, not only the one with its topology", async (t) => {
	// A game's client worker: its hub calls itself `client`, the referee (its uplink) names it `player-0`, and its
	// instance page is the edge its reports reach the tab through.
	const referee = createHub({ "id": "referee" });
	const client = createHub({ "id": "client" });
	const instance = createHub({ "id": "player-0/ui" });
	const reports: ArchReport[] = [];
	const [r1, r2] = pipe();
	const [i1, i2] = pipe();

	collectArchReports(instance, (report) => { reports.push(report); });

	const child = observe(client);

	t.after(() => { child.dispose(); });
	referee.subscribe("game.commands", () => undefined);
	referee.link(r1, { "peer": "player-0" });
	client.link(r2, { "uplink": true, "transit": false });
	client.link(i2, { "transit": false });
	instance.link(scopedTransport(i1, "player-0", { "keep": (id) => id === "player-0/ui" }), { "peer": "player-0" });
	await until("the client's topology", () => reports.some((report) => report.reporter === "player-0" && report.topology !== undefined));
	// Then traffic only: a later report carries no topology.
	await client.whenInterested("game.commands", 1000);
	client.publish("game.commands", { "move": 1 });
	await until("a report of its traffic to the referee", () => reports.some((report) => report.topology === undefined && (report.traffic ?? []).length > 0));

	const ids = reports.flatMap((report) => [...report.topology?.links.map((link) => link.peerId) ?? [], ...(report.traffic ?? []).flatMap((count) => [count.from, count.to])]);

	assert.ok(ids.includes("referee"), "the referee by its own name");
	assert.ok(!ids.includes("player-0/referee"), "never as if it were under the client");
});
