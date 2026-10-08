import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

/** Run `code` to its uncaught throw: the 1-based line `throwSite` says it was first thrown on. */
function crashLine(code: string): number | undefined {
	const { vm } = createVM(code);

	try {
		vm.run();
	} catch (error) {
		const at = vm.location(vm.throwSite(error));

		return at === null ? undefined : at.line + 1;
	}

	return undefined;
}

test("throwSite: a runtime error escaping uncaught says the line it happened on, though the frames have unwound", () => {
	assert.strictEqual(crashLine([
		"function parse(text) {",
		"\tconst data = JSON.parse(text);",
		"\treturn data.items.length;",
		"}",
		"parse('{\"items\": [1]}');",
		"parse('{}');"
	].join("\n")), 3);
});

test("throwSite: a throw statement's own line; a rethrow keeps where it was first thrown", () => {
	assert.strictEqual(crashLine("function fail() {\n\tthrow new Error('no');\n}\nfail();"), 2);
	assert.strictEqual(crashLine([
		"function fail() {",
		"\tthrow new Error('no');",
		"}",
		"try {",
		"\tfail();",
		"} catch (error) {",
		"\tthrow error;",
		"}"
	].join("\n")), 2);
});

test("throwSite: a primitive thrown has none", () => {
	assert.strictEqual(crashLine("throw 'no';"), undefined);
});

test("throwSite: a fork (a debugger's step from a stop) keeps its own", () => {
	const { vm } = createVM("let n = 1;\nfunction parse(text) {\n\treturn text.items.length;\n}\nparse({});");

	vm.step();

	const forked = vm.fork();

	try {
		forked.run();
		assert.fail("it should throw");
	} catch (error) {
		assert.strictEqual(forked.location(forked.throwSite(error))?.line, 2);
	}
});

test("throwSite: something tsval can't run yet says where it was met — loudly, never as the program's own throw", () => {
	assert.strictEqual(crashLine("const a = 1;\n{\n\tusing r = { [Symbol.dispose]() {} };\n}\n"), 3);
	assert.strictEqual(crashLine("const a = 1;\nclass Point {\n\tconstructor(private x: number) {}\n}\nnew Point(a);"), 2);
});
