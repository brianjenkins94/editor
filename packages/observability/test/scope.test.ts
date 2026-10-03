/**
 * Two windows of one app joining a viewer's tree: both call their page hub `page`, so without scoping their reports
 * and records would merge. The joining hub scopes each window's observability as it arrives.
 */
import type { Transport } from "@brianjenkins94/hub";
import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";

import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules.
import { createHub, pipe } from "../../hub/src/index.ts";
import { ArchitectureStore } from "../src/arch-store.ts";
import { collectArchReports, createArchReporter, requestArchSync } from "../src/arch.ts";
import { installHubCollector, LOG_BACKLOG } from "../src/index.ts";
import { scopeArchReport, scopedId, scopedTransport, scopeObservability, scopeOf } from "../src/scope.ts";
import { until } from "./until.ts";

test("two windows of one app keep apart in the viewer: each window's page IS its window, its other hubs under it", async (t) => {
	const shell = createHub({ "id": "shell" });
	const store = new ArchitectureStore();
	const records: LogRecord[] = [];
	const reporters = [createArchReporter(shell)];
	const workers: [ReturnType<typeof createHub>, string][] = [];

	t.after(() => {
		for (const reporter of reporters) {
			reporter.dispose();
		}
	});

	collectArchReports(shell, (report) => { store.apply(report); });
	installHubCollector(shell, (record) => { records.push(record); });

	for (const scope of ["preview:5173", "preview:5173~2"]) {
		// One window: its page, and a worker under it — the same ids in both.
		const page = createHub({ "id": "page" });
		const worker = createHub({ "id": "worker" });
		const [toShell, fromPage] = pipe({ "lossy": true });
		const [toWorker, fromWorker] = pipe({ "lossy": true });

		shell.link(scopedTransport(fromPage, scope, { "keep": (id) => id === "shell" }), { "peer": scope, "transit": false });
		page.link(toShell);
		page.link(toWorker);
		worker.link(fromWorker);
		reporters.push(createArchReporter(page), createArchReporter(worker));
		workers.push([worker, scope]);
	}

	await until("the shell's interest at each window's worker", () => workers.every(([worker]) => worker.interested("$sys.log.worker") && worker.interested("$sys.arch.worker")));

	// (Published as relayLoggerToHub would: its logger is one per realm, and this process holds both windows.)
	for (const [worker, scope] of workers) {
		worker.publish("$sys.log.worker", { "kind": "log", "level": "info", "message": "hello from " + scope, "context": { "source": "worker" }, "time": Date.now(), "depth": 0 });
	}

	requestArchSync(shell);

	const hellos = () => records.filter((record) => record.message.startsWith("hello"));
	const topology = () => Object.keys((store.snapshot() as { "topology": Record<string, unknown> }).topology);

	await until("both windows' hellos and all five hubs' topologies", () => hellos().length >= 2 && topology().length >= 5);

	const snapshot = store.snapshot() as { "topology": Record<string, { "links": { "peerId"?: string }[] }>; "channels": { "a": string; "b": string }[] };

	assert.deepEqual(Object.keys(snapshot.topology).sort(), ["preview:5173", "preview:5173/worker", "preview:5173~2", "preview:5173~2/worker", "shell"]);
	assert.deepEqual(snapshot.topology["preview:5173~2"]!.links.map((link) => link.peerId).sort(), ["preview:5173~2/worker", "shell"], "the exit to the shell keeps its name");

	const linked = (a: string, b: string) => snapshot.channels.some((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));

	assert.ok(linked("preview:5173", "preview:5173/worker") && linked("preview:5173~2", "preview:5173~2/worker"), JSON.stringify(snapshot.channels));
	assert.ok(linked("shell", "preview:5173") && linked("shell", "preview:5173~2"), "the shell's own view of each link, and the page's, are one channel");
	assert.ok(!linked("preview:5173", "preview:5173~2/worker"), "and never across windows");
	assert.deepEqual(records.filter((record) => record.message.startsWith("hello")).map((record) => [record.context?.["source"], record.message]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))), [["preview:5173/worker", "hello from preview:5173"], ["preview:5173~2/worker", "hello from preview:5173~2"]]);

});

