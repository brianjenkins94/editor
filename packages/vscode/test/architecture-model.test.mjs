// The declared architecture model: subject families route along the hub tree, and conformance flags what the model
// doesn't declare. Run: node --test test/architecture-model.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { appLayout, appNodes, checkConformance, classifyUrl, declaredBetween, familiesOnLink, identifyWorker, isEndedPlaceholder, nodes, subjectOfLabel } from "../architecture-model.ts";

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

test("a link that closed before its peer answered was a transient; one still unanswered is not", () => {
	assert.equal(isEndedPlaceholder("root:link-1", "terminated"), true);
	assert.equal(isEndedPlaceholder("sw:link-12", "terminated"), true);
	assert.equal(isEndedPlaceholder("root:link-1", "alive"), false); // a live link nothing answers stays a violation
	assert.equal(isEndedPlaceholder("worker:classify-worker", "terminated"), false);
});

test("a previewed app's contexts are its own: found from its page's link to the shell, and not checked against the model", () => {
	const topology = new Map([
		["shell", { "links": [{ "peerId": "root" }, { "peerId": "preview:5173" }] }],
		["root", { "links": [{ "peerId": "shell" }, { "peerId": "mystery" }] }],
		// the app: its page hub (linked to the shell), a worker, and a worker's frame
		["page", { "links": [{ "peerId": "shell" }, { "peerId": "referee" }] }],
		["referee", { "links": [{ "peerId": "page" }, { "peerId": "client-0" }] }],
		["client-0", { "links": [{ "peerId": "referee" }, { "peerId": "client-0.ui" }] }]
	]);
	const channels = [
		{ "a": "shell", "b": "page", "labels": new Map([["tab.here", { "count": 1, "hub": 1 }]]) },
		{ "a": "page", "b": "referee", "labels": new Map([["netsim.local.join()", { "count": 1, "hub": 1 }]]) },
		{ "a": "client-0", "b": "client-0.ui", "labels": new Map([["netsim.local.view.client-0", { "count": 9, "hub": 9 }]]) },
		{ "a": "root", "b": "mystery", "labels": new Map() }
	];

	assert.deepEqual([...appNodes({ "channels": channels, "topology": topology })].sort(), ["client-0", "client-0.ui", "page", "referee"]);

	// Without the shell's link to a preview, an undeclared hub linked to the shell isn't an app.
	const noPreview = new Map([...topology, ["shell", { "links": [{ "peerId": "root" }] }]]);

	assert.deepEqual([...appNodes({ "channels": channels, "topology": noPreview })], []);

	const violations = checkConformance({ "nodes": ["shell", "root", "page", "referee", "client-0", "client-0.ui", "mystery"], "channels": channels, "topology": topology });

	assert.deepEqual(violations.map((violation) => violation.type === "unknown-node" ? "unknown " + violation.id : violation.type + " " + violation.a + "⇄" + violation.b).sort(), ["undeclared-channel root⇄mystery", "unknown mystery"], "the editor's own unknowns are still flagged");
});

test("a previewed app's layout: its page is its preview, frames sit in their windows, workers under the window they link", () => {
	const base = "http://localhost:5173/__virtual__/t1/5173/";
	const topology = new Map([
		["shell", { "links": [{ "peerId": "root" }, { "peerId": "preview:5173" }] }],
		["page", { "links": [{ "peerId": "shell" }, { "peerId": "referee" }] }],
		["referee", { "links": [{ "peerId": "page" }, { "peerId": "client-0" }] }],
		["client-0", { "links": [{ "peerId": "referee" }, { "peerId": "client-0.ui" }] }],
		["client-0.ui", { "links": [{ "peerId": "client-0" }] }]
	]);
	const realms = new Map([
		["page", { "kind": "window", "url": base }],
		["client-0.ui", { "kind": "window", "url": base + "instance.html?id=client-0", "parent": base }],
		["referee", { "kind": "worker", "url": base + "src/browser/referee.worker.ts" }],
		["client-0", { "kind": "worker", "url": base + "src/browser/client.worker.ts" }]
	]);
	const layout = appLayout({ "channels": [], "topology": topology, "realms": realms });

	assert.deepEqual([...layout.alias], [["page", "preview:5173"]], "the page in the preview's top frame IS the preview");
	assert.deepEqual(Object.fromEntries(layout.parent), { "client-0.ui": "preview:5173", "referee": "preview:5173", "client-0": "client-0.ui" });
});
