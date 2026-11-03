// The feature ledger in the editor (extensions/history/ledger.ts), against the vscode stand-in (vscode/fake.ts): what's
// been decided about a file (`history.decisions`: the ledger's entries holding it, the docs' lines naming it under their
// headings) and `silo check`'s drift in Problems (a removed feature its docs still name).
import "./vscode/hooks.mjs";

import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// (loaded as CommonJS, so the stand-in is too: one instance, the one the ledger view registers with)
const require = createRequire(import.meta.url);
const { fake, Uri } = require("vscode");
const { ledgerView } = require("../extensions/history/ledger.ts");

const LEDGER = {
	"Loading": { "status": "active", "why": "the core loads", "since": "2026-11-02", "paths": ["src/load.ts"] },
	"Notes on code": { "status": "removed", "why": "out until reintroduced", "since": "2026-11-02", "paths": ["src/notes.ts"] }
};

/** A workspace: the ledger, an empty manifest, a doc and the code it's about — and the ledger view on it. */
function workspace(docs) {
	fake.reset();
	fake.files.set(".silo/features.json", JSON.stringify(LEDGER, null, "\t"));
	fake.files.set(".silo/manifest.json", "{}");
	fake.files.set("NEXT.md", docs);
	fake.files.set("src/load.ts", "export const load = 1;\n");

	const subscriptions = [];

	return { "view": ledgerView({ "subscriptions": subscriptions }, Uri.file("/workspace")), "subscriptions": subscriptions };
}

test("what's been decided about a file: the ledger's entries holding it, and the docs' lines naming it, under their headings", async () => {
	workspace("# Next\n\n## Queue\n\n- src/load.ts reads the repository first.\n- Nothing about it here.\n");

	const decided = await fake.commands.get("history.decisions")("/workspace/src/load.ts");

	assert.equal(decided.target, "src/load.ts");
	assert.deepEqual(decided.ledger.map((entry) => entry.name), ["Loading"]);
	assert.deepEqual(decided.docs, [{ "doc": "NEXT.md", "line": 5, "heading": "Queue", "text": "- src/load.ts reads the repository first." }]);
	assert.equal(await fake.commands.get("history.decisions")(" "), undefined, "nothing asked, nothing answered");
});

test("drift in Problems: a removed feature its docs still name is a problem at its entry in the ledger", async () => {
	const { view } = workspace("# Next\n\nsrc/notes.ts is still described here.\n");

	await view.check(new Map());

	const problems = fake.diagnostics.get("silo").get(".silo/features.json");

	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /^removed but documented: "Notes on code" was removed, and NEXT\.md still names it/u);
	assert.equal(problems[0].source, "silo");
	assert.equal(problems[0].range.start.line, JSON.stringify(LEDGER, null, "\t").split("\n").findIndex((line) => line.includes("\"Notes on code\"")));
});

test("drift in Problems: none when the docs don't name what was removed", async () => {
	const { view } = workspace("# Next\n\nOnly src/load.ts here.\n");

	await view.check(new Map());

	assert.deepEqual(fake.diagnostics.get("silo").get(".silo/features.json"), []);
});
