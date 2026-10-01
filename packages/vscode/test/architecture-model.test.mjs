// The declared architecture model: subject families route along the hub tree, and conformance flags what the model
// doesn't declare. Run: node --test test/architecture-model.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { appLayout, appNodes, checkConformance, classifyUrl, declaredBetween, declaredOn, familiesOnLink, identifyWorker, nodes, subjectOfLabel } from "../architecture-model.ts";

const patterns = (a, b) => familiesOnLink(a, b).map((family) => family.pattern);

test("a subject family may only cross the tree links between its hubs", () => {
	// git.* runs shell ⇄ workbench, through root
	assert.ok(patterns("shell", "root").includes("git.>"));
	assert.ok(patterns("root", "workbench").includes("git.>"));
	assert.ok(!patterns("workbench", "pod").includes("git.>"));
	// capability.decide: pod serves, root (for the sw) and shell call — so it crosses root⇄workbench, workbench⇄pod,
	// shell⇄root; the sw only ever asks its tab's root (capability.decide.<tab>), never the pod directly
	for (const [a, b] of [["root", "workbench"], ["workbench", "pod"], ["shell", "root"]]) {
		assert.ok(patterns(a, b).includes("capability.decide"), `${a}⇄${b}`);
	}

	assert.ok(!patterns("sw", "root").includes("capability.decide"));
	assert.ok(patterns("sw", "root").includes("capability.decide.*"));

	assert.ok(!patterns("workbench", "node").includes("capability.decide"));
	// logs go everywhere
	assert.ok(patterns("pod", "debug-worker").includes("$sys.log.>"));
});

test("labels map back to subjects; control frames aren't subjects", () => {
	assert.equal(subjectOfLabel("↩ git.status()"), "git.status");
	assert.equal(subjectOfLabel("git.status()"), "git.status");
	assert.equal(subjectOfLabel("node.out.*"), "node.out.*");
	assert.equal(subjectOfLabel("hello"), undefined);
	assert.equal(subjectOfLabel("interest (sub)"), undefined);
});

test("conformance flags undeclared channels, unexpected subjects, duplicate peers and unknown nodes", () => {
	const labels = (...names) => new Map(names.map((name) => [name, { "count": 1, "hub": 1 }]));
	const violations = checkConformance({
		"nodes": ["workbench", "mystery", "webview:1", "worker:TextMateWorker"],
		"channels": [
			{ "a": "shell", "b": "root", "labels": labels("git.status()", "↩ git.status()", "hello", "$sys.log.shell") },
			{ "a": "workbench", "b": "pod", "labels": labels("git.commit()") }, // git.* doesn't belong below the workbench
			{ "a": "shell", "b": "node", "labels": labels("x") }, // no such link or channel
			{ "a": "workbench", "b": "worker:TextMateWorker", "labels": labels("$acceptNewModel") },
			// a probe-observed message on a pair that is ALSO a hub link isn't a subject
			{ "a": "workbench", "b": "node", "labels": new Map([["ws-control", { "count": 1, "hub": 0 }]]) }
		],
		"topology": new Map([["sw", { "links": [{ "peerId": "root" }, { "peerId": "root" }] }]])
	});

	assert.deepEqual(violations, [
		{ "type": "unexpected-subject", "a": "workbench", "b": "pod", "subject": "git.commit", "count": 1 },
		{ "type": "undeclared-channel", "a": "shell", "b": "node" },
		{ "type": "duplicate-peer", "hub": "sw", "peer": "root", "links": 2 },
		{ "type": "unknown-node", "id": "mystery" },
		{ "type": "unknown-node", "id": "webview:1" } // webviews can't serve resources here, so one is never expected
	]);
});

test("every declared channel endpoint and hub link names a declared node (or a pattern)", () => {
	const ids = new Set(nodes.map((node) => node.id));

	for (const pair of [["exthost:LocalWebWorker:0", "nested:tsserver"], ["preview:5173", "sw"], ["pod", "worker:server-host"]]) {
		assert.notEqual(declaredBetween(...pair), undefined, pair.join("⇄"));
	}

	assert.equal(declaredBetween("workbench", "webview:abc"), undefined); // deliberately undeclared (see the model's header)

	for (const node of nodes) {
		assert.ok(ids.has(node.id));
	}
});

