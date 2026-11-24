/**
 * The workspace searched as a person and an extension search it: findFiles' globs, Quick Open, Find in Files (the
 * component's workspace-search.ts).
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/search.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("search");
const { ask } = session;

test("search: an extension's findFiles honours its globs; Quick Open and Find in Files find what's there", async () => {
	await ask("files.write", { "path": "search/a.ts", "content": "export const needle = 1;\n" });
	await ask("files.write", { "path": "search/b.md", "content": "a needle here too\n" });
	await ask("files.write", { "path": "search/deep/c.ts", "content": "export const hay = 2;\n" });

	const found = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const paths = async (include, exclude) => (await api.workspace.findFiles(include, exclude)).map((uri) => api.workspace.asRelativePath(uri, false)).toSorted();

		return { "ts": await paths("search/**/*.ts"), "notDeep": await paths("search/**", "**/deep/**"), "packageJson": await paths("**/package.json", "**/node_modules/**") };
	});

	assert.deepEqual(found.ts, ["search/a.ts", "search/deep/c.ts"]);
	assert.deepEqual(found.notDeep, ["search/a.ts", "search/b.md"]);
	assert.ok(found.packageJson.every((each) => each.endsWith("package.json")), "a glob's files only, not every file");

	// Quick Open: a file by a fuzzy piece of its path.
	const view = session.workbench();

	await session.execute("workbench.action.quickOpen", "srchdeepc");
	await session.eventually("c.ts offered", async () => (await view.locator(".quick-input-list .monaco-list-row", { "hasText": "c.ts" }).count() > 0 ? true : undefined), 30_000);
	await session.page.keyboard.press("Escape");

	// Find in Files: the text, in the files to include and not in those to exclude.
	await session.execute("workbench.action.findInFiles", { "query": "needle", "filesToInclude": "search/**", "filesToExclude": "*.md", "triggerSearch": true });

	const results = view.locator(".search-view .monaco-list-row");

	await session.eventually("a.ts in the results", async () => (await results.filter({ "hasText": "a.ts" }).count() > 0 ? true : undefined), 30_000);
	assert.equal(await results.filter({ "hasText": "b.md" }).count(), 0, "an excluded file isn't searched");
	assert.equal(await results.filter({ "hasText": "c.ts" }).count(), 0, "a file without it isn't a result");
});
