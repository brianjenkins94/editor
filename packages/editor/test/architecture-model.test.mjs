// The declared architecture model: subject families route along the hub tree, and conformance flags what the model
// doesn't declare. Run: node --test test/architecture-model.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { classifyUrl, identifyWorker } from "../../editor-api/src/probes.ts";
import { allowedOnLink, channels, checkConformance, declaredBetween, declaredOn, familiesOnLink, nodes, subjectMatches, subjectOfLabel, subjects } from "../shared/architecture-model.ts";

const patterns = (from, to) => familiesOnLink(from, to).map((family) => family.pattern);

test("a subject family may only cross the tree links between its senders and receivers", () => {
	// git.discard runs shell → workbench, through root — and only there (the Source Control view, the bridge's, doesn't)
	assert.ok(patterns("shell", "root").includes("git.discard"));
	assert.ok(patterns("root", "workbench").includes("git.discard"));
	assert.ok(!patterns("workbench", "bridge").includes("git.discard"));
	// runs.begin: the bridge asks the workbench, over their one link
	assert.ok(patterns("workbench", "bridge").includes("runs.begin"));
	assert.ok(!patterns("shell", "root").includes("runs.begin"));
	// logs go everywhere
	assert.ok(patterns("bridge", "debug-worker").includes("$sys.log.>"));
});

test("and only in its direction: an event or a call from its senders to its receivers, a reply back", () => {
	// a call goes caller → server, its reply server → caller
	assert.ok(allowedOnLink("git.status()", "shell", "root"));
	assert.ok(!allowedOnLink("git.status()", "root", "shell"), "the workbench doesn't call the shell's git.status");
	assert.ok(allowedOnLink("↩ git.status()", "root", "shell"));
	assert.ok(!allowedOnLink("↩ git.status()", "shell", "root"));
	// an event goes publisher → subscriber
	assert.ok(allowedOnLink("git.changed", "workbench", "root"));
	assert.ok(!allowedOnLink("git.changed", "root", "workbench"), "the shell doesn't announce git changes");
	// what isn't declared may cross nowhere
	assert.ok(!allowedOnLink("runs.changed", "workbench", "root"));
});

test("every family names who sends it and who it's for, as hubs in the tree", () => {
	const hubs = new Set(["*", ...nodes.filter((node) => node.hub === true).map((node) => node.id), "debug-mcp"]);

	for (const family of subjects) {
		assert.ok(Array.isArray(family.from) && Array.isArray(family.to), family.pattern);

		for (const id of [...family.from, ...family.to]) {
			assert.ok(hubs.has(id), `${family.pattern}: ${id} isn't a hub`);
		}
	}
});

test("every direct channel says why it isn't a hub link", () => {
	const reasons = new Set(["platform", "shared memory", "storage", "synchronous", "isolation", "bulk data", "in-realm"]);

	for (const channel of channels) {
		assert.ok(reasons.has(channel.reason), `${channel.a} ⇄ ${channel.b}: ${channel.reason}`);
	}
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
			{ "a": "workbench", "b": "bridge", "labels": labels("git.discard()") }, // discarding is the shell's alone
			// counted by direction: the shell's git.changed would be the wrong way round
			{ "a": "root", "b": "shell", "labels": new Map([["git.changed", { "count": 3, "hub": 3, "forward": 2, "backward": 1 }]]) },
			{ "a": "shell", "b": "bridge", "labels": labels("x") }, // no such link or channel
			{ "a": "workbench", "b": "worker:TextMateWorker", "labels": labels("$acceptNewModel") },
			// a probe-observed message on a pair that is ALSO a hub link isn't a subject
			{ "a": "workbench", "b": "bridge", "labels": new Map([["ws-control", { "count": 1, "hub": 0 }]]) }
		],
		"topology": new Map([["sw", { "links": [{ "peerId": "root" }, { "peerId": "root" }] }]])
	});

	assert.deepEqual(violations, [
		{ "type": "unexpected-subject", "a": "workbench", "b": "bridge", "subject": "git.discard", "count": 1 },
		{ "type": "unexpected-subject", "a": "shell", "b": "root", "subject": "git.changed", "count": 1 },
		{ "type": "undeclared-channel", "a": "shell", "b": "bridge" },
		{ "type": "duplicate-peer", "hub": "sw", "peer": "root", "links": 2 },
		{ "type": "unknown-node", "id": "mystery" } // a webview (webview:1) is known: an inline document is fine here
	]);
});

