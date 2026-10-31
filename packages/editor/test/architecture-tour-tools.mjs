/**
 * Architecture tour, the agents' tools: the editor as data (its problems, notifications, rules, terminals, previews), the
 * workspace tools, the editor's trace logs, and the tools an agent decides with — the tests a change reaches, refactoring,
 * structural search and rewrite, a way in's reach, checkpoints, a change's problems against HEAD, git history — each
 * checked against what the live architecture view saw.
 *
 * One of the tour's shards, each in a session of its own so they run side by side (architecture-tour-session.mjs);
 * the diagram of what they saw together is architecture-diagram.mjs's.
 *
 *   node --test test/architecture-tour-tools.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { eventually, session, tour } from "./architecture-tour-session.mjs";

tour("architecture-tour-tools");

// What an agent reads, as data rather than off the DOM (debug-mcp's page tools, tools/): the editor in front of
// you, its problems, the notifications showing, the rules, the terminals' output and the preview windows.
test("agent tools: the editor, its problems, notifications, rules, terminals and previews — as data", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/agent.ts");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("const count: number = 'three';\nconst total = count + 1;\nconsole.log(total);\n"));

		const editor = await api.window.showTextDocument(uri);

		editor.selection = new api.Selection(1, 6, 1, 11);
	});

	try {
		const shown = await session.request("editor.state", undefined, 5000);

		assert.deepEqual({ "file": shown.active.file, "language": shown.active.language, "cursor": shown.active.cursor, "selections": shown.active.selections }, { "file": "agent.ts", "language": "typescript", "cursor": { "line": 2, "column": 12 }, "selections": [{ "start": { "line": 2, "column": 7 }, "end": { "line": 2, "column": 12 }, "text": "total" }] }, "1-based, as an agent reads code");
		assert.ok(shown.tabs.some((tab) => tab.file === "agent.ts" && tab.active), "its tab, active");

		// (TypeScript's error, whenever it lands — cspell may say something about the file first)
		const typeErrors = await eventually("its type error", async () => {
			const found = (await session.request("problems.list", { "file": "agent.ts" }, 5000)).problems.filter((problem) => problem.source === "ts");

			return found.length > 0 ? found : undefined;
		});

		assert.deepEqual(typeErrors.map(({ line, column, severity, code }) => ({ "line": line, "column": column, "severity": severity, "code": code })), [{ "line": 1, "column": 7, "severity": "error", "code": "2322" }]);

		// A run that can't start says why only in a toast.
		await workbench.evaluate(() => {
			void globalThis.__editor.api.commands.executeCommand("editor.debugFile", globalThis.__editor.api.Uri.file("/workspace/package.json"));
		});
		assert.ok((await eventually("the toast", async () => {
			const shownNow = await session.request("notifications.list", undefined, 5000);

			return shownNow.some((each) => each.message.includes("isn't a program")) ? shownNow : undefined;
		})).some((each) => each.severity === "error"));

		// (an id as a task's terminal has one — the architecture view folds it into terminal.in.*, whenever it sees it)
		await session.request("terminal.run", { "id": crypto.randomUUID(), "command": "echo from the terminal", "cwd": "/workspace" }, 10_000);
		assert.match(await eventually("its output", async () => (await session.request("terminal.state", undefined, 5000)).find((each) => each.command === "echo from the terminal" && each.output.includes("\nfrom the terminal"))?.output), /from the terminal/u);

		assert.ok(Array.isArray((await session.request("rules.state", undefined, 15_000)).rules), "the rules, each with its sentence");
		assert.ok(Array.isArray(await session.request("preview.windows", undefined, 5000)), "the preview windows");
	} finally {
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("notifications.clearAll");
			await api.commands.executeCommand("workbench.action.closeActiveEditor");
			await api.workspace.fs.delete(api.Uri.file("/workspace/agent.ts")).then(() => undefined, () => undefined);
		});
	}
});

// The workspace as an agent works in it (workspace-tools.ts; debug-mcp's files_* and git tools): a file written, edited
// by an exact string, read back numbered, found and searched, and its change as git's diff.
test("workspace tools: write, edit, read, find, search and diff", async () => {
	const request = (subject, data) => session.request(subject, data, 60_000);

	try {
		assert.deepEqual(await request("files.write", { "path": "agent/greet.js", "content": "function greet(name) {\n\treturn \"hello, \" + name;\n}\n\nconsole.log(greet(\"workspace\"));\n" }), { "path": "agent/greet.js", "created": true, "lines": 6 });

		// eslint-disable-next-line no-template-curly-in-string -- the program's text, a template literal in it
		assert.deepEqual(await request("files.edit", { "path": "agent/greet.js", "old": "\"hello, \" + name", "new": "`hello, ${name}!`" }), { "path": "agent/greet.js", "replaced": 1 });
		await assert.rejects(request("files.edit", { "path": "agent/greet.js", "old": "greet", "new": "hail" }), /2 times/u, "an ambiguous edit says so, and changes nothing");

		const read = await request("files.read", { "path": "/workspace/agent/greet.js", "offset": 2, "limit": 1 });

		// eslint-disable-next-line no-template-curly-in-string -- the program's text, a template literal in it
		assert.deepEqual([read.from, read.to, read.lines, read.content], [2, 2, 6, "2\t\treturn `hello, ${name}!`;"]);
		// eslint-disable-next-line no-template-curly-in-string -- the program's text, a template literal in it
		const edited = "function greet(name) {\n\treturn `hello, ${name}!`;\n}\n\nconsole.log(greet(\"workspace\"));\n";

		assert.equal(await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			return new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.file("/workspace/agent/greet.js")));
		}), edited, "the edit, saved");

		assert.deepEqual((await request("files.glob", { "pattern": "agent/**/*.js" })).files, ["agent/greet.js"]);
		assert.deepEqual((await request("files.grep", { "pattern": "greet\\(", "glob": "agent/**" })).matches.map(({ line }) => line), [1, 5]);
		assert.match((await request("git.diff", { "path": "agent/greet.js" })).diff, /^--- \/dev\/null\n\+\+\+ b\/agent\/greet\.js\n@@ -0,0 \+1,5 @@\n\+function greet/u);

		await assert.rejects(request("files.read", { "path": "../etc/passwd" }), /outside the workspace/u);
		await assert.rejects(request("files.read", { "path": "agent/nope" }));
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/agent"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// Replacing across files, all or nothing (workspace-tools.ts `files.replace`; agents' files_replace): one replacement
// that doesn't hold leaves every file as it was; then a change spanning two files is made as one edit, both saved.
test("workspace tools: a replacement across files, all or nothing", async () => {
	const request = (subject, data) => session.request(subject, data, 60_000);
	const disk = (path) => session.workbench().evaluate(async (file) => new TextDecoder().decode(await globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(`/workspace/${file}`))), path);

	try {
		await request("files.write", { "path": "spans/one.js", "content": "export const greeting = \"hello\";\n" });
		await request("files.write", { "path": "spans/two.js", "content": "import { greeting } from \"./one.js\";\n\nconsole.log(greeting, greeting);\n" });

		await assert.rejects(request("files.replace", { "edits": [
			{ "path": "spans/one.js", "old": "\"hello\"", "new": "\"hi\"" },
			{ "path": "spans/two.js", "old": "greeting, greeting", "new": "greeting", "count": 2 }
		] }), /nothing was changed: edit 2: its text is in spans\/two\.js 1 times, not 2/u);
		assert.equal(await disk("spans/one.js"), "export const greeting = \"hello\";\n", "untouched: one replacement didn't hold");

		const done = await request("files.replace", { "edits": [
			{ "path": "spans/one.js", "old": "greeting", "new": "salute", "all": true },
			{ "path": "spans/two.js", "old": "greeting", "new": "salute", "all": true }
		] });

		assert.deepEqual([done.replaced, done.files.map(({ path, replaced }) => [path, replaced])], [4, [["spans/one.js", 1], ["spans/two.js", 3]]]);
		assert.equal(await disk("spans/two.js"), "import { salute } from \"./one.js\";\n\nconsole.log(salute, salute);\n", "both saved");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/spans"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// VS Code's own trace, for one component (editor-state.ts `editor.trace`; agents' editor_trace): the text file model's,
// while an agent's edit saves — what it said at trace, in the editor's log stream.
test("editor trace: a component's trace log, for a while, in the log stream", async () => {
	const request = (subject, data) => session.request(subject, data, 60_000);

	try {
		await request("files.write", { "path": "traced/note.js", "content": "export const note = 1;\n" });

		const started = await request("editor.trace", { "component": "text file model", "seconds": 20 });

		assert.equal(started.tracing, "text file model");
		await assert.rejects(request("editor.trace", { "component": "extension host", "seconds": 5 }), /a trace is going until/u, "one at a time");
		await request("files.edit", { "path": "traced/note.js", "old": "= 1", "new": "= 2" });

		const said = await eventually("the text file model's save, at trace", () => session.notable().filter((line) => line.includes("[text file model]") && line.includes("doSave")).slice(0, 3).join("\n") || undefined, 20_000);

		assert.match(said, /traced\/note\.js|doSave/u);
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/traced"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// Tests for agents (test-runs.ts; runs_affected, runs_tests): a test file nobody's run is untraced; run, each test's
// result is data (a failed assertion's sides); its traces then say which tests reach the code, until an edit makes them
// stale, and running the stale ones says how each came out before.
test("test runs: which tests a change reaches, and their results as data", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);

	try {
		await request("files.write", { "path": "checks/sum.js", "content": "export function sum(a, b) {\n\treturn a + b;\n}\n" });
		await request("files.write", { "path": "checks/sum.test.js", "content": "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { sum } from \"./sum.js\";\n\ntest(\"adds\", () => {\n\tassert.equal(sum(1, 2), 3);\n});\n\ntest(\"is wrong\", () => {\n\tassert.equal(sum(1, 1), 3);\n});\n" });

		assert.ok((await request("tests.affected", { "paths": ["checks/sum.js"] })).untraced.includes("checks/sum.test.js"), "never run: untraced");

		const first = await request("tests.run", { "files": ["checks/sum.test.js"] });
		const [file] = first.files;

		assert.equal(file.exitCode, 1, JSON.stringify(first));
		assert.deepEqual(file.tests.map(({ id, outcome }) => [id, outcome]), [["checks/sum.test.js › adds", "pass"], ["checks/sum.test.js › is wrong", "fail"]]);
		assert.deepEqual(file.tests[1].assertion, { "actual": "2", "expected": "3", "operator": "==" }, "the failed assertion's sides");
		assert.ok(file.tests.every((test) => typeof test.ms === "number"), "each test's time");
		assert.deepEqual(first.counts, { "files": 1, "pass": 1, "fail": 1, "skip": 0 });

		// (the Margin keeps the run's traces as it ends: once they're there, they say which tests reach sum.js)
		const traced = await eventually("the tests' traces on sum.js", async () => {
			const answer = await request("tests.affected", { "paths": ["checks/sum.js"] });

			return answer.tests.length === 2 ? answer : undefined;
		}, 60_000);

		assert.deepEqual(traced.tests.map(({ id, outcome, stale }) => [id, outcome, stale]), [["checks/sum.test.js › adds", "pass", false], ["checks/sum.test.js › is wrong", "fail", false]]);
		assert.ok(!traced.untraced.includes("checks/sum.test.js"));

		await request("files.edit", { "path": "checks/sum.js", "old": "return a + b;", "new": "return a + b + 0;" });

		const edited = await request("tests.affected", { "paths": ["checks/sum.js"] });

		assert.ok(edited.tests.every((test) => test.stale), "sum changed under them: " + JSON.stringify(edited.tests));

		const again = await request("tests.run", { "files": ["checks/sum.test.js"] });

		assert.deepEqual(again.files[0].tests.map(({ outcome, before }) => [outcome, before]), [["pass", "pass"], ["fail", "fail"]], "how each came out before");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/checks"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// Refactoring for agents (code-refactor.ts; code_references, code_rename, code_move): a function found where it's used,
// renamed everywhere, and its file moved with both importers' imports kept right — each file saved.
test("refactoring: references, a rename everywhere, and a move with its imports", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);
	const disk = (path) => session.workbench().evaluate(async (file) => {
		const { api } = globalThis.__editor;

		return Promise.resolve(api.workspace.fs.readFile(api.Uri.file(`/workspace/${file}`))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
	}, path);

	try {
		await request("files.write", { "path": "ref/geometry.ts", "content": "export function area(r: number): number {\n\treturn 3 * r * r;\n}\n" });
		await request("files.write", { "path": "ref/use.ts", "content": "import { area } from \"./geometry\";\n\nexport const four = area(2);\n" });
		await request("files.write", { "path": "ref/also.ts", "content": "import { area } from \"./geometry\";\n\nexport const nine = area(3);\n" });

		const found = await request("code.references", { "path": "ref/geometry.ts", "line": 1, "name": "area" });

		assert.deepEqual(found.places.map(({ file, line }) => `${file}:${String(line)}`).sort(), ["ref/also.ts:1", "ref/also.ts:3", "ref/geometry.ts:1", "ref/use.ts:1", "ref/use.ts:3"], JSON.stringify(found));

		const renamed = await request("code.rename", { "path": "ref/geometry.ts", "line": 1, "name": "area", "to": "areaOf" });

		assert.deepEqual(renamed.files.sort(), ["ref/also.ts", "ref/geometry.ts", "ref/use.ts"]);
		assert.equal(await disk("ref/use.ts"), "import { areaOf } from \"./geometry\";\n\nexport const four = areaOf(2);\n", "renamed, and saved");

		const moved = await request("code.move", { "from": "ref/geometry.ts", "to": "ref/shapes/geometry.ts" });

		assert.deepEqual(moved.updated.sort(), ["ref/also.ts", "ref/use.ts"], JSON.stringify(moved));
		assert.equal(await disk("ref/geometry.ts"), undefined, "gone from where it was");
		assert.match(await disk("ref/shapes/geometry.ts"), /export function areaOf/u);
		assert.match(await disk("ref/use.ts"), /from "\.\/shapes\/geometry"/u, "its importer follows it");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/ref"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// Structural search and rewrite (patterns.ts, history's `_history.query`; code_query, code_rewrite): one shape written
// two ways found in two files, its rewrite previewed, then made.
test("structural search: a shape found however it's spelled, and rewritten", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);
	const disk = (path) => session.workbench().evaluate(async (file) => new TextDecoder().decode(await globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(`/workspace/${file}`))), path);

	try {
		await request("files.write", { "path": "shape/one.ts", "content": "export const has = (list: string[], item: string): boolean => list.indexOf(item) !== -1;\n" });
		await request("files.write", { "path": "shape/two.ts", "content": "const names = ['a', 'b'];\n\nexport const found = names.indexOf( 'a' )   !==   -1; // spaced out\nexport const position = names.indexOf('b');\n" });

		const query = await request("code.query", { "pattern": "$A.indexOf($B) !== -1", "paths": ["shape"] });

		assert.deepEqual(query.matches.map(({ file, line, bindings }) => [file, line, bindings]), [["shape/one.ts", 1, { "A": "list", "B": "item" }], ["shape/two.ts", 3, { "A": "names", "B": "'a'" }]], JSON.stringify(query));

		const preview = await request("code.rewrite", { "pattern": "$A.indexOf($B) !== -1", "replace": "$A.includes($B)", "paths": ["shape"], "preview": true });

		assert.equal(preview.changes, 2);
		assert.match(preview.diff, /\+export const found = names\.includes\('a'\); \/\/ spaced out/u);
		assert.match(await disk("shape/two.ts"), /indexOf\( 'a' \)/u, "a preview changes nothing");

		const done = await request("code.rewrite", { "pattern": "$A.indexOf($B) !== -1", "replace": "$A.includes($B)", "paths": ["shape"] });

		assert.deepEqual(done.files.sort(), ["shape/one.ts", "shape/two.ts"]);
		assert.equal(await disk("shape/one.ts"), "export const has = (list: string[], item: string): boolean => list.includes(item);\n");
		// (the save's ESLint fix may requote it: either quotes)
		assert.match(await disk("shape/two.ts"), /names\.indexOf\(["']b["']\)/u, "a different shape left alone");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/shape"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// What a way in reaches (code-reach.ts, History's ledger.ts `history.reach`; agents' code_reach): an agent tool made in
// the workspace, the file that names it, and what removing it would free.
test("code reach: a way in's registration, what names it, and what removing it frees", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);

	try {
		await request("files.write", { "path": "reach/tools.ts", "content": "export const greeting = {\n\t\"name\": \"reach_greet\",\n\t\"description\": \"Say hello.\",\n\t\"handler\": () => hello()\n};\n\nfunction hello(): string {\n\treturn \"hello\";\n}\n" });
		await request("files.write", { "path": "reach/use.ts", "content": "export const asked = [\"reach_greet\"];\n" });

		let last;
		const answer = await eventually("History's reading of reach_greet", async () => {
			last = await request("code.reach", { "target": "reach_greet" });

			return last.way === undefined ? undefined : last;
		}, 120_000).catch(async (error) => {
			// (what the TypeScript server's plugin reads, which History's reading is)
			const server = await session.workbench().evaluate(async () => {
				const { api } = globalThis.__editor;
				const read = await Promise.resolve(api.commands.executeCommand("typescript.tsserverRequest", "_history.read", { "root": "/workspace", "known": {} })).catch((failed) => ({ "failed": String(failed) }));

				return { "ready": read?.body?.ready, "paths": (read?.body?.paths ?? []).filter((path) => path.startsWith("reach/")), "count": (read?.body?.paths ?? []).length, "failed": read?.failed };
			});

			throw new Error(`${error.message}: History last said ${JSON.stringify(last)}; the server's plugin reads ${JSON.stringify(server)}`);
		});

		assert.deepEqual(answer.way, { "key": "agent tool|reach_greet", "facet": "agent tool", "id": "reach_greet", "sides": answer.way.sides }, JSON.stringify(answer));
		assert.deepEqual(answer.registered, ["reach/tools.ts:1"]);
		assert.deepEqual(answer.named.map(({ file, line }) => [file, line]), [["reach/use.ts", 1]], "where it's named, its registration aside");
		assert.ok(answer.frees.declarations >= 1, "removing it frees its code: " + JSON.stringify(answer.frees));
		assert.deepEqual((await request("code.reach", { "target": "no_such_way" })).matches, [], "no way in by that name");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/reach"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// What's been decided about a file or a name (code-reach.ts, History's ledger.ts `history.decisions`; agents'
// decisions_for): a ledger entry whose paths hold the file, and a doc's line naming it, under its heading. The
// workspace's own ledger is put back as it was.
test("decisions: a file's ledger entries, and the docs' lines naming it", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);
	const LEDGER = ".silo/features.json";
	const before = await session.workbench().evaluate(async (path) => {
		const { api } = globalThis.__editor;

		return Promise.resolve(api.workspace.fs.readFile(api.Uri.file(`/workspace/${path}`))).then((bytes) => new TextDecoder().decode(bytes), () => null);
	}, LEDGER);

	try {
		const entries = before === null ? {} : JSON.parse(before);

		await request("files.write", { "path": LEDGER, "content": JSON.stringify({ ...entries, "decided greeting": { "status": "parked", "why": "until the greeting has a reader", "since": "2026-10-30", "paths": ["decided/"] } }, undefined, 2) + "\n" });
		await request("files.write", { "path": "decided/greet.ts", "content": "export const greet = (): string => \"hello\";\n" });
		await request("files.write", { "path": "decided/NOTES.md", "content": "# Decided\n\n## Greeting\n\ngreet.ts stays as it is until something reads it.\n" });

		let last;
		const answer = await eventually("the doc's line naming greet.ts", async () => {
			last = await request("decisions.for", { "target": "decided/greet.ts" });

			return last.docs?.some(({ doc }) => doc === "decided/NOTES.md") === true ? last : undefined;
		}, 120_000).catch((error) => {
			throw new Error(`${error.message}: History last said ${JSON.stringify(last)}`);
		});

		assert.deepEqual(answer.ledger.map(({ name, status, why }) => [name, status, why]), [["decided greeting", "parked", "until the greeting has a reader"]], "the entry whose paths hold it");
		assert.deepEqual(answer.docs.filter(({ doc }) => doc === "decided/NOTES.md").map(({ line, heading, text }) => [line, heading, text]), [[5, "Greeting", "greet.ts stays as it is until something reads it."]], "the line naming it, under its heading");
		assert.deepEqual((await request("decisions.for", { "target": "nothing_decided_here" })).ledger, [], "nothing decided about a name nothing names");
	} finally {
		await session.workbench().evaluate(async ({ path, text }) => {
			const { api } = globalThis.__editor;
			const uri = api.Uri.file(`/workspace/${path}`);

			await (text === null ? api.workspace.fs.delete(uri) : api.workspace.fs.writeFile(uri, new TextEncoder().encode(text))).then(() => undefined, () => undefined);
			await api.workspace.fs.delete(api.Uri.file("/workspace/decided"), { "recursive": true }).then(() => undefined, () => undefined);
		}, { "path": LEDGER, "text": before });
	}
});

// How a commit did in CI (ci-status.ts; agents' ci_status): with no github.com origin, it says so, and with no commit;
// with one, the shell
// asks GitHub (github.actions), signed out here, so with no credential — and GitHub's refusal of a repository that
// isn't there (or its anonymous rate limit) comes back said, with why. The workspace's git config is put back.
test("ci status: a workspace's commit asked of GitHub Actions, and a refusal said with why", async () => {
	const request = (subject, data) => session.request(subject, data, 120_000);
	const CONFIG = ".git/config";
	const config = (text) => session.workbench().evaluate(async ({ path, next }) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(`/workspace/${path}`);
		const before = await Promise.resolve(api.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => null);

		if (next !== undefined) {
			await (next === null ? api.workspace.fs.delete(uri) : api.workspace.fs.writeFile(uri, new TextEncoder().encode(next))).then(() => undefined, () => undefined);
		}

		return before;
	}, { "path": CONFIG, "next": text });
	const before = await config(undefined);

	await assert.rejects(request("ci.status", {}), /no github\.com origin/u, "no origin: said");

	try {
		await config(`${before ?? ""}\n[remote "origin"]\n\turl = https://github.com/brianjenkins94/no-such-repository-for-the-tour.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);

		// (the tour's workspace has no commit of its own: HEAD can't be the default, so a commit is named)
		await assert.rejects(request("ci.status", {}), /no commit yet/u, "no HEAD: said");

		const commit = "f".repeat(40);
		const answer = await request("ci.status", { "commit": commit });

		assert.equal(answer.repository, "brianjenkins94/no-such-repository-for-the-tour", JSON.stringify(answer));
		assert.equal(answer.commit, commit);
		assert.match(answer.error, /signed out .* sign in with GitHub/u, JSON.stringify(answer));
	} finally {
		await config(before);
	}
});

// Experiments that undo themselves (checkpoints.ts; workspace_checkpoint, workspace_restore): the working tree noted,
// a file edited, one deleted and one made, a replacement previewed without changing anything, and all of it put back.
test("checkpoints: a change tried, previewed, and put back as it was", async () => {
	const request = (subject, data) => session.request(subject, data, 60_000);
	const disk = (path) => session.workbench().evaluate(async (file) => {
		const { api } = globalThis.__editor;

		return Promise.resolve(api.workspace.fs.readFile(api.Uri.file(`/workspace/${file}`))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
	}, path);

	try {
		await request("files.write", { "path": "tried/edited.js", "content": "export const value = 1;\n" });
		await request("files.write", { "path": "tried/kept.js", "content": "export const kept = true;\n" });

		const { id } = await request("workspace.checkpoint", { "label": "before the experiment" });

		await request("files.edit", { "path": "tried/edited.js", "old": "= 1", "new": "= 2" });
		await request("files.write", { "path": "tried/made.js", "content": "export const made = true;\n" });
		await session.workbench().evaluate(() => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file("/workspace/tried/kept.js")));

		const preview = await request("files.replace", { "edits": [{ "path": "tried/edited.js", "old": "= 2", "new": "= 3" }], "preview": true });

		assert.match(preview.diff, /-export const value = 2;\n\+export const value = 3;/u);
		assert.equal(await disk("tried/edited.js"), "export const value = 2;\n", "a preview changes nothing");

		const restored = await request("workspace.restore", { "id": id });

		assert.deepEqual([restored.restored, restored.removed], [["tried/edited.js", "tried/kept.js"], ["tried/made.js"]], JSON.stringify(restored));
		assert.deepEqual([await disk("tried/edited.js"), await disk("tried/kept.js"), await disk("tried/made.js")], ["export const value = 1;\n", "export const kept = true;\n", undefined]);
		await assert.rejects(request("workspace.restore", { "id": "nope" }), /no checkpoint nope here/u);
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/tried"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// A script (script-run.ts; agents' script_run): JavaScript for the counting a script is for, the workspace read-only, in the
// capability-gated realm — what it read and what it was refused, said; no require, nothing outside the workspace; and an
// endless one stopped, the realm made again for the next.
test("script run: a count over the workspace's files, and what it touched — the network refused", async () => {
	const workbench = session.workbench();
	const request = (subject, args) => session.request(subject, args, 60_000);

	await request("files.write", { "path": "scripted/a.json", "content": "{ \"n\": 2 }\n" });
	await request("files.write", { "path": "scripted/b.json", "content": "{ \"n\": 3 }\n" });

	try {
		const counted = await request("script.run", { "code": "const files = await workspace.glob(\"scripted/*.json\");\nlet total = 0;\n\nfor (const file of files) {\n\ttotal += (await workspace.json(file)).n;\n}\n\nconsole.log(\"files\", files.length);\n\nreturn { files, total };" });

		assert.deepEqual(counted.value, { "files": ["scripted/a.json", "scripted/b.json"], "total": 5 }, JSON.stringify(counted));
		assert.deepEqual(counted.logs, ["files 2"]);
		assert.deepEqual([counted.touched.read, counted.touched.globs, counted.touched.refused], [["scripted/a.json", "scripted/b.json"], ["scripted/*.json"], []]);

		const fetched = await request("script.run", { "code": "try {\n\tawait fetch(\"https://example.com/\");\n} catch (error) {\n\treturn error.message;\n}" });

		assert.match(fetched.value, /capability 'net:\*' is not available/u, JSON.stringify(fetched));
		assert.deepEqual(fetched.touched.refused, ["net:*"]);
		assert.match((await request("script.run", { "code": "return require(\"node:fs\");" })).error, /no require/u);
		assert.match((await request("script.run", { "code": "return workspace.read(\"/etc/hosts\");" })).error, /outside the workspace/u);
		assert.match((await request("script.run", { "code": "for (;;) {}", "timeoutMs": 1000 })).error, /timed out after 1000 ms/u);
		assert.equal((await request("script.run", { "code": "return 1 + 1;" })).value, 2, "a realm again after one was stopped");
	} finally {
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/scripted"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// A change's problems against HEAD (code-problems.ts; agents' code_problems): a file committed with one error, then
// changed so it clears that one and breaks the file importing it, while that file's own error stays. (It commits, so it
// runs last but the conformance check: the workspace has no HEAD before it.)
test("code problems: what a change adds and clears, against HEAD", async () => {
	const request = (subject, data) => session.request(subject, data, 240_000);

	try {
		await request("files.write", { "path": "problems/math.ts", "content": "export function double(n: number): number {\n\treturn n * 2;\n}\n\nexport const wrong: number = \"x\";\n" });
		await request("files.write", { "path": "problems/use.ts", "content": "import { double } from \"./math\";\n\nexport const four = double(2);\nexport const bad: string = 1;\n" });
		await request("git.commit", { "message": "problems: the baseline", "files": [{ "path": "problems/math.ts" }, { "path": "problems/use.ts" }] });
		await request("files.write", { "path": "problems/math.ts", "content": "export function double(text: string): string {\n\treturn text + text;\n}\n" });

		const answer = await request("code.problems", { "paths": ["problems"] });
		const brief = (problem) => [problem.file, problem.source, problem.code, problem.line];

		assert.deepEqual(answer.checked.typescript, ["problems/math.ts", "problems/use.ts"], JSON.stringify(answer));
		assert.deepEqual(answer.added.filter(({ source }) => source === "ts").map(brief), [["problems/use.ts", "ts", 2345, 3]], "the importer's call breaks");
		assert.deepEqual(answer.cleared.filter(({ source }) => source === "ts").map(brief), [["problems/math.ts", "ts", 2322, 5]], "math.ts's own error goes, where HEAD had it");
		assert.ok(answer.counts.unchanged >= 1, "use.ts's `bad` was there before: " + JSON.stringify(answer.counts));
		assert.ok(answer.checked.eslint.includes("problems/math.ts"), "ESLint read both sides");
		// (asked again, the same: HEAD's language service gave the project's documents back as it found them)
		assert.deepEqual((await request("code.problems", { "paths": ["problems"] })).counts, answer.counts);
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/problems"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// History for agents (git-service.ts; git_log, git_show, git_blame): a file committed twice and edited again, its log,
// the file as its first commit had it, and which commit (or the working tree) each line is from.
test("git history: a file's log, a revision of it, and its blame", async () => {
	const request = (subject, data) => session.request(subject, data, 120_000);

	try {
		await request("files.write", { "path": "history/notes.ts", "content": "export const a = 1;\nexport const b = 2;\n" });
		const first = await request("git.commit", { "message": "history: notes", "files": [{ "path": "history/notes.ts" }] });

		await request("files.edit", { "path": "history/notes.ts", "old": "export const b = 2;", "new": "export const b = 3;\nexport const c = 4;" });
		const second = await request("git.commit", { "message": "history: b and c", "files": [{ "path": "history/notes.ts" }] });

		await request("files.edit", { "path": "history/notes.ts", "old": "export const c = 4;", "new": "export const c = 5;" });

		const log = await request("git.log", { "path": "history/notes.ts" });

		assert.deepEqual(log.commits.map(({ oid, message }) => [oid, message]), [[second.oid, "history: b and c"], [first.oid, "history: notes"]], JSON.stringify(log));
		assert.equal((await request("git.show", { "path": "history/notes.ts", "rev": first.oid.slice(0, 8) })).content, "export const a = 1;\nexport const b = 2;\n", "the file at its first commit");

		const blame = await request("git.blame", { "path": "history/notes.ts" });

		assert.deepEqual(blame.runs.map(({ from, to, commit }) => [from, to, commit]), [[1, 1, first.oid.slice(0, 8)], [2, 2, second.oid.slice(0, 8)], [3, 3, "working"]], JSON.stringify(blame));
		assert.equal(blame.runs[1].message, "history: b and c");
	} finally {
		await session.workbench().evaluate(async () => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file("/workspace/history"), { "recursive": true }).then(() => undefined, () => undefined);
		});
	}
});

// cspell checks code with cspell's own dictionaries for it (extensions/cspell/dictionaries.ts): code words — TypeScript's,
// Node's, npm's, software terms — aren't flagged, a misspelling is; and an edit keeps the file's language, so they stay
// unflagged after one.
test("cspell: code words pass, a misspelling doesn't — after an edit too", async () => {
	const workbench = session.workbench();
	const file = "/workspace/spelling.ts";
	const flagged = () => workbench.evaluate((path) => globalThis.__editor.api.languages.getDiagnostics(globalThis.__editor.api.Uri.file(path)).filter((diagnostic) => diagnostic.source === "cspell").map((diagnostic) => diagnostic.message), file);

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode("import { readdirSync } from \"node:fs\";\n\n// Read the README's config, as JSON: a mispelled word here.\nexport const entries = readdirSync(\".\").filter((name) => name.endsWith(\".json\"));\n"));
		await api.window.showTextDocument(api.Uri.file(path));
	}, file);

	try {
		const first = await eventually("cspell's word on it", async () => ((await flagged()).length > 0 ? flagged() : undefined), 60_000);

		assert.deepEqual(first, ["Unknown word: \"mispelled\""], "only the misspelling: " + JSON.stringify(first));

		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;
			const editor = api.window.visibleTextEditors.find((each) => each.document.uri.path === path);

			await editor.edit((builder) => {
				builder.insert(new api.Position(4, 0), "export const tsconfig = \"tsconfig.json\";\n");
			});
		}, file);
		await eventually("cspell's word after the edit", async () => {
			const after = await flagged();

			return after.length === 1 && after[0] === "Unknown word: \"mispelled\"" ? after : undefined;
		}, 30_000);
	} finally {
		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
			await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
		}, file);
	}
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