test("workers and URLs map to model ids", () => {
	assert.deepEqual(identifyWorker("https://x/lsp/debug-worker.js?v=1"), { "id": "debug-worker", "container": "podWorkers", "owner": "pod" });
	assert.equal(identifyWorker("blob:foo"), undefined);
	assert.equal(classifyUrl(new URL("ws://localhost:7378")), "debug-mcp");
	assert.equal(classifyUrl(new URL("https://unpkg.com/react")), "net:unpkg.com");
});

test("ARCHITECTURE.md's generated diagram is the model's", async () => {
	const { readFile } = await import("node:fs/promises");
	const { declaredMermaid } = await import("../architecture-model.ts");
	const doc = await readFile(new URL("../ARCHITECTURE.md", import.meta.url), "utf8");
	const block = /<!-- architecture-model:begin -->\n```mermaid\n([\s\S]*?)\n```\n<!-- architecture-model:end -->/u.exec(doc)?.[1];

	assert.equal(block, declaredMermaid(), "ARCHITECTURE.md is stale: regenerate the block from architecture-model.ts");
});

test("each pair of contexts is declared as one channel (a second one could never be seen)", async () => {
	const { channels } = await import("../architecture-model.ts");
	const pairs = channels.map((channel) => [channel.a, channel.b].sort().join(" ⇄ "));
	const duplicates = pairs.filter((pair, index) => pairs.indexOf(pair) !== index);

	assert.deepEqual(duplicates, []);
});

/** One preview window's worth of a netsim-shaped app, as the editor observes it: named by the shell as it enters (the
 *  edge names — observability's scopedTransport): its page IS `window`, its other hubs under it. */
function appWindow(window) {
	const at = (id) => window + "/" + id;
	const base = "http://localhost:5173/__virtual__/t1/5173/";
	const instance = base + "instance.html?id=client-0";

	return {
		"topology": [
			[window, { "links": [{ "peerId": "shell" }, { "peerId": at("referee") }] }],
			[at("referee"), { "links": [{ "peerId": window }, { "peerId": at("client-0") }] }],
			[at("client-0"), { "links": [{ "peerId": at("referee") }, { "peerId": at("client-0/ui") }] }],
			[at("client-0/ui"), { "links": [{ "peerId": at("client-0") }] }]
		],
		"channels": [
			{ "a": "shell", "b": window, "labels": new Map([["tab.here", { "count": 1, "hub": 1 }]]) },
			{ "a": window, "b": at("referee"), "labels": new Map([["netsim.local.join()", { "count": 1, "hub": 1 }]]) },
			{ "a": at("client-0"), "b": at("client-0/ui"), "labels": new Map([["netsim.local.view.client-0", { "count": 9, "hub": 9 }]]) }
		],
		// Both windows of one port load the same addresses. A worker says who started it (the preview tap's tag).
		"realms": [
			[window, { "kind": "window", "url": base }],
			[at("client-0/ui"), { "kind": "window", "url": instance, "parent": base }],
			[at("referee"), { "kind": "worker", "url": base + "src/browser/referee.worker.ts", "parent": base }],
			[at("client-0"), { "kind": "worker", "url": base + "src/browser/client.worker.ts", "parent": instance }]
		]
	};
}

test("a previewed app's contexts are its own: scoped under their preview window, and not checked against the model", () => {
	const app = appWindow("preview:5173");
	const topology = new Map([
		["shell", { "links": [{ "peerId": "root" }, { "peerId": "preview:5173" }] }],
		["root", { "links": [{ "peerId": "shell" }, { "peerId": "mystery" }] }],
		...app.topology
	]);
	const channels = [...app.channels, { "a": "root", "b": "mystery", "labels": new Map() }];

	assert.deepEqual([...appNodes({ "channels": channels, "topology": topology })].sort(), ["preview:5173/client-0", "preview:5173/client-0/ui", "preview:5173/referee"], "its page is the window, not an app context");

	const violations = checkConformance({ "nodes": ["shell", "root", "preview:5173", ...app.topology.map(([id]) => id), "mystery"], "channels": channels, "topology": topology });

	assert.deepEqual(violations.map((violation) => violation.type === "unknown-node" ? "unknown " + violation.id : violation.type + " " + violation.a + "⇄" + violation.b).sort(), ["undeclared-channel root⇄mystery", "unknown mystery"], "the editor's own unknowns are still flagged");
	// An unscoped undeclared hub linked to the shell is a finding, not an app.
	assert.ok(checkConformance({ "nodes": ["page"], "channels": [{ "a": "shell", "b": "page", "labels": new Map() }], "topology": new Map([["page", { "links": [{ "peerId": "shell" }] }]]) }).some((violation) => violation.type === "unknown-node" && violation.id === "page"));
});

