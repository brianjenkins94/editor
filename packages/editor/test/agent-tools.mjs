/**
 * What an agent does in the editor and reads off it, in a real editor: the hub requests debug-mcp's tools ask
 * (app/tools/; page-tools.test.mjs holds the tools to them) answered by the workbench — the workspace's files read,
 * written, edited, replaced across files, found, searched and deleted (workspace-tools.ts); git's diff, log, show and
 * blame (git-history.ts); what a terminal printed (`terminal.state`); and the editor as data: the file in front, its
 * tabs, the Problems view and the notifications showing (editor-state.ts). And the workspace searched as a person and an
 * extension search it — findFiles' globs, Quick Open, Find in Files (the component's workspace-search.ts).
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("agent-tools");
});

const ask = async (subject, data) => session.request(subject, data, 30_000);

test("files: written, read numbered, edited, replaced across files or not at all, found, searched and deleted", async () => {
	assert.deepEqual(await ask("files.write", { "path": "tools/one.txt", "content": "alpha\nbeta\nalpha\n" }), { "path": "tools/one.txt", "created": true, "lines": 4 });
	await ask("files.write", { "path": "tools/two.txt", "content": "gamma\n" });

	const read = await ask("files.read", { "path": "/workspace/tools/one.txt", "offset": 2, "limit": 1 });

	assert.deepEqual([read.lines, read.from, read.to, read.content, read.dirty], [4, 2, 2, "2\tbeta", false]);
	await assert.rejects(ask("files.read", { "path": "../outside.txt" }), /outside the workspace/u);

	// One match, or say how many; `all` for every one.
	await assert.rejects(ask("files.edit", { "path": "tools/one.txt", "old": "alpha", "new": "ALPHA" }), /2 times/u);
	assert.equal((await ask("files.edit", { "path": "tools/one.txt", "old": "beta", "new": "BETA" })).replaced, 1);
	assert.equal((await ask("files.edit", { "path": "tools/one.txt", "old": "alpha", "new": "ALPHA", "all": true })).replaced, 2);

	// Across files, all or nothing: a preview changes nothing; one edit that doesn't hold, and none is made.
	const edits = [{ "path": "tools/one.txt", "old": "BETA", "new": "beta" }, { "path": "tools/two.txt", "old": "gamma", "new": "GAMMA" }];
	const preview = await ask("files.replace", { "edits": edits, "preview": true });

	assert.equal(preview.replaced, 2);
	assert.match(preview.diff, /-gamma\n\+GAMMA/u);
	await assert.rejects(ask("files.replace", { "edits": [...edits, { "path": "tools/two.txt", "old": "missing", "new": "x" }] }), /nothing was changed/u);
	assert.equal((await ask("files.read", { "path": "tools/two.txt" })).content, "1\tgamma\n2\t");
	assert.equal((await ask("files.replace", { "edits": edits })).replaced, 2);
	assert.deepEqual([(await ask("files.read", { "path": "tools/one.txt" })).content, (await ask("files.read", { "path": "tools/two.txt" })).content], ["1\tALPHA\n2\tbeta\n3\tALPHA\n4\t", "1\tGAMMA\n2\t"]);

	assert.deepEqual((await ask("files.glob", { "pattern": "tools/*.txt" })).files.toSorted(), ["tools/one.txt", "tools/two.txt"]);
	assert.deepEqual(await ask("files.grep", { "pattern": "^ALPHA$", "glob": "tools/**" }), { "matches": [{ "file": "tools/one.txt", "line": 1, "text": "ALPHA" }, { "file": "tools/one.txt", "line": 3, "text": "ALPHA" }], "total": 2 });

	assert.deepEqual(await ask("files.delete", { "path": "tools" }), { "path": "tools", "folder": true });
	await assert.rejects(ask("files.read", { "path": "tools/one.txt" }), /doesn't exist/u);
	await assert.rejects(ask("files.delete", { "path": ".git" }), /git's own files/u);
});

test("git: a diff of what changed, then the log, a file at a commit and who changed each line", async () => {
	await ask("files.write", { "path": "history.txt", "content": "first\n" });
	await session.request("git.commit", { "message": "history: first", "files": [{ "path": "history.txt" }] }, 60_000);
	await ask("files.write", { "path": "history.txt", "content": "first\nsecond\n" });

	assert.equal((await ask("git.diff", { "path": "history.txt" })).diff, "--- a/history.txt\n+++ b/history.txt\n@@ -1,1 +1,2 @@\n first\n+second\n");

	const [last] = (await ask("git.log", { "path": "history.txt", "limit": 5 })).commits;

	assert.equal(last.message, "history: first");
	assert.deepEqual(await ask("git.show", { "path": "history.txt", "rev": last.short }), { "path": "history.txt", "rev": last.short, "lines": 2, "content": "first\n" });

	const { runs } = await ask("git.blame", { "path": "history.txt" });

	assert.deepEqual(runs.map((run) => [run.from, run.to, run.commit]), [[1, 1, last.short], [2, 2, "working"]]);
});

test("a terminal's output, as it printed it", async () => {
	await session.terminal("echo said-by-the-terminal", { "fresh": true });

	const terminals = await session.eventually("the output", async () => {
		const state = await ask("terminal.state", { "lines": 20 });

		return state.some((each) => each.output.includes("said-by-the-terminal\n")) ? state : undefined;
	}, 30_000);

	assert.ok(terminals.every((each) => typeof each.terminal === "number" && Array.isArray(each.runs)));
});

test("the editor as data: the file in front and its tabs, the Problems view, the notifications showing", async () => {
	await ask("files.write", { "path": "shown.ts", "content": "const count: number = \"not a number\";\nexport { count };\n" });
	await session.open("shown.ts");

	const state = await session.eventually("shown.ts in front", async () => {
		const answer = await ask("editor.state");

		return answer.active?.file === "shown.ts" ? answer : undefined;
	}, 30_000);

	assert.deepEqual([state.active.language, state.active.lines, state.active.cursor], ["typescript", 3, { "line": 1, "column": 1 }]);
	assert.ok(state.tabs.some((tab) => tab.file === "shown.ts" && tab.active));

	// TypeScript's error on it, once the language service has the file.
	const problem = await session.eventually("TypeScript's error", async () => (await ask("problems.list", { "file": "shown.ts" })).problems.find((each) => each.source === "ts"), 120_000).catch(async (error) => {
		// (seen only on CI, opening a file early on: NEXT.md, what this is to answer)
		const problemsNow = async () => (await ask("problems.list", { "file": "shown.ts" })).problems.map((each) => each.source);
		const before = await problemsNow();
		const status = await session.workbench().locator(".statusbar-item").allInnerTexts();
		const known = await ask("code.problems", {}).catch((failed) => String(failed));

		// Does an edit bring it? (typed and undone, as a person would nudge it)
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;
			const editor = api.window.activeTextEditor;

			await editor.edit((builder) => {
				builder.insert(new api.Position(1, 0), " ");
			});
			await api.commands.executeCommand("undo");
		});
		await new Promise((resolve) => {
			setTimeout(resolve, 15_000);
		});

		console.log("[TypeScript's error never came]", JSON.stringify({ "problems": before, "afterAnEdit": await problemsNow(), "status": status.filter((text) => text.trim() !== ""), "server": known }).slice(0, 2000), JSON.stringify(await ask("editor.state")).slice(0, 400));

		throw error;
	});

	assert.deepEqual([problem.file, problem.line, problem.severity], ["shown.ts", 1, "error"]);

	await session.workbench().evaluate(() => {
		void globalThis.__editor.api.window.showInformationMessage("a notification for the agent");
	});
	await session.eventually("the notification", async () => ((await ask("notifications.list")).some((each) => each.message === "a notification for the agent") ? true : undefined), 30_000);

	await assert.rejects(ask("editor.trace", {}), /takes \{ component/u);
});

test("Trace File Calls: each call at a boundary, for a while — its operation, caller, path and time — as the trace's records", async () => {
	const opened = await ask("fs.trace", { "boundary": "zenfs", "path": "traced/", "seconds": 5 });

	assert.equal(opened.tracing, "zenfs, paths with traced/");
	await assert.rejects(ask("fs.trace", { "boundary": "zenfs" }), /a trace is open/u, "one at a time");
	await ask("files.write", { "path": "traced/a.txt", "content": "traced\n" });

	// (each call a record in the window's span, as the root prints every record: `[source] text`)
	const calls = await session.eventually("the write's store calls", async () => {
		const found = session.printed().filter((line) => line.startsWith("[workbench]") && /\bzenfs (?:write|create|stat|read)\b/u.test(line));

		return found.some((line) => line.includes("zenfs write") && line.includes("traced/a.txt")) ? found : undefined;
	}, 30_000);

	assert.ok(calls.every((line) => line.includes("traced/")), calls.slice(0, 3).join("\n"));
	await assert.rejects(ask("fs.trace", { "boundary": 1 }), /takes \{ boundary/u);
});

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
