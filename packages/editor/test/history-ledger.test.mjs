// The feature ledger in the editor (extensions/history/ledger-checks.ts), over a workspace's files as given: what's been
// decided about a file (`history.decisions`: the ledger's entries holding it, the docs' lines naming it under their
// headings) and `silo check`'s drift, each problem where Problems shows it (a removed feature its docs still name, at its
// entry in the ledger; a file no feature owns, on that file). ledger.ts reads the files and shows the problems.
import * as assert from "node:assert/strict";
import { test } from "node:test";

const { decisionsFor, driftOf } = await import("../extensions/history/ledger-checks.ts");

const LEDGER = {
	"Loading": {
		"status": "active",
		"why": "the core loads",
		"since": "2026-11-02",
		"paths": ["src/load.ts"]
	},
	"Notes on code": {
		"status": "removed",
		"why": "out until reintroduced",
		"since": "2026-11-02",
		"paths": ["src/notes.ts"]
	}
};
const TODAY = "2026-11-16";

/** A workspace's texts: the ledger, a doc and the code it's about, and `more`. */
function workspace(docs, more = {}, ledger = LEDGER) {
	return new Map(Object.entries({
		".silo/features.json": JSON.stringify(ledger, null, "\t"),
		"NEXT.md": docs,
		"src/load.ts": "export const load = 1;\n",
		...more
	}));
}

/** Its drift, each problem by the file it's on. */
function problems(texts) {
	const placed = driftOf(texts.get(".silo/features.json"), new Set(texts.keys()), texts, new Map(), TODAY);

	return Map.groupBy(placed, (each) => each.path);
}

test("what's been decided about a file: the ledger's entries holding it, and the docs' lines naming it, under their headings", () => {
	const texts = workspace("# Next\n\n## Queue\n\n- src/load.ts reads the repository first.\n- Nothing about it here.\n");
	const decided = decisionsFor("/workspace/src/load.ts", texts.get(".silo/features.json"), texts);

	assert.equal(decided.target, "src/load.ts");
	assert.deepEqual(decided.ledger.map((entry) => entry.name), ["Loading"]);
	assert.deepEqual(decided.docs, [
		{
			"doc": "NEXT.md",
			"line": 5,
			"heading": "Queue",
			"text": "- src/load.ts reads the repository first."
		}
	]);
	assert.equal(decisionsFor(" ", texts.get(".silo/features.json"), texts), undefined, "nothing asked, nothing answered");
	// (a test file is its feature's too, by the feature's `tests`)
	const tested = workspace("", {}, { ...LEDGER, "Loading": { ...LEDGER.Loading, "tests": ["test/load.test.mjs"] } });

	assert.deepEqual(decisionsFor("test/load.test.mjs", tested.get(".silo/features.json"), tested).ledger.map((entry) => entry.name), ["Loading"]);
});

test("drift: a removed feature its docs still name is a problem at its entry in the ledger", () => {
	const texts = workspace("# Next\n\nsrc/notes.ts is still described here.\n");
	const [problem, ...more] = problems(texts).get(".silo/features.json") ?? [];

	assert.equal(more.length, 0);
	assert.match(problem.message, /^removed but documented: "Notes on code" was removed, and NEXT\.md still names it/u);
	assert.equal(problem.line, texts.get(".silo/features.json").split("\n").findIndex((line) => line.includes("\"Notes on code\"")));
});

test("drift: none when the docs don't name what was removed", () => {
	assert.equal(problems(workspace("# Next\n\nOnly src/load.ts here.\n")).size, 0);
});

test("a code file no feature owns, tests and scripts among them, is a problem on that file; what's built isn't", () => {
	const ledger = {
		...LEDGER,
		"Loading": { ...LEDGER["Loading"], "what": "Loads." }
	};
	const found = problems(workspace("# Next\n", { "src/stray.ts": "export const stray = 1;\n", "test/stray.test.mjs": "export const stray = 1;\n", "dist/built.js": "export const built = 1;\n" }, ledger));

	assert.match(found.get("src/stray.ts")?.[0]?.message ?? "", /^unowned file: src\/stray\.ts is owned by no feature/u);
	assert.equal(found.get("src/stray.ts")?.[0]?.line, 0);
	assert.equal(found.get("src/load.ts"), undefined, "owned by Loading");
	assert.match(found.get("test/stray.test.mjs")?.[0]?.message ?? "", /^unowned file: test\/stray\.test\.mjs/u);
	assert.equal(found.get("dist/built.js"), undefined, "built, not code to own");
	assert.equal(found.get(".silo/features.json"), undefined);
});

test("a repository whose ledger declares no feature isn't held to owners", () => {
	assert.equal(problems(workspace("# Next\n", { "src/stray.ts": "export const stray = 1;\n" })).get("src/stray.ts"), undefined);
});

test("a file two features own is theirs when the last run's reach shows each one's tests running it, and otherwise owned twice", () => {
	const ledger = {
		"Loading": { ...LEDGER.Loading, "what": "Loads.", "paths": ["src/load.ts", "src/shared.ts"], "tests": ["test/load.test.mjs"] },
		"Saving": { "status": "active", "why": "it saves", "since": "2026-11-02", "what": "Saves.", "paths": ["src/shared.ts"], "tests": ["test/save.test.mjs"] }
	};
	const texts = workspace("", { "src/shared.ts": "export const shared = 1;\n", "test/load.test.mjs": "", "test/save.test.mjs": "" }, ledger);
	const record = (ran) => JSON.stringify({ "version": 2, "at": TODAY, "tests": [{ "file": "test/load.test.mjs", "name": "loads" }, { "file": "test/save.test.mjs", "name": "saves" }], "files": { "src/shared.ts": ran } });
	const twice = (reach) => driftOf(texts.get(".silo/features.json"), new Set(texts.keys()), texts, new Map(), TODAY, reach).filter((each) => each.check === "owned twice").map((each) => each.message.split(" — ")[0]);

	assert.deepEqual(twice(record([0, 1])), []);
	assert.deepEqual(twice(record([0])), ["owned twice: src/shared.ts is owned by \"Loading\" and \"Saving\", and no test of \"Saving\" ran it"]);
	assert.deepEqual(twice(undefined), ["owned twice: src/shared.ts is owned by \"Loading\" and \"Saving\", and no test's coverage shows it run"]);
});
