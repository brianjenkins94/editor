import assert from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { interpret } from "../../src/index.ts";
import { createTypedProgram, typeOfNode } from "../../src/typed.ts";

test("enum: numeric members auto-increment with a reverse mapping", () => {
	assert.strictEqual(interpret(`enum E { A, B, C } E.A + E.B + E.C`), 3);
	assert.strictEqual(interpret(`enum E { A, B } E[1]`), "B");
	assert.strictEqual(interpret(`enum E { A = 1, B, C = 10, D } E.B + E.D`), 13);
});

test("enum: string members and references to prior members", () => {
	assert.strictEqual(interpret(`enum Color { Red = "r", Green = "g" } Color.Green`), "g");
	assert.strictEqual(interpret(`enum E { A = 1, B = A * 10 } E.B`), 10);
});

test("type-only declarations are erased at runtime", () => {
	assert.strictEqual(interpret(`type T = number; interface I { x: number } const n: T = 5; n`), 5);
});

test("TypeChecker resolves the static type at a node", () => {
	const { checker, sourceFile } = createTypedProgram(`const u = new URL("https://x"); const s = "hi";`);
	const types: string[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isVariableDeclaration(n) && n.initializer) { types.push(typeOfNode(checker, n.initializer) ?? "?"); }
		n.forEachChild(visit);
	};

	sourceFile.forEachChild(visit);
	assert.ok(types.includes("URL"), `expected a URL type, got ${types.join(", ")}`);
});

test("the typed program keeps null/undefined in types and types f.call/f.apply by f's signature", () => {
	const { checker, sourceFile } = createTypedProgram(`declare function f(): string | null; declare const o: { a?: number }; const v = f(); const w = f.call(null); const x = f.apply(null, []); const a = o.a;`);
	const types: Record<string, string> = {};
	const visit = (n: ts.Node): void => {
		if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) { types[n.name.text] = typeOfNode(checker, n.initializer) ?? "?"; }
		n.forEachChild(visit);
	};

	sourceFile.forEachChild(visit);
	// Without strictNullChecks these erase to `string` / `number`; without strictBindCallApply, `.call`/`.apply` are `any`.
	assert.deepStrictEqual(types, { "v": "string | null", "w": "string | null", "x": "string | null", "a": "number | undefined" });
});
