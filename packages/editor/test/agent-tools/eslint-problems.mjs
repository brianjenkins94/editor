/**
 * ESLint's problems as an agent reads them, each by its rule and place, and each lint a span of ext:eslint's. What a
 * person has of it is in-editor/eslint.spec.mjs's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/eslint-problems.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("eslint-problems");
const { ask } = session;

test("ESLint's problems as the agents' request has them, each by its rule and place, and each lint a span of ext:eslint's", async () => {
	await ask("files.write", { "path": "lint/probe.ts", "content": "export function run(): void {\n\tdebugger;\n}\n" });
	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.window.showTextDocument(api.Uri.file("/workspace/lint/probe.ts"));
	});

	const found = await session.eventually("no-debugger on probe.ts", async () => (await ask("problems.list", { "file": "lint/probe.ts" })).problems.find((problem) => problem.source === "eslint" && problem.code === "no-debugger"), 120_000);

	assert.deepEqual([found.line, found.column], [2, 2]);
	assert.ok(session.printed().some((line) => line.startsWith("[ext:eslint]") && line.includes("editor.extensions.eslint.lint")), "each lint a span of ext:eslint's");
});
