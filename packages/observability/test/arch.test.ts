import type { Transport } from "@brianjenkins94/hub";
import type { ArchReport } from "../src/arch.ts";
import * as assert from "node:assert/strict";

import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules (arch.ts only imports hub TYPES).
import { createHub, createRpcClient, pipe, serve } from "../../hub/src/index.ts";
import { ArchitectureStore } from "../src/arch-store.ts";
import { collectArchReports, createArchReporter, normalizeSubject, requestArchSync } from "../src/arch.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** root ⇄ pod, each with a reporter; the collector sits on root. */
async function setup() {
	const [a, b] = pipe({ "lossy": true });
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const reporters = [createArchReporter(root), createArchReporter(pod)];
	const reports: ArchReport[] = [];

	root.link(a);
	pod.link(b);
	collectArchReports(root, (report) => { reports.push(report); });
	await wait(20);

	return { "root": root, "pod": pod, "reports": reports, "dispose": () => { reporters.forEach((reporter) => { reporter.dispose(); }); } };
}

function trafficOf(reports: ArchReport[], reporter: string) {
	return reports.filter((report) => report.reporter === reporter).flatMap((report) => report.traffic ?? []);
}

test("each hub reports its topology, peers included", async () => {
	const { reports, dispose } = await setup();

	await wait(300);

	const podTopology = reports.find((report) => report.reporter === "pod" && report.topology !== undefined)?.topology;

	assert.equal(podTopology?.links[0]?.peerId, "root");
	dispose();
});

test("traffic is counted once, by the sender, with RPC labelled by method", async () => {
	const { root, pod, reports, dispose } = await setup();

	serve(pod, "git.status", () => "clean");
	await wait(20);
	assert.equal(await createRpcClient(root).request("git.status"), "clean");
	pod.subscribe("node.out.>", () => undefined);
	await wait(20);
	root.publish("node.out.42", "x");
	root.publish("node.out.43", "y");
	await wait(300);

	const fromRoot = trafficOf(reports, "root");
	const fromPod = trafficOf(reports, "pod");

	assert.ok(fromRoot.some((count) => count.to === "pod" && count.kind === "request" && count.label === "git.status()"));
	assert.ok(fromPod.some((count) => count.to === "root" && count.kind === "reply" && count.label === "↩ git.status()"));
	// ids in subjects are folded, so each run doesn't make a new label
	assert.equal(fromRoot.find((count) => count.label === "node.out.*")?.count, 2);
	// the reports themselves are never counted
	assert.ok(![...fromRoot, ...fromPod].some((count) => count.label.startsWith("$sys.arch")));
	dispose();
});

test("probe-fed nodes and channels, and a full-state answer to sync", async () => {
	const [a, b] = pipe({ "lossy": true });
	const root = createHub({ "id": "root" });
	const workbench = createHub({ "id": "workbench" });
	const reporter = createArchReporter(workbench);

	root.link(a);
	workbench.link(b);
	reporter.spawn({ "id": "worker:TextMateWorker" });
	reporter.record("workbench", "worker:TextMateWorker", "request", "$acceptNewModel", 10);
	reporter.record("workbench", "worker:TextMateWorker", "request", "$acceptNewModel", 5);
	await wait(300);

	const late: ArchReport[] = [];

	collectArchReports(root, (report) => { late.push(report); }); // a viewer opened after the fact
	await wait(20);
	requestArchSync(root);
	await wait(50);

	const full = late.find((report) => report.reporter === "workbench" && report.full === true);

	assert.ok(full !== undefined);
	assert.deepEqual(full.nodes, [{ "op": "spawn", "spec": { "id": "worker:TextMateWorker" } }]);
	assert.deepEqual(full.traffic?.find((count) => count.to === "worker:TextMateWorker"), { "from": "workbench", "to": "worker:TextMateWorker", "kind": "request", "label": "$acceptNewModel", "count": 2, "bytes": 15 });
	reporter.dispose();
});