test("every declared channel endpoint and hub link names a declared node (or a pattern)", () => {
	const ids = new Set(nodes.map((node) => node.id));

	for (const pair of [["exthost:LocalWebWorker:0", "nested:tsserver"], ["worker:TextMateWorker", "sw"], ["exthost:LocalWebWorker:0", "ext:cspell/cspell"], ["workbench", "webview:abc"]]) {
		assert.notEqual(declaredBetween(...pair), undefined, pair.join("⇄"));
	}

	for (const node of nodes) {
		assert.ok(ids.has(node.id));
	}
});

test("workers and URLs map to model ids", () => {
	assert.deepEqual(identifyWorker("https://x/lsp/debug-worker.js?v=1"), { "id": "debug-worker", "container": "debugWorkers", "owner": "bridge" });
	assert.equal(identifyWorker("blob:foo"), undefined);
	assert.equal(classifyUrl(new URL("ws://localhost:7378")), "debug-mcp");
	assert.equal(classifyUrl(new URL("https://unpkg.com/react")), "net:unpkg.com");
});

test("a subject's component: the one subscribed to it, a call or a folded subject alike", async () => {
	const { componentFor } = await import("../shared/architecture-model.ts");
	const root = { "subscriptions": ["$rpc.reply.root", "$rpc.call.virtual.request.fab8e817", "project.open"], "sites": { "project.open": ["serveProjects"] } };

	assert.equal(componentFor(root, "project.open"), "serveProjects", "by its registering function");
	assert.equal(componentFor(root, "virtual.request.fab8e817"), "virtual", "a call, by namespace");
	assert.equal(componentFor(root, "virtual.request.*"), "virtual", "a label already folded");
	assert.equal(componentFor(root, "git.status"), undefined, "relayed, not handled");
});

test("the tour's diagram: what was seen, one of a kind each, without counts", async () => {
	const { tourDiagram } = await import("../shared/architecture-model.ts");
	const node = (id, extra = {}) => ({ "id": id, "state": "alive", ...extra });
	const snapshot = (count) => ({
		"nodes": [node("shell"), node("debug-worker"), node("server:3000", { "spec": { "label": "Server :3000" } }), node("server:3001", { "spec": { "label": "Server :3001" } }), node("workbench"), node("ext:notes", { "spec": { "label": "notes", "container": "extHostWorker" } }), node("store:.silo/notes/…/<file>.jsonl"), node("net:esm.sh", { "state": "declared" }), node("net:ka-f.fontawesome.com")],
		"channels": [
			{ "a": "debug-worker", "b": "server:3000", "labels": { "GET 200": { "count": count } } },
			{ "a": "debug-worker", "b": "server:3001", "labels": { "GET 200": { "count": 1 } } },
			{ "a": "shell", "b": "net:ka-f.fontawesome.com", "labels": { "GET 200": { "count": 1 } } },
			{ "a": "ext:notes", "b": "store:.silo/notes/…/<file>.jsonl", "labels": { "read": { "count": count }, "write": { "count": 1 } } }
		],
		"topology": { "workbench": { "subscriptions": ["$rpc.call.annotations.resolve", "$rpc.reply.abc"] } }
	});
	const diagram = tourDiagram(snapshot(1));

	assert.equal(diagram, tourDiagram(snapshot(500)), "counts don't change it");
	assert.equal(diagram.match(/\["Server :\*"\]/gu)?.length, 1, "two servers are one part");
	assert.match(diagram, /n_debug_worker <-.->\|"in-realm calls"\| n_server__/u);
	assert.match(diagram, /n_ext_notes -->\|"reads, writes"\| n_store__silo_notes____file__jsonl/u);
	assert.match(diagram, /\| `\.silo\/notes\/…\/<file>\.jsonl` \| notes \| notes \|/u);
	assert.match(diagram, /\| Hub \| Component \| Serves and hears \|\n\| --- \| --- \| --- \|\n\| Workbench \| annotations \| `annotations\.resolve\(\)` \|/u, "components by namespace, the standing hubs' only, no $sys");
	assert.doesNotMatch(diagram, /esm\.sh/u, "only what was seen");
	assert.doesNotMatch(diagram, /fontawesome/u, "not a first visit's requests, past the service worker");
});