test("the edge names a metrics sample — its subject and its own source — and nothing passes as outside the scope", () => {
	const sample = (source: string) => ({ "source": source, "t": 1, "values": { "fps": 60 } });
	const scoped = (subject: string, data: unknown) => scopeObservability({ "subject": subject, "data": data }, "preview:5180", () => false, "page") as { "subject": string; "data": { "source": string } };

	// The page across the link is the scope itself; what's behind it, under it.
	assert.deepEqual(scoped("$sys.metrics.page", sample("page")), { "subject": "$sys.metrics.preview:5180", "data": { "source": "preview:5180", "t": 1, "values": { "fps": 60 } } });
	assert.equal(scoped("$sys.metrics.client-0", sample("client-0")).data.source, "preview:5180/client-0");
	// A sample claiming to be the editor's is the app's all the same — by subject and by the source inside it.
	assert.deepEqual([scoped("$sys.metrics.workbench", sample("workbench")).subject, scoped("$sys.metrics.page", sample("workbench")).data.source], ["$sys.metrics.preview:5180/workbench", "preview:5180"]);
});

test("the edge renames every app id in a report — reporter, topology, node ops, traffic, samples — and nothing of the joining side", () => {
	const report = scopeArchReport({
		"reporter": "page",
		"time": 1,
		"topology": { "id": "page", "subscriptions": [], "links": [{ "id": "link-1", "peerId": "shell", "remoteInterest": [], "advertised": [] }, { "id": "link-2", "peerId": "worker", "remoteInterest": [], "advertised": [] }, { "id": "link-3", "remoteInterest": [], "advertised": [] }] },
		"nodes": [{ "op": "spawn", "spec": { "id": "worker:game", "container": "workers" } }, { "op": "terminate", "id": "nested:frame" }, { "op": "state", "id": "page:link-3", "state": "terminated" }],
		"traffic": [{ "from": "page", "to": "shell", "kind": "message", "label": "$sys.log.page", "count": 1, "bytes": 10, "via": "hub" }],
		"samples": [{ "t": 1, "from": "worker", "to": "page", "kind": "message", "label": "x", "bytes": 1 }]
	}, "preview:5173~2", (id) => id === "shell", "page");

	assert.equal(report.reporter, "preview:5173~2", "the hub across the link is the scope itself");
	assert.deepEqual(report.topology!.links.map((link) => link.peerId), ["shell", "preview:5173~2/worker", undefined]);
	assert.deepEqual(report.nodes, [{ "op": "spawn", "spec": { "id": "preview:5173~2/worker:game", "container": "workers" } }, { "op": "terminate", "id": "preview:5173~2/nested:frame" }, { "op": "state", "id": "preview:5173~2/page:link-3", "state": "terminated" }]);
	assert.deepEqual([report.traffic![0]!.from, report.traffic![0]!.to], ["preview:5173~2", "shell"]);
	assert.deepEqual([report.samples![0]!.from, report.samples![0]!.to], ["preview:5173~2/worker", "preview:5173~2"]);
	// Once: what's already under the scope (it crossed two joins) isn't scoped twice.
	assert.equal(scopeArchReport({ "reporter": "preview:5173~2/worker", "time": 1 }, "preview:5173~2").reporter, "preview:5173~2/worker");
	// Without `keep`, nothing of the joining side is spared.
	assert.equal(scopeArchReport({ "reporter": "page", "time": 1, "traffic": [{ "from": "page", "to": "shell", "kind": "message", "label": "x", "count": 1, "bytes": 1 }] }, "preview:5173~2").traffic![0]!.to, "preview:5173~2/shell");
});

test("frames: reports and records are scoped, subject and all; a backlog's records too; anything else passes as it is", () => {
	const scope = "preview:5173";

	assert.deepEqual(scopeObservability({ "subject": "$sys.arch.page", "data": { "reporter": "page", "time": 1 } }, scope), { "subject": "$sys.arch.preview:5173/page", "data": { "reporter": "preview:5173/page", "time": 1 } });
	assert.deepEqual(scopeObservability({ "subject": "$sys.log.client-0", "from": "x", "data": { "message": "m", "context": { "source": "client-0", "tab": "t" } } }, scope), { "subject": "$sys.log.preview:5173/client-0", "from": "x", "data": { "message": "m", "context": { "source": "preview:5173/client-0", "tab": "t" } } });
	assert.deepEqual(scopeObservability({ "subject": LOG_BACKLOG, "data": [{ "context": { "source": "page" } }, { "message": "no context" }] }, scope), { "subject": LOG_BACKLOG, "data": [{ "context": { "source": "preview:5173/page" } }, { "message": "no context" }] });
	// Not a report (a hostile peer's junk): renamed by subject, never thrown on.
	assert.deepEqual(scopeObservability({ "subject": "$sys.arch.referee", "data": {} }, scope), { "subject": "$sys.arch.preview:5173/referee", "data": {} });
	// The hub across the link (its hello said `page`) is the scope itself.
	assert.deepEqual(scopeObservability({ "subject": "$sys.log.page", "data": { "context": { "source": "page" } } }, scope, undefined, "page"), { "subject": "$sys.log.preview:5173", "data": { "context": { "source": "preview:5173" } } });
	assert.deepEqual(scopeObservability({ "subject": "$sys.arch.page", "data": { "reporter": "page", "time": 1 } }, scope, undefined, "page"), { "subject": "$sys.arch.preview:5173", "data": { "reporter": "preview:5173", "time": 1 } });

	for (const frame of [{ "subject": "$sys.arch.sync" }, { "subject": "$rpc.reply.debug-mcp", "data": { "id": "1" } }, { "subject": "tab.here", "data": {} }, { "hub": "sub", "subject": "$sys.arch.sync" }, { "hub": "sub", "subject": "$sys.arch.>" }, { "hub": "unsub", "subject": "$sys.log.>" }, { "hub": "hello", "id": "page" }, "text", undefined]) {
		assert.deepEqual(scopeObservability(frame, scope), frame);
	}
});

