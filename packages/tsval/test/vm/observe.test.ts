import type { ObserveSite } from "../../src/vm.ts";
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";
import { typeTag } from "../../src/values.ts";

/** Run `code`, telling each observed site as `site text → value` (values as typeTag reads them, arms as numbers). */
function observed(code: string): string[] {
	const seen: string[] = [];
	const { vm, sourceFile } = createVM(code, {
		"observe": (node, site: ObserveSite, value) => {
			seen.push(`${site} ${node.getText(sourceFile)} → ${site === "branch" ? String(value) : typeTag(value)}`);
		}
	});

	vm.run();

	return seen;
}

test("observe is told nothing unless asked: a program runs the same without it", () => {
	const { vm } = createVM("const a = { b: 1 }; const c = a?.b ?? 2; c;");

	assert.strictEqual(vm.run(), 1);
});

test("optional chains: the value each ?. tests, and nothing past a link that stopped the chain", () => {
	assert.deepStrictEqual(observed([
		"const world = { onWin: () => 1, map: undefined as { size?: number } | undefined };",
		"world.onWin?.();",
		"world.map?.size;",
		"world.map?.size?.toFixed();"
	].join("\n")), [
		"optional world.onWin?.() → function",
		"return 1 → number",
		"optional world.map?.size → undefined",
		"optional world.map?.size → undefined"
	]);
});

test("??: the left side's value; && and ||: whether the right side ran", () => {
	assert.deepStrictEqual(observed([
		"const a = null ?? 'x';",
		"const b = 0 ?? 'y';",
		"const c = true && 'z';",
		"const d = true || 'w';"
	].join("\n")), [
		"nullish null ?? 'x' → null",
		"nullish 0 ?? 'y' → number",
		"branch true && 'z' → 0",
		"branch true || 'w' → 1"
	]);
});

test("if and the conditional: which arm ran (1 for an else that isn't there)", () => {
	assert.deepStrictEqual(observed([
		"let n = 0;",
		"if (n > 1) { n = 2; }",
		"if (n === 0) { n = 3; } else { n = 4; }",
		"const m = n > 2 ? 'big' : 'small';"
	].join("\n")), [
		"branch if (n > 1) { n = 2; } → 1",
		"branch if (n === 0) { n = 3; } else { n = 4; } → 0",
		"branch n > 2 ? 'big' : 'small' → 0"
	]);
});

test("parameters: what was passed (before a default), and a rest parameter's array; returns: what came back", () => {
	assert.deepStrictEqual(observed([
		"class Player { name: string; constructor(name: string) { this.name = name; } }",
		"function make(name: string, score = 0, ...tags: string[]) { return new Player(name); }",
		"make('ada');",
		"const twice = (n: number) => n * 2;",
		"twice(2);"
	].join("\n")), [
		"parameter name: string → string",
		"parameter score = 0 → undefined",
		"parameter ...tags: string[] → array",
		"parameter name: string → string",
		"return return new Player(name); → Player",
		"parameter n: number → number",
		"return n * 2 → number"
	]);
});

test("typeTag reads a value's kind without running any of its code", () => {
	let ran = false;
	const tricky = Object.create({ "constructor": undefined }, { "trap": { "get": () => { ran = true; return 1; } } }) as object;

	assert.deepStrictEqual([undefined, null, true, 1, "s", 1n, Symbol("s"), () => 1, [], {}, new Map(), Object.create(null), tricky].map(typeTag), ["undefined", "null", "boolean", "number", "string", "bigint", "symbol", "function", "array", "object", "Map", "object", "object"]);
	assert.strictEqual(ran, false);
});
