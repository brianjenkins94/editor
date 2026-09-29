import type { Transport } from "@brianjenkins94/hub";
import type { ArchReport } from "../src/arch.ts";
import * as assert from "node:assert/strict";

import { test } from "node:test";
// From source: node won't strip types from the pnpm copy under node_modules (arch.ts only imports hub TYPES).
import { createHub, createRpcClient, serve } from "../../hub/src/index.ts";
import { ArchitectureStore } from "../src/arch-store.ts";
import { collectArchReports, createArchReporter, requestArchSync } from "../src/arch.ts";

function pipe(): [Transport, Transport] {
	let left: ((message: unknown) => void) | undefined;
	let right: ((message: unknown) => void) | undefined;

	return [
		{ "send": (message) => { setTimeout(() => { right?.(message); }, 0); },"listen": (onMessage) => {
				left = onMessage;

				return () => { left = undefined; };
			} },
		{ "send": (message) => { setTimeout(() => { left?.(message); }, 0); },"listen": (onMessage) => {
				right = onMessage;

				return () => { right = undefined; };
			} }
	];
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** root ⇄ pod, each with a reporter; the collector sits on root. */
async function setup() {
	const [a, b] = pipe();
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
	const [a, b] = pipe();
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
	const [a, b] = pipe();
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

test("a peer that boots slowly is still named; an older hub (hello without id) is anonymous", async () => {
	const [a, b] = pipe();
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
	assert.ok(store.channels.has("root|workbench"));

	// An older hub: its hello carries no id.
	const [c, d] = pipe();
	const second = root.link(c);

	d.listen(() => undefined);
	d.send({ "\0hub": { "hub": "hello" } });
	await wait(400);
	assert.ok(store.nodes.has("root:link-2"));
	second();
	reporter.dispose();
});