test("scopedId and scopeOf", () => {
	assert.equal(scopedId("preview:5173~2", "page"), "preview:5173~2/page");
	assert.equal(scopedId("preview:5173~2", "preview:5173~2/page"), "preview:5173~2/page");
	assert.equal(scopedId("player-0", "player-0"), "player-0", "a hub that names itself as its scope is the scope, not under it");
	assert.equal(scopeOf("preview:5173~2/client-0.ui"), "preview:5173~2");
	assert.equal(scopeOf("preview:5173"), undefined);
});

test("an app hub that calls itself `shell` is still the app's — reports and records — while its link to the editor's shell keeps the name", () => {
	const report = scopeArchReport({
		"reporter": "shell",
		"time": 1,
		"ended": true,
		"topology": { "id": "shell", "subscriptions": [], "links": [{ "id": "link-1", "peerId": "shell", "remoteInterest": [], "advertised": [] }] },
		"traffic": [{ "from": "shell", "to": "shell", "kind": "message", "label": "x", "count": 1, "bytes": 1 }]
	}, "preview:5173", (id) => id === "shell");

	assert.equal(report.reporter, "preview:5173/shell");
	assert.equal(report.topology!.id, "preview:5173/shell");
	assert.equal(report.topology!.links[0]!.peerId, "preview:5173/shell", "an id equal to the reporter is the reporter");
	assert.deepEqual(scopeObservability({ "subject": "$sys.log.shell", "data": { "context": { "source": "shell" } } }, "preview:5173", (id) => id === "shell"), { "subject": "$sys.log.preview:5173/shell", "data": { "context": { "source": "preview:5173/shell" } } });
	assert.deepEqual(scopeObservability({ "subject": "$sys.arch.shell", "data": { "reporter": "shell", "time": 1, "ended": true } }, "preview:5173", (id) => id === "shell"), { "subject": "$sys.arch.preview:5173/shell", "data": { "reporter": "preview:5173/shell", "time": 1, "ended": true } });
});

test("what the peer reaches over its uplinks is above it, not under the edge: a multi-homed leaf's other tree keeps its name", () => {
	// A game's client worker: named by both its links (it calls itself `client`), its uplink the referee's — another tree.
	const link = (id: string, peerId: string, uplink?: true) => ({ "id": id, "peerId": peerId, "remoteInterest": [], "advertised": [], ...uplink ? { "uplink": uplink } : {} });
	const client = scopeArchReport({
		"reporter": "client",
		"time": 1,
		"ended": false,
		"topology": { "id": "client", "subscriptions": [], "links": [link("link-1", "referee", true), link("link-2", "player-0/ui")] },
		"traffic": [{ "from": "referee", "to": "client", "kind": "message", "label": "game.state", "count": 1, "bytes": 1 }]
	}, "player-0", (id) => id === "player-0/ui", "client");

	assert.equal(client.reporter, "player-0", "the peer is the scope");
	assert.deepEqual(client.topology!.links.map((each) => each.peerId), ["referee", "player-0/ui"], "its uplink keeps its name, with no `keep` for it");
	assert.deepEqual(client.traffic!.map((count) => [count.from, count.to]), [["referee", "player-0"]]);

	// A hub behind the peer: its uplink is the peer — under the edge, so named by it.
	const behind = scopeArchReport({
		"reporter": "helper",
		"time": 1,
		"ended": false,
		"topology": { "id": "helper", "subscriptions": [], "links": [link("link-1", "client", true)] }
	}, "player-0", () => false, "client");

	assert.equal(behind.reporter, "player-0/helper");
	assert.equal(behind.topology!.links[0]!.peerId, "player-0", "the peer, as the edge names it");
});
