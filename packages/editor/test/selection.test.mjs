// CI's selection of the architecture suites (test/selection.mjs): declarations, what a change made of them, which shards
// they select, and the records a run's reach folds into.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedDeclarations, declarationsOf, declarationsReached, diagramChanged, merged, select } from "./selection.mjs";

const source = ["import { x } from \"./x\";", "", "export function add(a, b) {", "\treturn a + b;", "}", "", "class Box {", "\tvalue = 1;", "", "\tget() {", "\t\treturn this.value;", "\t}", "}", "", "console.log(add(1, 2));", ""].join("\n");

test("declarations: top-level names, a class's members, the rest as the top level", () => {
	assert.deepEqual([...declarationsOf("a.ts", source).keys()], ["(top level)", "add", "Box", "Box.value", "Box.get"]);
	// (statements as instrument.ts counts them: 0-based lines)
	assert.deepEqual(declarationsReached("a.ts", source, [[3, 1, 3, 14], [10, 2, 10, 20], [14, 0, 14, 23]]), ["(top level)", "Box.get", "add"]);
});

test("a change's declarations: by their tokens, so a reformat or a comment changes none", () => {
	assert.deepEqual(changedDeclarations("a.ts", source, source.replace("return a + b;", "return a + b + 0;")), ["add"]);
	assert.deepEqual(changedDeclarations("a.ts", source, source.replace("return a + b;", "// sum\n\treturn a  +  b;")), []);
	assert.deepEqual(changedDeclarations("a.ts", source, source.replace("\tget() {", "\tset(v) {\n\t\tthis.value = v;\n\t}\n\n\tget() {")), ["Box", "Box.set"]);
	assert.deepEqual(changedDeclarations("a.ts", undefined, "export const y = 1;\n"), ["y"]);
});

// The records: four tests in tour-runs, one in smoke-app (boot); `add` reached by one tour test, `helper` by two of four
// (ambient: 30% or more), `boot` by boot's.
const records = {
	"version": 1,
	"tests": [{ "shard": "tour-runs", "name": "one" }, { "shard": "tour-runs", "name": "two" }, { "shard": "tour-runs", "name": "three" }, { "shard": "tour-runs", "name": "five" }, { "shard": "smoke-app", "name": "boot: every realm reports" }, { "shard": "tour-previews", "name": "four" }],
	"reach": { "packages/editor/a.ts": { "add": [0], "helper": [0, 1], "boot": [4] } }
};
const testsNow = records.tests;
const shards = (changes, tests = testsNow) => select(changes, records, tests).map((each) => each.shard);

test("selection: a declaration's tests; ambient code the smoke suite; docs nothing; anything else everything", () => {
	assert.deepEqual(shards([{ "file": "packages/editor/a.ts", "declarations": ["add"] }]), ["smoke-app", "tour-runs", "performance"]);
	assert.deepEqual(shards([{ "file": "packages/editor/a.ts", "declarations": ["helper"] }]), ["smoke-app", "performance"], "two of four tour-runs tests: ambient");
	assert.deepEqual(shards([{ "file": "packages/editor/a.ts", "declarations": ["boot"] }]), ["smoke-app", "performance"], "boot's: ambient");
	assert.deepEqual(shards([{ "file": "packages/editor/a.ts", "declarations": ["unreached"] }]), ["smoke-app", "performance"], "code no test reached: the floor");
	assert.deepEqual(shards([{ "file": "packages/editor/RUNNING.md", "declarations": [] }]), []);
	assert.deepEqual(shards([{ "file": "packages/editor-api/test/gate.test.mjs", "declarations": [] }, { "file": ".silo/features.json", "declarations": [] }, { "file": "packages/theme/budget.json", "declarations": [] }]), [], "unit tests, the ledger, the theme's budget: nothing the suites run");
	assert.deepEqual(shards([{ "file": "packages/editor/ARCHITECTURE.md", "declarations": ["(diagram)"] }]), ["tour-previews", "tour-runs", "tour-capabilities"], "its diagram: the tours");
	assert.deepEqual(shards([{ "file": "packages/editor/ARCHITECTURE.md", "declarations": [] }]), [], "its prose: nothing");
	assert.deepEqual(shards([{ "file": "packages/editor/test/architecture-tour-previews.mjs", "declarations": [] }]), ["tour-previews"]);
	assert.deepEqual(shards([{ "file": "pnpm-lock.yaml", "declarations": [] }]), ["smoke-app", "tour-previews", "tour-runs", "tour-capabilities", "performance"]);
	assert.deepEqual(shards([{ "file": "packages/editor/test/architecture-harness.mjs", "declarations": [] }]).length, 5, "the harness: every shard");
	assert.deepEqual(shards([{ "file": "packages/editor/a.ts", "declarations": ["add"] }], [...testsNow, { "shard": "tour-capabilities", "name": "new" }]), ["smoke-app", "tour-runs", "tour-capabilities", "performance"], "a test with no record runs");
	assert.deepEqual(shards([{ "file": "packages/editor/RUNNING.md", "declarations": [] }], [...testsNow, { "shard": "tour-capabilities", "name": "new" }]), [], "a docs change runs nothing, new tests or not");
});

test("ARCHITECTURE.md: its diagram changed, or only its prose", () => {
	const doc = (prose, diagram) => `# Architecture\n\n${prose}\n\n<!-- architecture-tour:begin -->\n${diagram}\n<!-- architecture-tour:end -->\n`;

	assert.equal(diagramChanged(doc("a", "x --> y"), doc("b", "x --> y")), false);
	assert.equal(diagramChanged(doc("a", "x --> y"), doc("a", "x --> z")), true);
});

test("merged: a run's reach folds into the records — sets grow, a declaration its file lost drops out", () => {
	const texts = { "packages/editor/a.ts": source };
	const once = merged({ "version": 1, "tests": [], "reach": {} }, { "architecture-tour-runs": { "one": { "packages/editor/a.ts": [[3, 1, 3, 14]] } } }, (file) => texts[file]);

	assert.deepEqual(once, { "version": 1, "tests": [{ "shard": "tour-runs", "name": "one" }], "reach": { "packages/editor/a.ts": { "add": [0] } } });

	const twice = merged(once, { "architecture-tour-runs": { "one": { "packages/editor/a.ts": [[10, 2, 10, 20]] }, "two": { "packages/editor/a.ts": [[3, 1, 3, 14]] } } }, (file) => texts[file]);

	assert.deepEqual(twice.reach, { "packages/editor/a.ts": { "add": [0, 1], "Box.get": [0] } }, "one keeps add, and adds Box.get");

	texts["packages/editor/a.ts"] = source.replace("export function add(a, b) {", "export function sum(a, b) {");
	assert.deepEqual(merged(twice, {}, (file) => texts[file]).reach, { "packages/editor/a.ts": { "Box.get": [0] } }, "add's gone from its file");
});
