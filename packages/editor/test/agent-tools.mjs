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
	const problem = await session.eventually("TypeScript's error", async () => (await ask("problems.list", { "file": "shown.ts" })).problems.find((each) => each.source === "ts"), 120_000);

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

test("the debugger, as an agent drives it: Run to a breakpoint, a step, a call's question answered, the Margin read, stopped", async () => {
	await ask("files.write", { "path": "driven.mjs", "content": "import { writeFileSync } from \"node:fs\";\n\nconst rate = 2;\nconst total = rate * 10;\nwriteFileSync(\"/workspace/driven.txt\", String(total));\nconsole.log(\"total \" + total);\n" });

	const stopped = await session.request("debug.start", { "program": "driven.mjs", "breakpoints": [3] }, 120_000);

	assert.deepEqual([stopped.state, stopped.reason, stopped.line, stopped.code], ["stopped", "breakpoint", 3, "const rate = 2;"]);
	assert.deepEqual((await ask("debug.sessions")).map(({ session: id, state }) => [id, state]), [[stopped.session, "stopped"]]);

	const stepped = await ask(`debug.session.${stopped.session}.step`, { "action": "next" });

	assert.deepEqual([stepped.state, stepped.line], ["stopped", 4]);
	assert.ok(stepped.locals.some(({ name, value }) => name === "rate" && value === "2"), JSON.stringify(stepped.locals));

	// On to the write: the policy hasn't decided it, so it stops and asks, in the Margin too.
	const asked = await ask(`debug.session.${stopped.session}.step`, { "action": "continue" });

	assert.deepEqual([asked.state, asked.reason, asked.line], ["stopped", "capability", 5]);

	const margin = await ask("margin.state", { "file": "driven.mjs" });

	assert.deepEqual([margin.question?.line, margin.question?.capability], [5, "fs:write"]);
	assert.ok(margin.rows.some(({ line, label, value }) => line === 4 && label.startsWith("total") && value === "20"), JSON.stringify(margin.rows));

	// Skipped, as the Margin's Skip does: the run goes on, writing nothing.
	const ended = await ask(`debug.session.${stopped.session}.decide`, { "choice": "skip" });

	assert.equal(ended.state, "terminated");
	assert.deepEqual(ended.output, ["total 20"]);
	await assert.rejects(ask("files.read", { "path": "driven.txt" }), /doesn't exist/u);

	// Another, stopped from here, its breakpoints cleared.
	await ask("debug.breakpoints", { "program": "driven.mjs", "lines": [] });

	const again = await session.request("debug.start", { "program": "driven.mjs" }, 60_000);

	assert.equal(again.reason, "capability");
	assert.equal((await ask(`debug.session.${again.session}.stop`)).state, "terminated");
	assert.deepEqual(await ask("debug.sessions"), []);
});

test("what a run observed is kept in git: its envelope in .silo/runs, each statement's count and each site's values and branches in .silo/evidence", async () => {
	await ask("files.write", { "path": "observed.mjs", "content": "function play(world, score) {\n\tworld.onWin?.();\n\n\treturn score > 10 ? \"won\" : \"lost\";\n}\n\nconst world = { \"onWin\": () => undefined };\n\nconsole.log(play(world, 12), play(world, 3));\n" });

	const ran = await session.request("debug.start", { "program": "observed.mjs" }, 120_000);

	assert.equal(ran.state, "terminated", JSON.stringify(ran));

	// (written as the run ends: its evidence first, the envelope last)
	const runs = await session.eventually("the run's envelope", async () => {
		const found = (await ask("files.glob", { "pattern": ".silo/runs/*.jsonl" })).files;

		for (const file of found) {
			const lines = (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.includes("observed.mjs"));

			if (lines.length > 0) {
				return lines.map((line) => JSON.parse(line));
			}
		}

		return undefined;
	}, 60_000);
	const [envelope] = runs;

	assert.deepEqual([envelope.type, envelope.entry, envelope.exit, envelope.environment.runtime], ["run", "observed.mjs", 0, "tsval"]);
	assert.match(envelope.files["observed.mjs"], /^[\da-f]{40}$/u);

	const [evidenceFile] = (await ask("files.glob", { "pattern": `.silo/evidence/${envelope.user}/**/observed.mjs.jsonl` })).files;
	const observations = (await ask("files.read", { "path": evidenceFile })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

	assert.ok(observations.some(({ kind, arms }) => kind === "branch" && arms?.join() === "1,1"), "the ?: took each arm once");
	assert.ok(observations.some(({ kind, seen, nullish, tags }) => kind === "value" && seen === 2 && nullish === 0 && tags?.function === 2), "world.onWin was a function both times it was reached");
	assert.ok(observations.some(({ kind }) => kind === "reached"), "and the statements that ran");
	await ask("files.delete", { "path": "observed.mjs" });
});

test("what a preview observed is kept in git too: its page's counts, under the dev server's run, as the server stops", async () => {
	await ask("files.write", { "path": "evpreview/index.html", "content": "<!doctype html><html><head><title>evpreview</title></head><body><button>not yet</button><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" });
	await ask("files.write", { "path": "evpreview/src/main.ts", "content": "const hooks: { onClick?: () => void } = { \"onClick\": () => undefined };\nconst button = document.querySelector(\"button\")!;\nlet count = 0;\n\nbutton.textContent = \"ready\";\nbutton.addEventListener(\"click\", () => {\n\tcount += 1;\n\thooks.onClick?.();\n\tbutton.textContent = count > 1 ? \"many\" : \"once\";\n});\n" });
	await session.terminal("cd evpreview && vite", { "fresh": true });

	// (its page, instrumented: its script ran, the optional call in its handler with it)
	const button = async () => session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentDocument?.querySelector("button")).find((each) => each?.textContent === "ready" || each?.textContent === "once" || each?.textContent === "many")?.textContent);

	await session.eventually("the app's page", async () => (await button()) === "ready" || undefined, 90_000);

	for (let clicks = 0; clicks < 3; clicks += 1) {
		await session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentDocument?.querySelector("button")).find((each) => each !== null && each !== undefined && each.textContent !== "not yet")?.click());
	}

	assert.equal(await button(), "many");

	const server = (await ask("runs.list")).find(({ cwd, state }) => cwd.endsWith("/evpreview") && state === "running");

	assert.ok(server !== undefined, "the dev server's run");

	// (what the page counted, and the run, said if nothing's kept)
	const counted = await session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentWindow?.__evidence?.evidence?.()?.map(({ file, sites }) => ({ "file": file, "sites": sites.length }))));

	await ask("runs.stop", { "id": server.id });

	// (the page reports as its window closes, and the run's recorded as it ends)
	const observations = await session.eventually("the preview's evidence", async () => {
		const [file] = (await ask("files.glob", { "pattern": ".silo/evidence/**/evpreview/src/main.ts.jsonl" })).files;

		return file === undefined ? undefined : (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
	}, 60_000).catch(async (error) => {
		const after = (await ask("runs.list")).find(({ id }) => id === server.id);
		const envelopes = [];

		for (const file of (await ask("files.glob", { "pattern": ".silo/runs/*.jsonl" })).files) {
			envelopes.push(...(await ask("files.read", { "path": file })).content.split("\n").filter((line) => line.includes("evpreview")));
		}

		throw new Error(`${error.message}: the page counted ${JSON.stringify(counted)}; its server's run, after: ${JSON.stringify(after)}; its envelopes: ${JSON.stringify(envelopes)}; evidence kept: ${JSON.stringify((await ask("files.glob", { "pattern": ".silo/evidence/**" })).files)}`, { "cause": error });
	});

	assert.ok(observations.some(({ kind, seen, nullish, tags }) => kind === "value" && seen === 3 && nullish === 0 && tags?.function === 3), JSON.stringify(observations));
	assert.ok(observations.some(({ kind, arms }) => kind === "branch" && arms?.join() === "2,1"), "the ?: took its first arm twice, its second once");
	assert.ok(observations.some(({ kind }) => kind === "reached"));
	await ask("files.delete", { "path": "evpreview" });
});