test("each pair of contexts is declared as one channel (a second one could never be seen)", async () => {
	const { channels } = await import("../shared/architecture-model.ts");
	const pairs = channels.map((channel) => [channel.a, channel.b].sort().join(" ⇄ "));
	const duplicates = pairs.filter((pair, index) => pairs.indexOf(pair) !== index);

	assert.deepEqual(duplicates, []);
});

test("a pair meeting through a medium only they use is judged by the medium's declaration", () => {
	// The model declares workbench ⇄ channel:vscode-web-state-db-global; drawn as one edge, the workbench ⇄ another
	// tab's workbench through that channel.
	const throughDeclared = { "a": "workbench", "b": "workbench:other-tab", "medium": "channel:vscode-web-state-db-global", "labels": new Map() };
	const throughUnknown = { "a": "workbench", "b": "node", "medium": "channel:mystery", "labels": new Map() };

	assert.equal(declaredOn(throughDeclared)?.type, "channel");
	assert.equal(declaredOn(throughUnknown), undefined);
	assert.equal(declaredOn({ "a": "shell", "b": "root" })?.type, "hub", "no medium: the pair itself");

	const violations = checkConformance({ "nodes": [], "channels": [throughDeclared, throughUnknown], "topology": new Map() });

	assert.deepEqual(violations, [{ "type": "undeclared-channel", "a": "workbench", "b": "node" }]);
});

// Every subject the editor's code names — what it serves, requests, publishes or subscribes to — is one the model
// declares: a subject added without its family fails here, in `npm test`, rather than only in the architecture tour's
// conformance check (which needs the editor running and the subject actually sent). Only that it's declared, not which
// way it goes: which context a file runs in isn't in its text.
test("every subject the source names is declared", () => {
	const { join, relative } = path;
	const here = new URL("..", import.meta.url).pathname;
	const roots = [here, join(here, "../../components/monaco-vscode-api"), join(here, "../observability/src"), join(here, "../hub/src"), join(here, "../debug-mcp/src")];
	const files = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);

			if (!name.startsWith(".") && !["node_modules", "dist", "test", "demo", "vendor"].includes(name)) {
				if (statSync(path).isDirectory()) {
					walk(path);
				} else if (/\.(?:ts|tsx|js|mjs)$/u.test(name) && !/\.(?:test|d)\.[^.]+$/u.test(name)) {
					files.push(path);
				}
			}
		}
	};

	roots.forEach(walk);

	const texts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
	// String constants a subject may be built from (`ARCH_SUBJECT + "." + id`) — a name given two values is no help.
	const constants = new Map();

	for (const text of texts.values()) {
		for (const [, name, value] of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = "([^"]*)"/gu)) {
			constants.set(name, constants.has(name) && constants.get(name) !== value ? undefined : value);
		}
	}

	// A subject expression's value: literals and known constants as they are, anything else one token (`*`).
	const valueOf = (expression) => expression.split(/\s*\+\s*/u).map((part) => {
		const literal = /^(["'])(.*)\1$/u.exec(part) ?? /^`(.*)`$/u.exec(part);

		if (literal !== null) {
			return literal.at(-1).replaceAll(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/gu, (whole, name) => constants.get(name) ?? "*").replaceAll(/\$\{[^}]*\}/gu, "*");
		}

		return constants.get(part) ?? "*";
	}).join("").split(".").map((token) => (token.includes("*") && token !== "*" ? "*" : token)).join(".");
	const named = [];

	for (const [file, text] of texts) {
		for (const match of text.matchAll(/\b(?:serve\(\s*[\w.]+\s*,|\.(?:request|publish|subscribe)\()\s*((?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[A-Za-z_$][\w$.]*)(?:\s*\+\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[A-Za-z_$][\w$.]*))*)\s*[,)]/gu)) {
			const line = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index).trim();
			const subject = valueOf(match[1]);

			// Not prose (a doc comment's example), nor a subject that is all variable (a helper passing its caller's on).
			if (!line.startsWith("*") && !line.startsWith("//") && !subject.split(".").every((token) => token === "*")) {
				named.push({ "subject": subject, "at": `${relative(here, file)}:${text.slice(0, match.index).split("\n").length}` });
			}
		}
	}

	assert.ok(named.length > 100, `the scan found the source's subjects (${named.length})`);

	const undeclared = named.filter(({ subject }) => !subjects.some((family) => subjectMatches(family.pattern, subject)));

	assert.deepEqual(undeclared, [], "declare each in architecture-model.ts's subjects, with who sends it and who it's for");
});