test("a store opened mid-stream converges on the true counts — nothing counted twice", async () => {
	const [a, b] = pipe({ "lossy": true });
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const reporter = createArchReporter(pod);

	root.link(a);
	pod.link(b);
	root.subscribe("git.changed", () => undefined);
	await wait(20);

	for (let index = 0; index < 5; index += 1) {
		pod.publish("git.changed");
	}

	await wait(300); // flushed to nobody (no viewer yet)

	pod.publish("git.changed"); // pending when the viewer syncs

	const store = new ArchitectureStore();

	collectArchReports(root, (report) => { store.apply(report); });
	await wait(5);
	requestArchSync(root);
	await wait(100);

	pod.publish("git.changed"); // after the sync: a delta
	await wait(300);

	const { channel } = store.channel("pod", "root");

	assert.equal(channel.labels.get("git.changed")?.count, 7);
	assert.equal(channel.linked, true); // the topology says they're linked
	assert.ok(channel.interest["pod"]?.includes("git.changed")); // and what root asked pod for
	assert.ok(store.log.some((sample) => sample.label === "git.changed"));
	reporter.dispose();
});

test("traffic sent before the peer's hello is still attributed to the peer, never to a placeholder", async () => {
	// A window-like transport: messages to a side that isn't listening yet are DROPPED.
	let left: ((message: unknown) => void) | undefined;
	let right: ((message: unknown) => void) | undefined;
	const a: Transport = { "send": (message) => {
		const to = right;

		if (to !== undefined) { setTimeout(to, 0, message); }
	}, "listen": (onMessage) => {
		left = onMessage;

		return () => { left = undefined; };
	} };
	const b: Transport = { "send": (message) => {
		const to = left;

		if (to !== undefined) { setTimeout(to, 0, message); }
	}, "listen": (onMessage) => {
		right = onMessage;

		return () => { right = undefined; };
	} };
	const root = createHub({ "id": "root" });
	const workbench = createHub({ "id": "workbench" });
	const reporter = createArchReporter(root);
	const store = new ArchitectureStore();

	collectArchReports(root, (report) => { store.apply(report); });
	root.link(a); // nobody listening yet: root's hello is lost, it doesn't know its peer
	await wait(20);
	workbench.link(b); // workbench's hello reaches root, root's reply reaches workbench
	await wait(400);

	assert.ok(![...store.nodes.keys()].some((id) => id.startsWith("root:link")), [...store.nodes.keys()].join(","));
	assert.ok(store.channels.has("root|workbench"));
	assert.ok((store.channels.get("root|workbench")?.labels.get("hello")?.hub ?? 0) > 0);
	reporter.dispose();
});

test("a peer that boots slowly is named once it says hello; a link nothing answers is in the topology, with no channel", async () => {
	const [a, b] = pipe({ "lossy": true });
	const root = createHub({ "id": "root" });
	const reporter = createArchReporter(root);
	const store = new ArchitectureStore();

	collectArchReports(root, (report) => { store.apply(report); });
	root.link(a); // traffic starts flowing (interest, hello) long before the peer is up
	root.subscribe("anything", () => undefined);
	await wait(700); // several flushes while the peer is still booting

	const late = createHub({ "id": "workbench" });

	late.link(b);
	await wait(400);
	assert.ok(![...store.nodes.keys()].some((id) => id.includes(":link")), [...store.nodes.keys()].join(","));
	// What root sent before the peer said who it is (its hello, its interest) was held, and counted once it did.
	assert.ok(store.channels.get("root|workbench")?.labels.has("hello"), [...store.channels.get("root|workbench")?.labels.keys() ?? []].join(","));

	// Something that receives and never answers (an outdated service worker): no peer to draw a channel to.
	const [c, d] = pipe({ "lossy": true });
	const second = root.link(c);

	d.listen(() => undefined);
	await wait(400);
	assert.equal(store.topology.get("root")?.links.filter((link) => link.peerId === undefined).length, 1);
	assert.deepEqual([...store.channels.keys()].filter((key) => key.startsWith("root|")), ["root|workbench"]);
	second();
	reporter.dispose();
});

test("a short-lived peer that says hello and is gone before the next flush is still named, never left as a placeholder", async () => {
	const [a, b] = pipe({ "lossy": true });
	const node = createHub({ "id": "node" });
	const reporter = createArchReporter(node);
	const store = new ArchitectureStore();

	collectArchReports(node, (report) => { store.apply(report); });
	await wait(20);

	// A throwaway child worker: linked, one round of traffic, unlinked — all well inside one flush interval.
	const child = createHub({ "id": "provoke" });
	const unlinkNode = node.link(a); // node's hello + interest go out before the child is known

	child.link(b);
	serve(child, "provoke.round", () => ({ "failures": [] }));
	await wait(20);
	await createRpcClient(node).request("provoke.round", {}, { "timeoutMs": 1000 });
	unlinkNode();
	await wait(400);

	assert.ok(![...store.nodes.keys()].some((id) => id.startsWith("node:link")), [...store.nodes.keys()].join(","));
	assert.ok(store.channels.has("node|provoke"));
	reporter.dispose();
});