test("refactoring, as a person does it: where a name's used, renamed everywhere, and a file moved with its imports kept right", async () => {
	await ask("files.write", { "path": "refactor/tsconfig.json", "content": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n" });
	await ask("files.write", { "path": "refactor/rate.mjs", "content": "export const rate = 2;\n" });
	await ask("files.write", { "path": "refactor/total.mjs", "content": "import { rate } from \"./rate.mjs\";\n\nexport const total = rate * 10;\n" });

	const used = await session.request("code.references", { "path": "refactor/rate.mjs", "line": 1, "name": "rate" }, 120_000);

	assert.deepEqual(used.places.map(({ file, line }) => `${file}:${String(line)}`).toSorted(), ["refactor/rate.mjs:1", "refactor/total.mjs:1", "refactor/total.mjs:3"]);

	const renamed = await session.request("code.rename", { "path": "refactor/rate.mjs", "line": 1, "name": "rate", "to": "price" }, 120_000);

	assert.deepEqual(renamed.files.toSorted(), ["refactor/rate.mjs", "refactor/total.mjs"]);
	assert.equal((await ask("files.read", { "path": "refactor/total.mjs" })).content.split("\n")[2], "3\texport const total = price * 10;");

	// Moved into a folder: its importer follows, and it's saved.
	const moved = await session.request("code.move", { "from": "refactor/rate.mjs", "to": "refactor/prices/rate.mjs" }, 120_000);

	assert.deepEqual(moved.updated, ["refactor/total.mjs"]);
	assert.match((await ask("files.read", { "path": "refactor/total.mjs" })).content, /from "\.\/prices\/rate\.mjs"/u);
	assert.equal((await ask("files.read", { "path": "refactor/total.mjs" })).dirty, false);
	await assert.rejects(session.request("code.move", { "from": "refactor/total.mjs", "to": "refactor/prices/rate.mjs" }, 30_000), /there already/u);
});

test("checkpoints, as an agent tries a change: noted, changed, a file made, and all of it put back", async () => {
	await ask("files.write", { "path": "tried/one.mjs", "content": "export const one = 1;\n" });

	const { id } = await ask("workspace.checkpoint", { "label": "before" });

	await ask("files.edit", { "path": "tried/one.mjs", "old": "1", "new": "2" });
	await ask("files.write", { "path": "tried/two.mjs", "content": "export const two = 2;\n" });

	const back = await session.request("workspace.restore", { "id": id }, 120_000);

	assert.deepEqual([back.restored, back.removed], [["tried/one.mjs"], ["tried/two.mjs"]]);
	assert.equal((await ask("files.read", { "path": "tried/one.mjs" })).content, "1\texport const one = 1;\n2\t");
	await assert.rejects(ask("files.read", { "path": "tried/two.mjs" }), /doesn't exist/u);
	await assert.rejects(ask("workspace.restore", { "id": "nothing" }), /no checkpoint nothing/u);
});

test("what a way in reaches, as History: What a Way In Reaches… shows it: where it's registered, what only it reaches, who names it", async () => {
	// (in the workspace's own TypeScript project, the one History reads: a folder of its own is another, nobody opened)
	await ask("files.write", { "path": "src/reached/hub.ts", "content": "export const hub = {};\n\nexport function serve(_hub: object, _name: string, handler: () => unknown): () => unknown {\n\treturn handler;\n}\n" });
	await ask("files.write", { "path": "src/reached/app.ts", "content": "import { hub, serve } from \"./hub\";\n\nfunction greet(): string {\n\treturn \"hello\";\n}\n\nserve(hub, \"demo.reached\", greet);\n" });
	await ask("files.write", { "path": "src/reached/caller.ts", "content": "export const asks = \"demo.reached\";\n" });

	// (History reads the program as its files change: asked until its reading has them)
	let reach;

	for (let tries = 0; reach?.way === undefined && tries < 30; tries += 1) {
		if (tries > 0) {
			await new Promise((resolve) => {
				setTimeout(resolve, 2000);
			});
		}

		reach = await session.request("code.reach", { "target": "hub request|demo.reached" }, 120_000);
	}

	try {
		assert.equal(reach.way?.key, "hub request|demo.reached", JSON.stringify(reach));
		assert.deepEqual(reach.registered.map(({ file, line }) => `${file}:${String(line)}`), ["src/reached/app.ts:7"]);
		assert.ok(reach.frees.declarations >= 1, JSON.stringify(reach.frees));
		assert.deepEqual(reach.named.map(({ file, line }) => `${file}:${String(line)}`), ["src/reached/caller.ts:1"]);
		assert.ok((await session.request("code.reach", { "target": "demo.reach" }, 120_000)).matches.includes("hub request|demo.reached"));
	} finally {
		await ask("files.delete", { "path": "src/reached" });
	}
});

test("a script over the workspace, an agent's: a count across files and what it touched, the network refused, nothing written or outside", async () => {
	await ask("files.write", { "path": "scripted/a.json", "content": "{ \"n\": 2 }\n" });
	await ask("files.write", { "path": "scripted/b.json", "content": "{ \"n\": 3 }\n" });

	const run = async (code, timeoutMs) => session.request("script.run", { "code": code, ...timeoutMs === undefined ? {} : { "timeoutMs": timeoutMs } }, 60_000);
	const counted = await run("const files = await workspace.glob(\"scripted/*.json\");\nlet total = 0;\n\nfor (const file of files) {\n\ttotal += (await workspace.json(file)).n;\n}\n\nconsole.log(\"files\", files.length);\n\nreturn { files, total };");

	assert.deepEqual(counted.value, { "files": ["scripted/a.json", "scripted/b.json"], "total": 5 }, JSON.stringify(counted));
	assert.deepEqual(counted.logs, ["files 2"]);
	assert.deepEqual([counted.touched.read, counted.touched.globs, counted.touched.refused], [["scripted/a.json", "scripted/b.json"], ["scripted/*.json"], []]);

	const fetched = await run("try {\n\tawait fetch(\"https://example.com/\");\n} catch (error) {\n\treturn error.message;\n}");

	assert.match(fetched.value, /capability 'net:\*' is not available/u, JSON.stringify(fetched));
	assert.deepEqual(fetched.touched.refused, ["net:*"]);
	assert.match((await run("return require(\"node:fs\");")).error, /no require/u);
	assert.match((await run("return workspace.read(\"/etc/hosts\");")).error, /outside the workspace/u);
	assert.match((await run("for (;;) {}", 1000)).error, /timed out after 1000 ms/u);
	assert.equal((await run("return 1 + 1;")).value, 2, "a realm again after one was stopped");
	await ask("files.delete", { "path": "scripted" });
});