test("a previewed app's layout: frames in the realm at their parent address, workers under the realm that started them", () => {
	const app = appWindow("preview:5173");
	const layout = appLayout({ "channels": app.channels, "topology": new Map(app.topology), "realms": new Map(app.realms) });

	assert.deepEqual(Object.fromEntries(layout.parent), { "preview:5173/client-0/ui": "preview:5173", "preview:5173/referee": "preview:5173", "preview:5173/client-0": "preview:5173/client-0/ui" });
});

test("two windows on one port: each window's contexts apart, nested within that window only, none flagged", () => {
	const first = appWindow("preview:5173");
	const second = appWindow("preview:5173~2");
	const topology = new Map([["shell", { "links": [{ "peerId": "root" }, { "peerId": "preview:5173" }, { "peerId": "preview:5173~2" }] }], ["root", { "links": [{ "peerId": "shell" }] }], ...first.topology, ...second.topology]);
	const channels = [...first.channels, ...second.channels];
	const layout = appLayout({ "channels": channels, "topology": topology, "realms": new Map([...first.realms, ...second.realms]) });

	assert.equal(layout.nodes.size, 6);
	// Same addresses in both windows, yet each sits in its own window.
	assert.equal(layout.parent.get("preview:5173/client-0/ui"), "preview:5173");
	assert.equal(layout.parent.get("preview:5173~2/client-0/ui"), "preview:5173~2");
	assert.equal(layout.parent.get("preview:5173~2/client-0"), "preview:5173~2/client-0/ui");
	assert.deepEqual(checkConformance({ "nodes": ["shell", "root", "preview:5173", "preview:5173~2", ...layout.nodes], "channels": channels, "topology": topology }), []);
});

test("nothing is guessed: a context that doesn't say where it runs sits in its window, and a hub across windows is its own", () => {
	// netsim's players: the player window's client links to the host window's referee over a BroadcastChannel, so its
	// link's peer is named under the player's window — drawn as it's named, not matched up with the host's by name.
	const topology = new Map([
		["preview:5173~2", { "links": [{ "peerId": "shell" }, { "peerId": "preview:5173~2/player-1" }] }],
		["preview:5173~2/player-1", { "links": [{ "peerId": "preview:5173~2" }, { "peerId": "preview:5173~2/player-1/referee" }] }]
	]);
	const layout = appLayout({ "channels": [{ "a": "preview:5173~2/player-1", "b": "preview:5173~2/player-1/referee" }], "topology": topology, "realms": new Map() });

	assert.deepEqual([...layout.nodes].sort(), ["preview:5173~2/player-1", "preview:5173~2/player-1/referee"]);
	assert.equal(layout.parent.size, 0);
});

test("a pair meeting through a medium only they use is judged by the medium's declaration", () => {
	// The model declares node ⇄ channel:vite-ws-channel; drawn as one edge, node ⇄ its client through that channel.
	const throughDeclared = { "a": "node", "b": "worker:ws-client.js", "medium": "channel:vite-ws-channel", "labels": new Map() };
	const throughUnknown = { "a": "workbench", "b": "node", "medium": "channel:mystery", "labels": new Map() };

	assert.equal(declaredOn(throughDeclared)?.type, "channel");
	assert.equal(declaredOn(throughUnknown), undefined);
	assert.equal(declaredOn({ "a": "shell", "b": "root" })?.type, "hub", "no medium: the pair itself");

	const violations = checkConformance({ "nodes": [], "channels": [throughDeclared, throughUnknown], "topology": new Map() });

	assert.deepEqual(violations, [{ "type": "undeclared-channel", "a": "workbench", "b": "node" }]);
});
