// What nothing ran (extensions/history/unrun-of.ts `unrunOf`): each declaration no test ran, by the tests' reach (each file's
// statement lines), as one runs ran, one other code calls, or one nothing calls — from the declaration graph.
//
//   node --import tsx --test test/unrun.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { callersOf, unrunOf } = await import("../extensions/history/unrun-of.ts");

const MATH = "export function add(a, b) {\n\treturn a + b;\n}\n\nexport function twice(a) {\n\treturn add(a, a);\n}\n\nexport function triple(a) {\n\treturn a * 3;\n}\n\nexport function unused(a) {\n\treturn a - 1;\n}\n\nexport const LIMIT = 10;\n\nexport interface Shape {\n\tsize: number;\n}\n";
const MAIN = "import { twice, triple } from \"./math.ts\";\n\nfunction later() {\n\treturn triple(1);\n}\n\nconsole.log(twice(2));\n";

/** Each declaration's range in `text`, from its first line to the end of its block (or line). */
function declarations(text, names) {
	return Object.fromEntries(names.map((name) => {
		const start = text.search(new RegExp(`(?:export )?(?:function|const|interface) ${name}\\b`, "u"));
		const close = text.indexOf("\n}", start);
		const end = text.slice(start, text.indexOf("\n", start)).endsWith("{") ? close + 2 : text.indexOf("\n", start);

		return [name, { "range": [start, end], "uses": [], "fingerprint": name }];
	}));
}

const edges = {
	"math.ts#twice": ["math.ts#add"],
	"main.ts#later": ["main.ts#triple"],
	"main.ts#(top)": ["main.ts#twice"],
	"main.ts#twice": ["math.ts#twice"],
	"main.ts#triple": ["math.ts#triple"]
};
const graph = { "nodes": () => Object.keys(edges), "edges": (id) => edges[id] ?? [] };
const analyses = new Map([
	["math.ts", { "declarations": declarations(MATH, ["add", "twice", "triple", "unused", "LIMIT", "Shape"]) }],
	["main.ts", { "declarations": { ...declarations(MAIN, ["later"]), "(top)": { "uses": [], "fingerprint": "top" } } }]
]);
const texts = new Map([["math.ts", MATH], ["main.ts", MAIN]]);

test("a caller is a declaration that names it, directly or through its file's import", () => {
	const declared = new Set(["math.ts#add", "math.ts#twice", "math.ts#triple", "main.ts#later", "main.ts#(top)"]);
	const callers = callersOf(graph, declared);

	assert.deepEqual([...callers.get("math.ts#add")], ["math.ts#twice"]);
	assert.deepEqual([...callers.get("math.ts#triple")], ["main.ts#later"], "through main.ts's import of it");
	assert.deepEqual([...callers.get("math.ts#twice")], ["main.ts#(top)"]);
});

test("what no test ran: run in use, called, exported, or nothing calls it; types aren't code, and a function's own line isn't its body", () => {
	const tested = { "math.ts": new Set([1, 16]) };
	const used = { "math.ts": [[MATH.indexOf("return add"), MATH.indexOf("return add") + 17]] };
	const listed = unrunOf({ "graph": graph, "analyses": analyses, "texts": texts, "tested": tested, "used": used });

	assert.deepEqual(listed.map(({ file, name, kind, callers }) => [file, name, kind, callers]), [
		["main.ts", "later", "nothing", 0],
		["math.ts", "twice", "used", 1],
		["math.ts", "triple", "called", 1],
		["math.ts", "unused", "exported", 0]
	], "add's body ran in a test, and LIMIT's line; Shape is a type; unused is exported, for what's outside the program");
	assert.equal(listed.find(({ name }) => name === "unused").line, 13);
	assert.equal(listed.find(({ name }) => name === "unused").text, "export function unused(a) {");

	const loadedOnly = unrunOf({ "graph": graph, "analyses": analyses, "texts": texts, "tested": { "math.ts": new Set([0, 4, 8, 12]) }, "used": {} });

	assert.ok(loadedOnly.some(({ name }) => name === "add"), "a function whose first line ran (its module loaded) but not its body didn't run");
});

test("an import the graph doesn't follow — by a package's name, across packages — still counts as a caller", async () => {
	const { importsIn, isImported } = await import("../extensions/history/unrun-of.ts");
	const imports = importsIn(new Map([
		["packages/editor/workbench/editor-state.ts", "import { shownNotifications, traceLog } from \"@brianjenkins94/monaco-vscode-api/main\";\nimport type { Foo } from \"@brianjenkins94/editor-api\";\n"],
		["packages/editor/shell/a.ts", "import { helper as named } from \"./lib/helpers.ts\";\n"],
		["packages/editor/test/x.test.mjs", "import { onlyTests } from \"../shell/b.ts\";\n"]
	]));

	assert.ok(isImported("components/monaco-vscode-api/main.ts", "shownNotifications", imports));
	assert.ok(isImported("packages/editor-api/src/index.ts", "Foo", imports), "a package's bare name is its index");
	assert.ok(isImported("packages/editor/shell/lib/helpers.ts", "helper", imports), "relative, by the name it exports");
	assert.ok(!isImported("packages/editor/shell/b.ts", "onlyTests", imports), "a test's import isn't code calling it");
	assert.ok(!isImported("components/monaco-vscode-api/main.ts", "elsewhere", imports));

	const texts = new Map([["components/monaco-vscode-api/main.ts", "export async function shownNotifications() {\n\treturn [];\n}\n"], ["packages/editor/workbench/editor-state.ts", "import { shownNotifications } from \"@brianjenkins94/monaco-vscode-api/main\";\n"]]);
	const analyses = new Map([["components/monaco-vscode-api/main.ts", { "declarations": { "shownNotifications": { "range": [0, texts.get("components/monaco-vscode-api/main.ts").length - 1], "uses": [], "fingerprint": "x" } } }]]);
	const [listed] = unrunOf({ "graph": { "nodes": () => [], "edges": () => [] }, "analyses": analyses, "texts": texts, "tested": {}, "used": {} });

	assert.equal(listed.kind, "called", "imported by editor-state.ts, so called, not nothing");
});
