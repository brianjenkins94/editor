/**
 * ESLint in the editor (extensions/eslint), end to end in a real editor: real ESLint in its worker, from the toolchain
 * the build packed, linting the workspace's files as they're written — with the preset where the workspace has no
 * config of its own (the starter has none), with a folder's own `eslint.config.js` for the files under it, and with the
 * preset again, said on the config, when one fails to load; fixing on save; and nothing at all with `eslint.enable` off.
 * Each lint a span (`editor.extensions.eslint.lint`), as `ext:eslint`'s. Each file is shown in an editor, as a person has
 * it: ESLint lints the documents its extension host has, and a file written and not shown isn't one (NEXT.md).
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

const write = async (path, content) => session.request("files.write", { "path": path, "content": content }, 60_000);

/** `path` written, then shown in an editor. */
const writeShown = async (path, content) => {
	await write(path, content);
	await session.workbench().evaluate(async (file) => {
		const { api } = globalThis.__editor;

		await api.window.showTextDocument(api.Uri.file("/workspace/" + file));
	}, path);
};

/** `file`'s ESLint problems, once there are some that `wanted` says are what it waits for. */
const problemsOf = async (file, wanted, what) => session.eventually(what, async () => {
	const { problems } = await session.request("problems.list", { "file": file }, 10_000);
	const eslint = problems.filter((problem) => problem.source === "eslint");

	return wanted(eslint) ? eslint : undefined;
}, 120_000);

test("a file is linted as it's written, by the preset where the workspace has no config: each problem by its rule", async () => {
	await writeShown("lint/probe.ts", "export function run(): void {\n\tdebugger;\n}\n");

	const problems = await problemsOf("lint/probe.ts", (found) => found.some((problem) => problem.code === "no-debugger"), "no-debugger on probe.ts");
	const debuggerProblem = problems.find((problem) => problem.code === "no-debugger");

	assert.deepEqual([debuggerProblem.line, debuggerProblem.column], [2, 2]);
	assert.ok(session.printed().some((line) => line.startsWith("[ext:eslint]") && line.includes("editor.extensions.eslint.lint")), "each lint a span of ext:eslint's");
});

test("saving fixes what can be fixed (source.fixAll.eslint on save)", async () => {
	await writeShown("lint/fix.ts", "export const other = 2;\n");
	await problemsOf("lint/fix.ts", () => true, "fix.ts linted");
	// (typed into its editor and saved, as a person saves)
	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const document = await api.workspace.openTextDocument(api.Uri.file("/workspace/lint/fix.ts"));
		const edit = new api.WorkspaceEdit();

		edit.insert(document.uri, new api.Position(0, 0), "var value = 1;\nexport { value };\n");
		await api.workspace.applyEdit(edit);
		await api.commands.executeCommand("workbench.action.files.save");
	});

	const fixed = await session.eventually("fix.ts fixed", async () => {
		const { content } = await session.request("files.read", { "path": "lint/fix.ts" }, 10_000);

		return content.includes("var value") ? undefined : content;
	}, 120_000);

	assert.match(fixed, /^1\t(?:const|let) value = 1;$/mu);
});

test("a folder's own eslint.config.js lints the files under it", async () => {
	// (no-magic-numbers: off in the preset, so only this config says it)
	await write("own/eslint.config.js", "export default [{ \"rules\": { \"no-magic-numbers\": \"error\" } }];\n");
	await writeShown("own/a.js", "export const minutes = 60 * 24;\n");

	const found = await problemsOf("own/a.js", (problems) => problems.some((problem) => problem.code === "no-magic-numbers"), "own config's no-magic-numbers on own/a.js");

	assert.ok(found.every((problem) => problem.code === "no-magic-numbers"), "only its own config's rules: " + found.map((problem) => problem.code).join(", "));
});

test("a config that fails to load says why, on itself, and the preset lints meanwhile", async () => {
	await write("broken/eslint.config.js", "throw new Error(\"broken on purpose\");\n");
	await writeShown("broken/b.ts", "export function run(): void {\n\tdebugger;\n}\n");

	await problemsOf("broken/b.ts", (found) => found.some((problem) => problem.code === "no-debugger"), "the preset's no-debugger on broken/b.ts");

	const [said] = await problemsOf("broken/eslint.config.js", (found) => found.length > 0, "the config's problem");

	assert.match(said.message, /couldn't load this config, so the preset lints meanwhile: .*broken on purpose/u);
});

test("with eslint.enable off, nothing is linted", async () => {
	const enabled = async (on) => session.workbench().evaluate((value) => globalThis.__editor.api.workspace.getConfiguration("eslint").update("enable", value, 1), on);

	await enabled(false);

	try {
		await session.eventually("probe.ts's problems gone", async () => {
			const { problems } = await session.request("problems.list", { "file": "lint/probe.ts" }, 10_000);

			return problems.some((problem) => problem.source === "eslint") ? undefined : true;
		}, 60_000);
	} finally {
		await enabled(true);
	}

	await problemsOf("lint/probe.ts", (found) => found.length > 0, "probe.ts linted again");
});
