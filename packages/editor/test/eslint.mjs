/**
 * What of ESLint a person doesn't see, and so in-editor/eslint.spec.mjs can't read: a problem as the agents' request has
 * it, and each lint a span (`editor.extensions.eslint.lint`), as `ext:eslint`'s. What a person has of it is that spec's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/eslint.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("eslint");
});

test("a lint is a span of ext:eslint's, and its problems the agents' request's, each by its rule and place", async () => {
	await session.request("files.write", { "path": "lint/probe.ts", "content": "export function run(): void {\n\tdebugger;\n}\n" }, 60_000);
	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.window.showTextDocument(api.Uri.file("/workspace/lint/probe.ts"));
	});

	const found = await session.eventually("no-debugger on probe.ts", async () => {
		const { problems } = await session.request("problems.list", { "file": "lint/probe.ts" }, 10_000);

		return problems.find((problem) => problem.source === "eslint" && problem.code === "no-debugger");
	}, 120_000);

	assert.deepEqual([found.line, found.column], [2, 2]);
	assert.ok(session.printed().some((line) => line.startsWith("[ext:eslint]") && line.includes("editor.extensions.eslint.lint")), "each lint a span of ext:eslint's");
});