test("ids in subjects and RPC names collapse to *, words don't", () => {
	assert.equal(normalizeSubject("node.out.k3j2h1g5f4d3s2a1"), "node.out.*");
	assert.equal(normalizeSubject("debug.session.ebc89798-1504-4c3b-8191-25576a8ab225.control"), "debug.session.*.control");
	assert.equal(normalizeSubject("preview.hmr.5173"), "preview.hmr.*");
	assert.equal(normalizeSubject("virtual.request.3f9a1c2e"), "virtual.request.*");
	assert.equal(normalizeSubject("$sys.log.capabilities"), "$sys.log.capabilities");
	assert.equal(normalizeSubject("workbench.openProject"), "workbench.openProject");
});

test("an RPC whose name carries an id is labelled once, not once per id — by the caller and by the server replying", async () => {
	const [a, b] = pipe({ "lossy": true });
	const caller = createHub({ "id": "caller" });
	const server = createHub({ "id": "server" });
	const reporters = [createArchReporter(caller), createArchReporter(server)];
	const store = new ArchitectureStore();

	collectArchReports(caller, (report) => { store.apply(report); });
	caller.link(a);
	server.link(b);

	const ids = ["ebc89798-1504-4c3b-8191-25576a8ab225", "3de96504-c2b4-4677-bf06-3ca5ea7105c7"];

	for (const id of ids) {
		serve(server, `debug.session.${id}.step`, () => ({ "state": "stopped" }));
	}

	await wait(20);

	const rpc = createRpcClient(caller);

	for (const id of ids) {
		await rpc.request(`debug.session.${id}.step`, {}, { "timeoutMs": 1000 });
	}

	await wait(400);

	const labels = [...(store.channels.get("caller|server")?.labels.keys() ?? [])].filter((label) => label.includes("debug.session")).sort();

	// The server learns the name from the call arriving, and labels its reply with it.
	assert.deepEqual(labels, ["debug.session.*.step()", "↩ debug.session.*.step()"]);
	reporters.forEach((reporter) => { reporter.dispose(); });
});

test("a report nobody could hear yet is held, not lost: the viewer that links later gets the traffic and topology", async () => {
	const frame = createHub({ "id": "frame" });
	const reporter = createArchReporter(frame);

	// Traffic before any viewer's interest can have reached this hub (a frame that's just started).
	reporter.record("frame", "worker", "request", "wired.echo()", 10);
	await wait(400);

	const [a, b] = pipe({ "lossy": true });
	const viewer = createHub({ "id": "viewer" });
	const reports: ArchReport[] = [];

	collectArchReports(viewer, (report) => { reports.push(report); });
	viewer.link(a);
	frame.link(b);
	await wait(600);

	const mine = reports.filter((report) => report.reporter === "frame");

	assert.ok(mine.some((report) => (report.traffic ?? []).some((count) => count.label === "wired.echo()" && count.count === 1)), "the traffic from before it had a listener: " + JSON.stringify(mine));
	assert.ok(mine.some((report) => report.topology?.links.some((link) => link.peerId === "viewer")), "and its topology");
	reporter.dispose();
});

test("a reporter can name itself by the id its link knows it by", async () => {
	const [a, b] = pipe({ "lossy": true });
	const edge = createHub({ "id": "edge" });
	const client = createHub({ "id": "client" });
	const reports: ArchReport[] = [];

	collectArchReports(edge, (report) => { reports.push(report); });
	edge.link(a, { "peer": "seat-2" });
	client.link(b, { "uplink": true });
	await wait(50);

	const reporter = createArchReporter(client, { "self": client.knownAs()[0] });

	await wait(400);
	assert.equal(reporter.self, "seat-2");
	assert.ok(reports.some((report) => report.reporter === "seat-2" && report.topology !== undefined), JSON.stringify(reports.map((report) => report.reporter)));
	reporter.dispose();
});
