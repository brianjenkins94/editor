/**
 * Architecture tour, what a run leaves: Run from every button, a debug session as a run, runtime evidence, live values
 * and live runs, a value set or mocked, the margin's projections, a crash's mark, the types plugin — and notes, search,
 * and the stores and components all of that is discovered from — each checked against what the live architecture view
 * saw.
 *
 * One of the tour's shards, each in a session of its own so they run side by side (architecture-tour-session.mjs);
 * the diagram of what they saw together is architecture-diagram.mjs's.
 *
 *   node --test test/architecture-tour-runs.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { alive, hasLabel } from "./architecture-harness.mjs";
import { eventually, inRuleView, session, tour } from "./architecture-tour-session.mjs";

tour("architecture-tour-runs");

// A task — `node <file>` that runs to completion — runs under the tsval debugger (the debug worker), and a
// capability-gated call pauses it.
test("node script: a task runs under the tsval debugger", async () => {
	await session.terminal(`echo "require('fs').writeFileSync('/workspace/tour-out.txt', 'tour');" > tour.js && node tour.js`, { "fresh": true });
	await session.until("the debug worker", alive("debug-worker"));
	// (its worker joins the bridge through the workspace runtime's link: the debug protocol itself is the adapter's messages)
	await session.until("the debug worker joined", hasLabel("bridge", "debug-worker", /^bridge\.ready$/u));

	// One run, one id: the registry's run is the debug session's (its launch config carries it).
	const run = await eventually("the run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title === "node tour.js" && each.state === "running"));
	const sessionRun = await session.workbench().evaluate(() => globalThis.__editor.api.debug.activeDebugSession?.configuration.__runId);

	assert.equal(sessionRun, run.id, "the session carries the registry's run id");
});

// A session VS Code starts itself (F5, Run and Debug, debug_start) is a run in the registry too, ended with the session.
// Run (RUNNING.md): one way in. The shell's ▷ (its "The file in the editor"), its left rail's Run and the editor's ▷
// all run the file in the editor, the same way — a run each; a file that isn't a program says why. And a run has Node's
// globals, not only ECMAScript's.
test("run: one way in from every button, and a file that isn't a program says why", async () => {
	const workbench = session.workbench();
	const program = "/workspace/oneway.js";
	const runsOf = async () => (await session.request("runs.list", undefined, 5000)).filter((run) => run.title.endsWith("oneway.js") && run.state === "exited").length;
	const ranAgain = async (what, before) => eventually(what, async () => ((await runsOf()) > before || undefined));
	const shown = (path) => workbench.evaluate((file) => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file(file)), path);

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode("console.log(\"ran\", new URL(\"https://x.dev/a?b=1\").searchParams.get(\"b\"), Buffer.from(\"hi\").toString(\"base64\"), new TextEncoder().encode(\"é\").length);\n"));
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/notes.md"), new TextEncoder().encode("# notes\n"));
	}, program);

	try {
		const ran = await session.request("debug.start", { "program": program }, 60_000);

		assert.deepEqual(ran.output, ["ran 1 aGk= 2"], "URL, Buffer and TextEncoder, as Node has them");

		// The shell's ▷: its first item.
		await shown(program);

		let before = await runsOf();

		await session.page.locator("wa-button[aria-label=\"Run\"]").click();
		await session.page.getByRole("menuitem", { "name": "The file in the editor" }).click();
		await ranAgain("the shell's ▷ ran it", before);

		// The editor's ▷.
		before = await runsOf();
		await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.debugFile"));
		await ranAgain("the editor's ▷ ran it", before);

		// The left rail's Run (the project panel collapsed to it — as it's left, or collapsed for this).
		before = await runsOf();

		const rail = session.page.locator("wa-button[aria-label=\"Run the file in the editor\"]");
		const collapsed = await rail.count() > 0;

		if (!collapsed) {
			await session.page.locator("wa-button[aria-label=\"Toggle project panel\"]").click();
		}

		await rail.click();
		await ranAgain("the left rail's Run ran it", before);

		if (!collapsed) {
			await session.page.locator("wa-button[aria-label=\"Toggle project panel\"]").click();
		}

		// Not a program: why, in the workbench.
		await shown("/workspace/notes.md");
		await assert.rejects(session.request("debug.start", {}, 30_000), /notes\.md isn't a program/u);
		assert.match(await eventually("why, in a notification", () => workbench.evaluate(() => [...document.querySelectorAll(".notification-toast")].map((toast) => toast.textContent).find((text) => text.includes("Couldn't run")))), /notes\.md isn't a program/u);
	} finally {
		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("notifications.clearAll");
			await api.commands.executeCommand("workbench.action.closeAllEditors");

			for (const file of [path, "/workspace/notes.md"]) {
				await api.workspace.fs.delete(api.Uri.file(file)).then(() => undefined, () => undefined);
			}
		}, program);
	}
});

test("debug session: one VS Code starts is a run, known by the same id", async () => {
	await session.terminal(`echo "console.log('f5');" > f5.js`, { "fresh": true });
	await session.request("debug.start", { "program": "/workspace/f5.js" }, 60_000);

	const run = await eventually("its run, ended", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title.endsWith("f5.js") && each.state === "exited"));

	assert.deepEqual(run.origin, { "other": "Run and Debug" });
	assert.match(run.id, /^[0-9a-f-]{36}$/u, "a UUID: records outlive the page");

	// Its envelope, in .silo/runs/<user>.jsonl: whose, where, on what code.
	const envelope = await eventually("its envelope", () => session.workbench().evaluate(async (id) => {
		const { api } = globalThis.__editor;
		const folder = api.Uri.file("/workspace/.silo/runs");
		const entries = await api.workspace.fs.readDirectory(folder).then((found) => found, () => []);

		for (const [name] of entries) {
			const text = new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.joinPath(folder, name)));
			const line = text.split("\n").find((each) => each.includes(id));

			if (line !== undefined) {
				return JSON.parse(line);
			}
		}

		return undefined;
	}, run.id));

	assert.equal(envelope.entry, "f5.js");
	assert.equal(envelope.environment.runtime, "tsval");
	assert.match(envelope.environment.engine, /^chromium-\d+$/u);
	assert.match(envelope.files["f5.js"], /^[0-9a-f]{40}$/u, "the blob oid of the code that ran");

	// What it observed: its coverage, keyed on BABLR spans, in .silo/evidence/<user>/<environment>/f5.js.jsonl.
	const evidence = await eventually("its coverage, as evidence", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const find = async (folder) => {
			for (const [name, type] of await api.workspace.fs.readDirectory(folder).then((found) => found, () => [])) {
				const child = api.Uri.joinPath(folder, name);

				if (type === api.FileType.Directory) {
					const found = await find(child);

					if (found !== undefined) {
						return found;
					}
				} else if (name === "f5.js.jsonl") {
					return { "path": child.path, "text": new TextDecoder().decode(await api.workspace.fs.readFile(child)) };
				}
			}

			return undefined;
		};

		const found = await find(api.Uri.file("/workspace/.silo/evidence"));
		const attributes = await api.workspace.fs.readFile(api.Uri.file("/workspace/.silo/.gitattributes")).then((bytes) => new TextDecoder().decode(bytes), () => "");

		return found === undefined ? undefined : { ...found, "attributes": attributes };
	}));
	const lines = evidence.text.trim().split("\n").map((line) => JSON.parse(line));

	assert.match(evidence.path, /\/\.silo\/evidence\/[^/]+\/default\.tsval\.chromium-\d+\.[a-z]+\/f5\.js\.jsonl$/u);
	assert.ok(lines.some((line) => line.kind === "reached" && line.key === "bablr1" && line.ever === 1 && line.lastRun === run.id), "the statement that ran, on its span");
	assert.match(evidence.attributes, /^\*\.jsonl merge=union$/mu);

	// In git: nothing excludes .silo/ any more, and its own .gitignore keeps only local/ on the machine.
	const { exclude, ignore } = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const text = (path) => api.workspace.fs.readFile(api.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => "");

		return { "exclude": await text("/workspace/.git/info/exclude"), "ignore": await text("/workspace/.silo/.gitignore") };
	});

	assert.doesNotMatch(exclude, /^\.silo\/$/mu, "the runs and their evidence go in git");
	assert.match(ignore, /^\/local\/$/mu, "what stays on the machine — anchored, so evidence/local/ (a user named local) is kept");

	// BABLR's work, kept by content on this machine: f5.js's parse, in the BABLR worker's own IndexedDB (not the
	// workspace), keyed by parse version and blob oid — and nothing left of the caches earlier builds kept in the workspace.
	const cache = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const list = (path) => api.workspace.fs.readDirectory(api.Uri.file(path)).then((found) => found.map(([name]) => name), () => []);
		const keys = await new Promise((resolve) => {
			const open = indexedDB.open("bablr");

			open.onsuccess = () => {
				const request = open.result.transaction("cst").objectStore("cst").getAllKeys();

				request.onsuccess = () => {
					resolve(request.result);
				};

				request.onerror = () => {
					resolve([]);
				};
			};

			open.onerror = () => {
				resolve([]);
			};
		});

		return { "keys": keys, "spans": await list("/workspace/.silo/local/bablr/spans"), "git": await list("/workspace/.git/bablr") };
	});

	assert.ok(cache.keys.some((key) => /^[0-9a-f]{12}\/[0-9a-f]{40}$/u.test(key)), "a text's parse, by parse version and blob oid");
	assert.deepEqual([cache.spans, cache.git], [[], []], "nothing left in the workspace's old caches");

	// What an extension gets from the editor's BABLR (the event sheet anchors its parts this way): a reference to the
	// span standing for a range — here, f5.js's one statement — and, after an edit above it, where that span is now by
	// its id alone (as the evidence marks are found).
	const { ref, found } = await session.workbench().evaluate(async () => {
		const { commands } = globalThis.__editor.api;
		const [made] = (await commands.executeCommand("editor.annotations.refer", "console.log('f5');\n", "f5.js", [{ "start": 0, "end": 18 }])).value;
		const [where] = (await commands.executeCommand("editor.annotations.resolve", "// above\nconsole.log('f5');\n", "f5.js", [made], { "observed": true })).value;

		return { "ref": made, "found": where };
	});

	assert.match(ref?.span ?? "", /^[0-9a-f]{16}(?:#\d+)?$/u, "a spanAnchors id");
	assert.equal(ref.file, "f5.js");
	assert.deepEqual([found?.status, found?.candidate?.start], ["attached", 9], "found by its id, moved down a line");

	// Shown from the evidence: open the file and edit another line — the session's marks drop, the evidence's follow the
	// statement's span; edit the statement itself, and its mark goes until it runs again.
	const workbench = session.workbench();
	// Coverage's marks, in the notes margin's strip (coverage.ts): the gutter is the breakpoints'.
	const marks = () => workbench.evaluate(() => document.querySelectorAll(".notes-margin-mark.coverage-ran, .notes-margin-mark.coverage-partial, .notes-margin-mark.coverage-missed").length);
	const edit = (change) => workbench.evaluate(async (what) => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/f5.js"));

		await editor.edit((builder) => {
			if (what === "append") {
				builder.insert(new api.Position(editor.document.lineCount, 0), "\n// unrelated\n");
			} else {
				builder.replace(editor.document.lineAt(0).range, "console.log('f6');");
			}
		});
	}, change);

	// (Live runs off: one would run the edited file again at once, and its coverage is what the margin would show.)
	const liveRuns = (on) => workbench.evaluate((value) => globalThis.__editor.api.workspace.getConfiguration("run").update("liveRuns", value, true), on);

	await liveRuns(false);
	await edit("append");
	await eventually("the evidence's mark, after an unrelated edit", async () => (await marks()) > 0 || undefined);
	await edit("statement");
	await eventually("no mark on the edited statement", async () => (await marks()) === 0 || undefined);
	await liveRuns(undefined);
});

// What went through a run's ?., ??, parameters, returns and branches (RUNTIME-EVIDENCE.md, the second slice): folded
// into the same evidence file as its coverage, each site under the span that is exactly its node — and the values
// themselves only on this machine, in .silo/local/samples/.
// The program's other files that ran are evidence too (packages/tsval/README.md, *Modules*): each its own file under .silo/evidence, read
// against the source that ran, and listed in the run's envelope.
test("evidence: a file the program imports gets its own", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const write = (path, lines) => api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(lines.join("\n")));

		await write("/workspace/scale.js", ["function scale(value, by) {", "\treturn value * (by ?? 2);", "}", "module.exports = { scale };", ""]);
		await write("/workspace/scaled.js", ["const { scale } = require(\"./scale.js\");", "", "console.log(scale(3), scale(3, 10));", ""]);
	});

	const ran = await session.request("debug.start", { "program": "/workspace/scaled.js", "breakpoints": [] }, 60_000);

	assert.deepEqual(ran.output, ["6 30"]);

	const found = await eventually("the imported file's evidence", () => workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const find = async (folder, name) => {
			for (const [entry, type] of await api.workspace.fs.readDirectory(folder).then((all) => all, () => [])) {
				const child = api.Uri.joinPath(folder, entry);
				let hit;

				if (type === api.FileType.Directory) {
					hit = await find(child, name);
				} else if (entry === name) {
					hit = new TextDecoder().decode(await api.workspace.fs.readFile(child));
				}

				if (hit !== undefined) {
					return hit;
				}
			}

			return undefined;
		};

		const lines = (await find(api.Uri.file("/workspace/.silo/evidence"), "scale.js.jsonl") ?? "").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

		return lines.some((line) => line.kind === "value") ? lines : undefined;
	}));

	assert.ok(found.some((line) => line.kind === "reached"), "its coverage");
	assert.ok(found.some((line) => line.kind === "value" && JSON.stringify(line.tags) === JSON.stringify({ "undefined": 1, "number": 1 })), "by ?? 2: once undefined, once a number");
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/scaled.js"));
		await api.workspace.fs.delete(api.Uri.file("/workspace/scale.js"));
	});
});

test("evidence: a run's values and branches, beside its coverage", async () => {
	// (Written through the workspace, not typed into a terminal: a debug session may have the Debug Console focused.)
	await session.workbench().evaluate((text) => globalThis.__editor.api.workspace.fs.writeFile(globalThis.__editor.api.Uri.file("/workspace/values.js"), new TextEncoder().encode(text)), [
		"const world = { onWin: () => 1 };",
		"function pick(key) { return key ?? \"none\"; }",
		"for (const key of [\"a\", undefined]) { if (pick(key) === \"a\") { world.onWin?.(); } }",
		"const won = world.onWin ?? (() => 0);",
		"const bonus = won ? 2 : 0;",
		""
	].join("\n"));
	await session.request("debug.start", { "program": "/workspace/values.js" }, 60_000);

	const found = await eventually("its values and branches, as evidence", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const find = async (folder, name) => {
			for (const [entry, type] of await api.workspace.fs.readDirectory(folder).then((all) => all, () => [])) {
				const child = api.Uri.joinPath(folder, entry);
				let hit;

				if (type === api.FileType.Directory) {
					hit = await find(child, name);
				} else if (entry === name) {
					hit = new TextDecoder().decode(await api.workspace.fs.readFile(child));
				}

				if (hit !== undefined) {
					return hit;
				}
			}

			return undefined;
		};

		const evidence = await find(api.Uri.file("/workspace/.silo/evidence"), "values.js.jsonl");
		const samples = await find(api.Uri.file("/workspace/.silo/local/samples"), "values.js.jsonl");
		const lines = (text) => (text ?? "").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

		return lines(evidence).some((line) => line.kind === "value") ? { "evidence": lines(evidence), "samples": lines(samples) } : undefined;
	}));
	const values = found.evidence.filter((line) => line.kind === "value");
	const tagged = (tags) => values.filter((line) => JSON.stringify(line.tags) === JSON.stringify(tags));

	assert.equal(tagged({ "function": 1 }).length, 2, "world.onWin?.() and world.onWin ?? …: a function, never nullish");
	assert.ok(tagged({ "function": 1 }).every((line) => line.nullish === 0));
	assert.equal(tagged({ "string": 1, "undefined": 1 }).length, 2, "pick's key, and key ?? …: one string, one undefined");
	assert.equal(tagged({ "string": 2 }).length, 1, "pick's return: a string both times");
	assert.equal(tagged({ "number": 1 }).length, 1, "() => 1 returned a number");
	assert.deepEqual(found.evidence.filter((line) => line.kind === "branch").map((line) => line.arms).sort(), [[1, 0], [1, 1]], "the if: each arm once; the ?: only ever true");
	assert.ok(found.evidence.some((line) => line.kind === "reached"), "beside its coverage");
	assert.ok(found.samples.some((line) => line.values.includes("none")), "the values, on this machine");
	assert.ok(found.evidence.every((line) => !JSON.stringify(line).includes("none")), "and never in git");

	// On hover (the insights extension), what went through the code under the cursor.
	const hovers = await eventually("the evidence, on hover", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/values.js"));
		const text = editor.document.getText();
		const hover = async (needle, offset = 0) => {
			const found = await api.commands.executeCommand("vscode.executeHoverProvider", editor.document.uri, editor.document.positionAt(text.indexOf(needle) + offset));

			return found.flatMap((each) => each.contents.map((content) => (typeof content === "string" ? content : content.value))).join("\n");
		};

		const optional = await hover("?.", -1);

		return optional.includes("never nullish") ? { "optional": optional, "branch": await hover("if ("), "returned": await hover("return") } : undefined;
	}));

	assert.match(hovers.optional, /`\?\.` — what it tested\*\* — 1 value in 1 run, never nullish/u);
	assert.match(hovers.optional, /`function` █+ 100%/u);
	assert.match(hovers.branch, /then 1× \(50%\) · else 1× \(50%\), in 1 run/u);
	assert.match(hovers.returned, /Seen here: "a", "none"/u, "the values, as this machine saw them");
	assert.match(hovers.returned, /Declared `[^`]+` · observed `string`/u, "the declared type beside what was observed");

	// What runs say could go, as hints — here with the thresholds at one run, one value — and a fix that removes it.
	const hints = await eventually("the evidence's hints", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const settings = api.workspace.getConfiguration("silo.evidence");

		await settings.update("minRuns", 1, api.ConfigurationTarget.Global);
		await settings.update("minSeen", 1, api.ConfigurationTarget.Global);

		const uri = api.Uri.file("/workspace/values.js");
		const found = api.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === "evidence");

		return found.length >= 3 ? found.map((diagnostic) => ({ "code": diagnostic.code, "message": diagnostic.message, "line": diagnostic.range.start.line })) : undefined;
	}));

	assert.deepEqual(hints.map((hint) => hint.code).sort(), ["branch-never-taken", "unneeded-nullish-coalescing", "unneeded-optional-chain"], "world.onWin?.(), world.onWin ?? …, and won ? … : …; not key ?? …, nullish once, nor the if, both arms taken");
	assert.match(hints.find((hint) => hint.code === "branch-never-taken").message, /false never ran: 1 time in 1 run, every one the true/u);

	const fixed = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/values.js");
		const document = await api.workspace.openTextDocument(uri);
		const nullish = api.languages.getDiagnostics(uri).find((diagnostic) => diagnostic.code === "unneeded-nullish-coalescing");
		const actions = await api.commands.executeCommand("vscode.executeCodeActionProvider", uri, nullish.range, api.CodeActionKind.QuickFix.value);
		const remove = actions.find((action) => action.title.startsWith("Remove `?? (() => 0)`"));

		await api.workspace.applyEdit(remove.edit);

		const settings = api.workspace.getConfiguration("silo.evidence");

		await settings.update("minRuns", undefined, api.ConfigurationTarget.Global);
		await settings.update("minSeen", undefined, api.ConfigurationTarget.Global);

		return { "titles": actions.map((action) => action.title), "line": document.lineAt(3).text };
	});

	assert.equal(fixed.line, "const won = world.onWin;", "the quick fix removed the ?? and its right side");

	// A note on a value site keeps the kinds of value runs saw there: the typed strategy's other signal.
	const noted = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/values.js"));
		const at = editor.document.getText().indexOf("world.onWin?.()");

		editor.selection = new api.Selection(editor.document.positionAt(at), editor.document.positionAt(at + "world.onWin?.()".length));

		const id = await api.commands.executeCommand("notes.add", "fires once per win");
		const folder = api.Uri.file("/workspace/.silo/notes");

		for (const [owner] of await api.workspace.fs.readDirectory(folder)) {
			const text = await api.workspace.fs.readFile(api.Uri.joinPath(folder, owner, "values.js.jsonl")).then((bytes) => new TextDecoder().decode(bytes), () => "");
			const note = text.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).find((each) => each.id === id);

			if (note !== undefined) {
				return note.ref;
			}
		}

		return undefined;
	});

	assert.deepEqual(noted?.observed, ["function"], "world.onWin was a function every time");
});

// What TypeScript makes of a file's ranges, from the capabilities tsserver plugin (`_types.at`): the declared side of
// runtime evidence, and the typed strategy's signal — the type of what each site observes.
// Live values (RUNTIME-EVIDENCE.md, *Live values*): a debug session over the binary search of Bret Victor's *Inventing on Principle*, paused
// on its return — each line's values in the notes margin beside it, a column per turn of the loop, a prose note beside
// them — and kept once the session ends (the file's last run), the note staying.
test("live values: a session's values beside the code, as the talk's binary search", async () => {
	const workbench = session.workbench();
	const source = [
		"function binarySearch(key, array) {",
		"\tlet low = 0;",
		"\tlet high = array.length - 1;",
		"",
		"\twhile (true) {",
		"\t\tconst mid = Math.floor((low + high) / 2);",
		"\t\tconst value = array[mid];",
		"",
		"\t\tif (value < key) {",
		"\t\t\tlow = mid + 1;",
		"\t\t} else if (value > key) {",
		"\t\t\thigh = mid - 1;",
		"\t\t} else {",
		"\t\t\treturn mid;",
		"\t\t}",
		"\t}",
		"}",
		"",
		"console.log(binarySearch(\"d\", [\"a\", \"b\", \"c\", \"d\", \"e\", \"f\"]));",
		""
	].join("\n");
	const show = () => workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/victor.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		await api.window.showTextDocument(uri);
	}, source);
	// Each values row by its line (0-based): its label, then its cells, as shown.
	const rows = () => workbench.evaluate(() => Object.fromEntries([...document.querySelectorAll(".live-values-row")].map((row) => [row.dataset.line, [...row.children].filter((child) => !child.classList.contains("live-values-mock")).map((child) => child.textContent.trim())])));

	await show();

	const started = await session.request("debug.start", { "program": "/workspace/victor.js", "breakpoints": [14] }, 60_000);

	assert.equal(started.line, 14, "paused on the return");

	const shown = await eventually("the session's values in the margin", async () => {
		const all = await rows();

		return all["6"]?.length === 4 ? all : undefined;
	});

	assert.deepEqual(shown["0"], ["key = 'd', array = ['a', 'b', 'c', 'd', 'e', 'f']"], "a function's parameters, each named");
	assert.deepEqual(shown["1"], ["low =", "0"]);
	assert.deepEqual(shown["2"], ["high =", "5"]);
	assert.deepEqual(shown["5"], ["mid =", "2", "4", "3"], "a column per turn of the loop");
	assert.deepEqual(shown["6"], ["value =", "'c'", "'e'", "'d'"]);
	assert.deepEqual(shown["8"], ["if", "then", "else", "else"], "the arm each turn took");
	assert.deepEqual(shown["9"], ["low =", "3", "", ""], "only in the turn that ran it");
	assert.deepEqual(shown["11"], ["high =", "", "3", ""]);

	// Reformatted while paused — blank lines above, indented with spaces, mid wrapped, no semicolons: every row moves
	// with its code (anchored by BABLR spans, not line numbers).
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/victor.js"));
		const text = editor.document.getText();
		const reformatted = text.replaceAll("\t", "  ").replace("{\n", "{\n\n\n").replace("Math.floor((low + high) / 2);", "Math.floor(\n      (low + high) / 2\n    );").replaceAll(";\n", "\n");

		await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(0), editor.document.positionAt(text.length)), reformatted);
		});
	});

	const moved = await eventually("the rows moved with their code", async () => {
		const all = await rows();

		return all["15"]?.[0] === "high =" ? all : undefined;
	});

	assert.deepEqual(Object.fromEntries(Object.entries(moved).map(([line, cells]) => [line, cells[0]])), { "0": "key = 'd', array = ['a', 'b', 'c', 'd', 'e', 'f']", "3": "low =", "4": "high =", "7": "mid =", "10": "value =", "12": "if", "13": "low =", "14": "if", "15": "high =" });
	assert.deepEqual(moved["7"], ["mid =", "2", "4", "3"], "a wrapped line keeps its columns");
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.window.showTextDocument(api.Uri.file("/workspace/victor.js"));
		await api.commands.executeCommand("workbench.action.files.revert");
	});

	await session.request(`debug.session.${started.session}.stop`, undefined, 30_000);
	await eventually("the run's end on its line", () => workbench.evaluate(() => document.querySelector(".notes-margin-mark.run-stopped") !== null || undefined));
	assert.deepEqual((await rows())["5"], ["mid =", "2", "4", "3"], "its values kept: the file's last run");
	// Leave the workbench as the next tests expect it: no breakpoint, and the Explorer back where a breakpoint's stop put
	// the Run and Debug view (they open files from its tree).
	await session.request("debug.breakpoints", { "program": "/workspace/victor.js", "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// At a stop, the margin's values are VS Code's own inline values too (the margin extension's InlineValuesProvider): each line's
// latest at its end, as VS Code draws a debugger's — whichever debugger it is, and with no pane beside the editor.
test("inline values: at a stop, each line's latest value at its end, as VS Code draws them", async () => {
	const workbench = session.workbench();
	const program = "/workspace/inline-values.js";

	await workbench.evaluate(async (file) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(file), new TextEncoder().encode("function total(prices) {\n\tlet sum = 0;\n\n\tfor (const price of prices) {\n\t\tsum += price;\n\t}\n\n\tconst tax = sum * 0.08;\n\n\treturn sum + tax;\n}\n\nconsole.log(total([12, 30, 8]));\n"));
		await api.window.showTextDocument(api.Uri.file(file));
	}, program);

	// (inline values are the focused frame's: a session an earlier test left paused would keep the focus)
	for (const each of await session.request("debug.sessions", undefined, 10_000).catch(() => [])) {
		await session.request(`debug.session.${each.session}.stop`, undefined, 30_000).catch(() => undefined);
	}

	try {
		const stopped = await session.request("debug.start", { "program": program, "breakpoints": [10] }, 60_000);

		assert.equal(stopped.line, 10);
		assert.deepEqual(await eventually("the inline values", async () => {
			// (VS Code draws them with non-breaking spaces)
			const shown = await workbench.evaluate(() => [...document.querySelectorAll(".monaco-editor .debug-inline-value")].map((each) => each.textContent.replaceAll("\u00A0", " ")));

			return shown.includes("tax = 4") ? shown : undefined;
		}), ["prices = [12, 30, 8]", "sum = 0", "price = 8", "sum = 50", "tax = 4"]);

		await session.request(`debug.session.${stopped.session}.stop`, undefined, 30_000);
	} finally {
		await workbench.evaluate((file) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(file)).then(() => undefined, () => undefined), program);
	}
});

// Live runs (RUNTIME-EVIDENCE.md, *Live runs*): the file in the editor runs again on a save or the interval — no Run — its
// values in the margin; a write it can't make is skipped (nothing written, the line saying so); half-typed, the last run's
// values stay; a loop that never ends stops at its budget, saying so on its line; none of them is in the running list.
test("live runs: saved, the file runs again — writes into its own layer, half-typed kept, an endless loop stopped", async () => {
	const workbench = session.workbench();
	const file = "/workspace/live.js";
	const rows = () => workbench.evaluate(() => Object.fromEntries([...document.querySelectorAll(".live-values-row")].map((row) => [row.dataset.line, [...row.children].filter((child) => !child.classList.contains("live-values-mock")).map((child) => child.textContent.trim())])));
	// An edit, then Ctrl+S: a save runs it. (The editor focused first, as typing there would leave it.)
	const edit = async (from, to) => {
		await workbench.evaluate(async ([find, replace]) => {
			const { api } = globalThis.__editor;
			const editor = api.window.activeTextEditor;
			const text = editor.document.getText();
			const at = text.indexOf(find);

			await editor.edit((builder) => {
				builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + find.length)), replace);
			});
			await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
		}, [from, to]);
		await session.page.keyboard.press("ControlOrMeta+s");
	};

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("const fs = require('fs');\nlet total = 0;\nfor (const p of [3, 4, 5]) {\n\ttotal += p;\n}\nfs.writeFileSync('out-live.txt', String(total));\nconst back = fs.readFileSync('out-live.txt', 'utf8');\nconsole.log(total);\n"));
		await api.window.showTextDocument(uri);
	}, file);
	await edit("[3, 4, 5]", "[3, 4, 5, 6]");

	// (rows by what they say, not their line: a save may fix the code — ESLint's fix on save — moving it down)
	const loopTotal = (all) => Object.values(all).find((row) => row[0] === "total =" && row.length === 5);
	const ran = await eventually("the edit's run, in the margin", async () => {
		const all = await rows();

		return loopTotal(all) === undefined ? undefined : all;
	});

	assert.deepEqual(loopTotal(ran), ["total =", "3", "7", "12", "18"]);
	// The write went into the run's own layer (RUNNING.md, *Unattended runs*): read back, it's there for the run — and the
	// workspace is as it was.
	assert.ok(Object.values(ran).some((row) => JSON.stringify(row.filter((cell) => cell !== "")) === JSON.stringify(["back =", "'18'"])), "its own write, read back");
	assert.equal(await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.stat(globalThis.__editor.api.Uri.file("/workspace/out-live.txt")).then(() => true, () => false)), false, "nothing written to the workspace");
	assert.equal((await session.request("runs.list", undefined, 5000)).some((run) => /\(live\)/u.test(run.title)), false, "not in the running list");

	// Half-typed: the run that didn't parse tells nothing; the last one's values stay where they were.
	await edit("total += p;", "total += p *");
	await new Promise((resolve) => {
		setTimeout(resolve, 2000);
	});
	assert.deepEqual(loopTotal(await rows()), ["total =", "3", "7", "12", "18"], "kept");

	await edit("total += p *", "total += p * 2;");
	assert.deepEqual(await eventually("the finished edit's run", async () => {
		const total = loopTotal(await rows());

		return total?.[4] === "36" ? total : undefined;
	}), ["total =", "6", "14", "24", "36"]);

	// A loop that never ends: stopped at its budget, on its line.
	await edit("for (const p of [3, 4, 5, 6]) {", "while (true) {\n\tconst p = 1;");
	assert.match(await eventually("stopped at its budget", () => workbench.evaluate(() => document.querySelector(".notes-margin-mark.run-stopped")?.title)), /too long to run live/u);

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
		await api.workspace.fs.delete(api.Uri.file(path));
	}, file);
});

// Setting a value from the margin: Mock… on a variable's row — the rule editor, prefilled with the place and the value —
// 3, Just this once: the run goes on with it (the binary search with high set to 3 takes another path), and the row
// shows it as set by hand. Save as rule: each run sets it there, without stopping.
test("set a value: from the margin, at a stop or by a rule, and the run goes on with it", async () => {
	const workbench = session.workbench();
	const source = ["function binarySearch(key, array) {", "\tlet low = 0;", "\tlet high = array.length - 1;", "", "\twhile (true) {", "\t\tconst mid = Math.floor((low + high) / 2);", "\t\tconst value = array[mid];", "", "\t\tif (value < key) {", "\t\t\tlow = mid + 1;", "\t\t} else if (value > key) {", "\t\t\thigh = mid - 1;", "\t\t} else {", "\t\t\treturn mid;", "\t\t}", "\t}", "}", "", "console.log(binarySearch(\"d\", [\"a\", \"b\", \"c\", \"d\", \"e\", \"f\"]));", ""].join("\n");
	const rows = () => workbench.evaluate(() => Object.fromEntries([...document.querySelectorAll(".live-values-row")].map((row) => [row.dataset.line, [...row.children].filter((child) => !child.classList.contains("live-values-mock")).map((child) => child.textContent.trim())])));

	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/setvalue.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		await api.window.showTextDocument(uri);
	}, source);

	const started = await session.request("debug.start", { "program": "/workspace/setvalue.js", "breakpoints": [6] }, 60_000);

	// high's Mock…: the rule editor under its row, its value set to 3, then a button.
	const mockHigh = async (button) => {
		await workbench.evaluate(() => {
			[...document.querySelectorAll(".live-values-row[data-line=\"2\"] .live-values-choice")].find((each) => each.textContent === "Mock…").click();
		});
		await eventually("high's rule editor", () => inRuleView(() => document.querySelector(".rule-panel .rule-editor-then wa-input") !== null || undefined));
		await inRuleView((label) => {
			const input = document.querySelector(".rule-panel .rule-editor-then wa-input");

			input.value = "3";
			input.dispatchEvent(new Event("input"));
			[...document.querySelectorAll(".rule-panel-choice")].find((each) => each.textContent === label).click();
		}, button);
	};

	await eventually("high's row", async () => (await rows())["2"]?.[1] === "5" || undefined);
	await mockHigh("Just this once");
	await eventually("high, set by hand", () => workbench.evaluate(() => document.querySelector(".live-values-row[data-line=\"2\"] .live-values-set")?.textContent).then((text) => (text === "3" ? text : undefined)));

	// On to the return: it went the way high = 3 sends it.
	await session.request("debug.breakpoints", { "program": "/workspace/setvalue.js", "lines": [14] }, 30_000);
	await session.request(`debug.session.${started.session}.step`, { "action": "continue" }, 30_000);

	const after = await eventually("the values of the run it took", async () => {
		const all = await rows();

		return all["6"]?.length === 4 ? all : undefined;
	});

	assert.deepEqual(after["5"], ["mid =", "1", "2", "3"]);
	assert.deepEqual(after["6"], ["value =", "'b'", "'c'", "'d'"]);
	await assert.rejects(session.request(`debug.session.${started.session}.setValue`, { "name": "mid", "value": "9" }, 30_000), /mid is a const/u);
	await assert.rejects(session.request(`debug.session.${started.session}.setValue`, { "name": "low", "value": "alert(1)" }, 30_000), /not a literal/u);
	await session.request(`debug.session.${started.session}.stop`, undefined, 30_000);

	// Save as rule, from a stop at the loop: kept in my policy, placed at high's statement.
	const again = await session.request("debug.start", { "program": "/workspace/setvalue.js", "breakpoints": [6] }, 60_000);

	await eventually("high's row, again", async () => (await rows())["2"]?.[1] === "5" || undefined);
	await mockHigh("Save as rule");

	const [rule] = await eventually("the rule", async () => {
		const listed = await session.execute("silo.rules.files");

		return listed.mine.rules.length === 1 ? listed.mine.rules : undefined;
	});

	assert.deepEqual(rule.then, [{ "action_id": "set", "target_id": "variables.high", "argument": 3 }]);
	assert.equal(rule.when.predicates[1].target_id, "at");
	await session.request(`debug.session.${again.session}.stop`, undefined, 30_000);

	// A run with no stop on high's line is set by it all the same: the same path as above.
	await session.request("debug.breakpoints", { "program": "/workspace/setvalue.js", "lines": [14] }, 30_000);
	const third = await session.request("debug.start", { "program": "/workspace/setvalue.js", "breakpoints": [14] }, 60_000);

	const ruled = await eventually("the run the rule set", async () => {
		const all = await rows();

		return all["6"]?.length === 4 ? all : undefined;
	});

	assert.deepEqual(ruled["5"], ["mid =", "1", "2", "3"]);
	await session.request(`debug.session.${third.session}.stop`, undefined, 30_000);
	await session.execute("silo.rules.set", rule);
	await session.request("debug.breakpoints", { "program": "/workspace/setvalue.js", "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// Mocking process.argv in the margin (RUNNING.md, *Rules*): its row is there before any run, with Mock… — the rule
// editor, prefilled with the file and the run's arguments. Run runs it with them, once, keeping nothing; Save as rule
// keeps them in my policy — two values, two runs — and a plain run is given them; Remove takes the rule away.
test("mock process.argv: a rule giving it, once or kept, several runs, and a plain run given them", async () => {
	const workbench = session.workbench();
	const program = "/workspace/tax.js";
	const runsOf = async () => (await session.request("runs.list", undefined, 5000)).filter((run) => run.title.includes("tax.js"));
	const givenNow = () => session.execute("silo.rules.given", program, "process.argv");
	const row = () => workbench.evaluate(() => {
		const line = document.querySelector(".live-values-row[data-line=\"0\"]");

		return line === null ? undefined : { "label": line.querySelector(".live-values-label")?.textContent.trim(), "given": line.querySelector(".live-values-given")?.textContent ?? null };
	});
	// The Mock's editor (the Rule view): open it (on the row), read what it says, give process.argv these runs' command
	// lines, press a button.
	const mock = (action, argument) => (action === "open" ? workbench.evaluate(() => {
		[...document.querySelectorAll(".live-values-row[data-line=\"0\"] .live-values-choice")].find((button) => button.textContent === "Mock…").click();

		return true;
	}) : inRuleView(([what, value]) => {
		const panel = document.querySelector(".rule-panel");
		const outer = () => panel.querySelector(".rule-editor-then .rule-editor-list.nested");
		const runs = () => [...outer().children].filter((child) => child.classList.contains("rule-editor-list-item"));

		switch (what) {
			case "status":
				return panel?.querySelector(".rule-panel-status")?.textContent;
			case "give":
				while (runs().length < value.length) {
					[...outer().children].at(-1).click();
				}

				// Each run's arguments, as a command line.
				for (const [index, line] of value.entries()) {
					const input = runs()[index].querySelector("wa-input");

					input.value = line;
					input.dispatchEvent(new Event("input"));
				}

				return panel.querySelector(".rule-panel-status").textContent;
			default:
				[...panel.querySelectorAll(".rule-panel-choice")].find((button) => button.textContent === what).click();

				return true;
		}
	}, [action, argument]));
	const opened = async () => {
		await mock("open");

		return eventually("the Mock's rule editor", () => mock("status"));
	};

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/tax.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["const [, , country = \"US\", coupon] = process.argv;", "const rates = { US: 0.07, CA: 0.13, FR: 0.2 };", "const rate = rates[country] ?? 0;", "", "console.log(country, rate, coupon ?? \"no coupon\");", ""].join("\n")));
		await api.window.showTextDocument(uri);
	});

	// No rule left from before.
	const before = await givenNow();

	if (before !== null) {
		await session.execute("silo.rules.set", before.rule);
	}

	// Before any run: its row, nothing given.
	assert.deepEqual(await eventually("process.argv's row", row), { "label": "process.argv =", "given": null });

	// Run: the file with them, once — nothing kept.
	const ran = (await runsOf()).length;

	assert.equal(await opened(), "Gives tax.js these arguments");
	assert.equal(await mock("give", ["CA SPRING10"]), "Gives tax.js these arguments");
	await mock("Run");
	await eventually("a run with the mocked arguments", async () => (await runsOf()).length > ran || undefined);
	assert.equal(await givenNow(), null, "a one-off keeps nothing");

	// Save as rule, two runs' arguments: kept, and shown beside the row.
	assert.ok(await opened());
	assert.equal(await mock("give", ["CA SPRING10", "FR"]), "Gives tax.js 2 runs, one after another");
	await mock("Save as rule");
	assert.deepEqual(await eventually("the rule", async () => (await givenNow())?.values), [["CA", "SPRING10"], ["FR"]]);
	assert.equal((await eventually("the row, given", async () => (await row())?.given ?? undefined)), "CA SPRING10  ·  FR");

	// A plain run is given them: the first answers, the second follows as its own session.
	const plain = await session.request("debug.start", { "program": program }, 60_000);

	assert.equal(plain.state, "terminated");
	assert.deepEqual(plain.output, ["CA 0.13 SPRING10"]);
	await eventually("the second run, after it", async () => (await runsOf()).some((run) => run.title.includes("(case 2 of 2)")) || undefined);

	// Remove: the rule goes.
	assert.ok(await opened());
	await mock("Remove");
	await eventually("no rule", async () => (await givenNow()) === null || undefined);
	assert.equal(await eventually("the row, given nothing", async () => ((await row())?.given === null ? true : undefined)), true);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// The program's projection (RUNTIME-EVIDENCE.md, *Projections*): the open file's steps as cards in the notes margin — statements written
// together (no blank line between) are one, a comment above titles one, a function is its own — each card around its
// lines, labelled on its bottom border, the types of what it declares on hover; after a run, whether each step ran and
// how often a function was called.
test("projection: the margin's cards are the file's steps, each saying whether it ran", async () => {
	const workbench = session.workbench();
	const program = "/workspace/cards.js";
	const cards = () => workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-group")].map((card) => ({
		"title": card.querySelector(".live-values-step-title")?.textContent,
		"detail": card.querySelector(".live-values-step-detail")?.textContent ?? null,
		"ran": card.querySelector(".live-values-step-ran")?.textContent ?? null,
		"types": card.querySelector(".notes-margin-group-label")?.title ?? "",
		"height": card.getBoundingClientRect().height
	})));

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["// The order", "const base = 2;", "const doubled = base * 2;", "", "function square(n) {", "\treturn n * n;", "}", "", "console.log(square(doubled));", ""].join("\n")));
		await api.window.showTextDocument(uri);
	}, program);

	const before = await eventually("the cards", async () => {
		const shown = await cards();

		return shown.length === 3 ? shown : undefined;
	}, 30_000);

	assert.deepEqual(before.map(({ title }) => title), ["The order", "square", "console.log"]);
	assert.equal(before[0].detail, "2 statements");
	assert.equal(before[0].types, "base: 2\ndoubled: number");
	assert.ok(before[0].height > before[2].height * 2, "a card is as tall as its lines: the comment and two statements");

	// Run: each card says whether its step ran.
	const ran = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.deepEqual(ran.output, ["16"]);

	const after = await eventually("whether each step ran", async () => {
		const shown = await cards();

		return shown.every(({ ran }) => ran !== null) ? shown : undefined;
	});

	assert.deepEqual(after.map(({ ran }) => ran), ["ran", "called 1×", "ran"]);
});

// The run log (RUNTIME-EVIDENCE.md, *Projections*), after the last card: each step that ran, in order, with its share of the run's work (the
// interpreter's steps — a function's card gets its body's, wherever it's called from) and what it waited, on the event
// loop's clock — and how the run ended.
test("projection: the run log — each step's share of the work, and its waits", async () => {
	const workbench = session.workbench();
	const program = "/workspace/steps.js";

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["// Totals", "let total = 0;", "for (let i = 0; i < 300; i += 1) total += i;", "", "function square(n) {", "\treturn n * n;", "}", "", "// Later", "void setTimeout(() => console.log(square(total)), 250);", ""].join("\n")));
		await api.window.showTextDocument(uri);
	}, program);

	const ran = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.deepEqual(ran.output, ["2011522500"]);

	// The run log, as the Margin draws it: its head, then a row a step — its title, and what it waited.
	const log = await eventually("the run log", () => workbench.evaluate(() => {
		const head = document.querySelector("[data-item=\"runlog\"] .pane-markdown");

		return head === null ? undefined : {
			"head": head.textContent.trim(),
			"rows": [...document.querySelectorAll("[data-item^=\"runlog:\"] .live-values-row")].map((row) => [row.querySelector(".live-values-label").textContent.trim(), [...row.querySelectorAll(".live-values-cell.turn")].map((cell) => cell.textContent).find((text) => text.startsWith("waited")) ?? null])
		};
	}));

	assert.match(log.head, /^Last run · [\d.]+k? statements · waited 250ms · completed$/u);
	assert.deepEqual(log.rows, [["Totals", null], ["square", null], ["Later", "waited 250ms"]]);
	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.closeActiveEditor");
		await api.workspace.fs.delete(api.Uri.file(path));
	}, program);
});

// How the last run ended short, in the margin's strip: a ✕ on the line it crashed on (the error on hover) — through a
// reformat too, anchored by the throw's span — gone when it runs again and finishes.
test("run ends: a crash is marked on the line it threw on, and stays on it through a reformat", async () => {
	const workbench = session.workbench();
	const crashed = () => workbench.evaluate(() => {
		const mark = document.querySelector(".notes-margin-mark.run-crashed");
		const lineHeight = Number.parseFloat(getComputedStyle(document.querySelector(".notes-margin")).lineHeight);

		// (Line 1's top is a line down: the pane's first line is reserved, for its tabs.)
		return mark === null ? undefined : { "line": Math.round(Number.parseFloat(mark.style.top) / lineHeight), "title": mark.title };
	});
	const write = (text) => workbench.evaluate(async (content) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/crash.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		await api.window.showTextDocument(uri);
	}, text);

	await write(["function parse(text) {", "\tconst data = JSON.parse(text);", "\treturn data.items.length;", "}", "", "console.log(parse('{\"items\": [1, 2]}'));", "console.log(parse('{}'));", ""].join("\n"));

	const ran = await session.request("debug.start", { "program": "/workspace/crash.js", "breakpoints": [] }, 60_000);

	assert.equal(ran.state, "terminated");
	assert.deepEqual(await eventually("the crash's mark", crashed), { "line": 3, "title": "The last run crashed here: TypeError: Cannot read properties of undefined (reading 'length')" });

	// Reformatted (unsaved): two lines above it, spaces, no semicolons — the mark is still on `data.items.length`.
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = api.window.activeTextEditor;
		const text = editor.document.getText();

		await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(0), editor.document.positionAt(text.length)), "// parse\n\n" + text.replaceAll("\t", "    ").replaceAll(";\n", "\n"));
		});
	});
	assert.equal((await eventually("the mark, moved with its code", async () => ((await crashed())?.line === 5 ? crashed() : undefined))).line, 5);

	// Fixed and run again: it finishes, and the mark goes.
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.files.revert");
	});
	await write(["function parse(text) {", "\tconst data = JSON.parse(text);", "\treturn data.items?.length ?? 0;", "}", "", "console.log(parse('{}'));", ""].join("\n"));
	await session.request("debug.start", { "program": "/workspace/crash.js", "breakpoints": [] }, 60_000);
	await eventually("no mark once it finishes", async () => (await crashed()) === undefined || undefined);
});

test("types: the tsserver plugin types each of a file's ranges as its site observes", async () => {
	const types = await eventually("types at ranges", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/typed.ts");
		const source = "function f(n: number | undefined, s?: { t: string }) {\n\treturn n ?? s?.t.length;\n}\nconst g = (x: number) => x * 2;\n";

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
		await api.window.showTextDocument(uri);

		const range = (text, length = text.length) => ({ "start": source.indexOf(text), "end": source.indexOf(text) + length });
		const response = await api.commands.executeCommand("typescript.tsserverRequest", "_types.at", { "file": uri, "ranges": [range("n: number | undefined"), range("n ?? s?.t.length"), range("s?.t"), range("(x: number) => x * 2"), range("return n ?? s?.t.length")] });
		const found = response?.body?.types;

		return Array.isArray(found) && found[0] !== null ? found : undefined;
	}));

	// (The workspace's TypeScript isn't strict, so `undefined` drops out of these types.)
	assert.deepEqual(types, ["number", "number", "{ t: string; }", "number", "number"], "a parameter, ??'s left, what ?. tested, an arrow's return, a return's value");
});

// A note stays with its code (RUNTIME-EVIDENCE.md, *Durable annotations on spans*): kept on its span in .silo/notes/, followed when its code is edited
// (and rewritten there), asked about in the Problems view when its code goes, and dismissed with a tombstone.
test("notes: a note follows its code, and waits in Problems when its code is gone", async () => {
	const workbench = session.workbench();
	const run = (step, arg) => workbench.evaluate(async ([what, value]) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/noted.js");
		const notes = async () => {
			const folder = api.Uri.file("/workspace/.silo/notes");
			const [owner] = await api.workspace.fs.readDirectory(folder).then((entries) => entries.map(([name]) => name), () => []);
			const text = owner === undefined ? "" : await api.workspace.fs.readFile(api.Uri.joinPath(folder, owner, "noted.js.jsonl")).then((bytes) => new TextDecoder().decode(bytes), () => "");

			return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
		};

		switch (what) {
			case "add": {
				await api.workspace.fs.writeFile(uri, new TextEncoder().encode("setup();\nfn(foo, bar, baz);\nlog(1);\n"));

				const editor = await api.window.showTextDocument(uri);
				const text = editor.document.getText();
				const at = text.indexOf("fn(foo, bar, baz)");

				editor.selection = new api.Selection(editor.document.positionAt(at), editor.document.positionAt(at + "fn(foo, bar, baz)".length));

				return api.commands.executeCommand("notes.add", value);
			}

			case "edit": {
				const editor = await api.window.showTextDocument(uri);
				const text = editor.document.getText();

				await editor.edit((builder) => {
					builder.replace(new api.Range(editor.document.positionAt(text.indexOf(value[0])), editor.document.positionAt(text.indexOf(value[0]) + value[0].length)), value[1]);
				});

				return undefined;
			}

			case "notes":
				return notes();
			case "lost":
				return api.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === "notes").map((diagnostic) => diagnostic.message);
			case "dismiss":
				return api.commands.executeCommand("notes.dismiss", value);
			default:
				return undefined;
		}
	}, [step, arg]);

	const id = await run("add", "check the bounds");
	const [placed] = await eventually("the note, kept on its span", async () => ((await run("notes")).some((note) => note.id === id) ? run("notes") : undefined));

	assert.equal(placed.payload.text, "check the bounds");
	assert.deepEqual(placed.ref.shape.atoms.slice(0, 3), ["fn", "(", "foo"]);

	// Its argument edited: a new span id, but the note follows its code and is rewritten there.
	await run("edit", ["baz)", "baz2)"]);

	const followed = await eventually("the note, followed and rewritten", async () => (await run("notes")).find((note) => note.id === id && note.ref.span !== placed.ref.span));

	assert.ok(followed.placed?.strategy !== undefined, "it says which strategy placed it");
	assert.ok(followed.ref.shape.atoms.includes("baz2"));

	// Its code gone: the note waits in the Problems view.
	await run("edit", ["fn(foo, bar, baz2);\n", ""]);
	await eventually("the lost note, in Problems", async () => (await run("lost")).some((message) => message.includes("check the bounds")) || undefined);

	// Dismissed: a tombstone, so a merge can't bring it back.
	await run("dismiss", id);
	await eventually("the note's tombstone", async () => (await run("notes")).find((note) => note.id === id && note.dismissed === true));

	// On the architecture view, discovered (ARCHITECTURE.md, *Discovered, not declared*): the notes extension calling the bridge's command,
	// and the insights extension asking the TypeScript plugin for types through VS Code.
	await session.until("notes → the bridge, by command", hasLabel("ext:notes", "ext:bridge", /^cmd editor\.annotations\.resolve$/u));

	// And what a resolve is, as a flow followed by its messages' causes: the bridge's call to core caused core's call to the
	// BABLR worker (whose queue names it, though the call goes out later).
	const { flowsOf } = await import("../../observability/src/flows.ts");
	const everything = (message) => [message, ...message.caused.flatMap(everything)];
	// (Polled with the view's snapshot fresh each time: session.snapshot() is the last one polled.)
	// (One whose cause is named: other resolves run alongside — the margin's placed rules, followed as it redraws — and
	// one of those, caught mid-queue, may only be inferred; the queue naming its cause is what's under test.)
	const resolveIn = (snapshot) => flowsOf(snapshot.log.filter((sample) => sample.from !== undefined && sample.to !== undefined)).flatMap(everything).find((message) => message.label === "annotations.resolve()" && message.caused.some((child) => child.label === "bablr.resolve()" && child.inferred === undefined));
	// A resolve of its own, made now: the view keeps the latest 3000 messages, and by here the note's (dismissed) may have
	// rolled out of them — in CI, it did.
	const resolveNow = () => workbench.evaluate(async (ref) => {
		const { api } = globalThis.__editor;
		const document = await api.workspace.openTextDocument(api.Uri.file("/workspace/noted.js"));

		await api.commands.executeCommand("editor.annotations.resolve", document.getText(), "noted.js", [ref]);
	}, placed.ref);
	let resolve;

	for (let attempt = 0; resolve === undefined && attempt < 5; attempt += 1) {
		await resolveNow();
		resolve = await session.until("a resolve's flow", (snapshot) => resolveIn(snapshot) !== undefined, 10_000).then(resolveIn, () => undefined);
	}

	assert.ok(resolve !== undefined, "a resolve's flow");
	// (its named child — a resolve may have another, inferred, from one alongside: resolveIn's own test)
	assert.ok(resolve.caused.some((child) => child.label === "bablr.resolve()" && child.inferred === undefined), "named, not inferred");
});

test("notes: a note goes with its code to another file", async () => {
	const workbench = session.workbench();
	const run = (step) => workbench.evaluate(async (what) => {
		const { api } = globalThis.__editor;
		const from = api.Uri.file("/workspace/moved-from.js");
		const notesOn = async (file) => {
			const folder = api.Uri.file("/workspace/.silo/notes");
			const [owner] = await api.workspace.fs.readDirectory(folder).then((entries) => entries.map(([name]) => name), () => []);
			const text = owner === undefined ? "" : await api.workspace.fs.readFile(api.Uri.joinPath(folder, owner, `${file}.jsonl`)).then((bytes) => new TextDecoder().decode(bytes), () => "");

			return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
		};

		switch (what) {
			case "add": {
				await api.workspace.fs.writeFile(from, new TextEncoder().encode("setup();\nshift(width, height);\nlog(1);\n"));

				const editor = await api.window.showTextDocument(from);
				const at = editor.document.getText().indexOf("shift(width, height)");

				editor.selection = new api.Selection(editor.document.positionAt(at), editor.document.positionAt(at + "shift(width, height)".length));

				return api.commands.executeCommand("notes.add", "mind the aspect ratio");
			}

			case "move": {
				// Pasted into another file, saved; cut from this one.
				await api.workspace.fs.writeFile(api.Uri.file("/workspace/moved-to.js"), new TextEncoder().encode("other();\nshift(width, height);\n"));

				const editor = await api.window.showTextDocument(from);
				const text = editor.document.getText();
				const at = text.indexOf("shift(width, height);\n");

				await editor.edit((builder) => {
					builder.delete(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "shift(width, height);\n".length)));
				});

				return undefined;
			}

			default:
				return { "from": await notesOn("moved-from.js"), "to": await notesOn("moved-to.js") };
		}
	}, step);

	const id = await run("add");

	await eventually("the note, kept", async () => (await run("notes")).from.some((note) => note.id === id) || undefined);
	await run("move");

	const moved = await eventually("the note, gone with its code", async () => (await run("notes")).to.find((note) => note.id === id));
	const left = (await run("notes")).from.find((note) => note.id === id);

	assert.equal(moved.ref.file, "moved-to.js");
	assert.equal(moved.placed?.strategy, "moved");
	assert.equal(left?.dismissed, true, "a tombstone where it was");
});

// findFiles (and the search view's include/exclude) honour their globs (components/monaco-vscode-api/workspace-search.ts):
// the search override's own provider ignored them and returned every file.
test("search: findFiles keeps to its glob, and to files.exclude unless told not to", async () => {
	const found = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const paths = async (include, exclude) => (await api.workspace.findFiles(include, exclude)).map((uri) => uri.path);

		// The search service samples 1 in 20 searches for telemetry, which reads the provider's stats: search often
		// enough that a sampled one surely comes along (1 - 0.95^100 > 99%).
		for (let index = 0; index < 100; index += 1) {
			await paths("**/package.json");
		}

		return { "manifests": await paths("**/package.json"), "sources": await paths("src/**"), "all": await paths("**/*"), "everything": await paths("**/*", null) };
	});

	assert.ok(found.manifests.length > 0 && found.manifests.every((path) => path.endsWith("/package.json")), "only package.json files");
	assert.ok(found.sources.length > 0 && found.sources.every((path) => path.startsWith("/workspace/src/")), "only what's under src/");
	assert.ok(found.all.every((path) => !path.includes("/node_modules/")), "files.exclude (node_modules) applies by default");
	assert.ok(found.everything.length > found.all.length, "and not when excludes are turned off");
});

// A default config the editor supplies (tsconfig.json) is the repo's to replace: deleted, the default shows through;
// written again, the new one is the workspace's — not refused because the default under it is read-only.
test("defaults: a deleted tsconfig.json falls back to the default, and a new one can be written over it", async () => {
	const found = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/tsconfig.json");
		const text = async () => new TextDecoder().decode(await api.workspace.fs.readFile(uri));
		const original = await text();

		await api.workspace.fs.delete(uri);

		const fallback = await text().catch((error) => `unreadable: ${error}`);
		const written = "{ \"compilerOptions\": { \"strict\": true } }\n";
		const write = await api.workspace.fs.writeFile(uri, new TextEncoder().encode(written)).then(() => "written", (error) => String(error));
		const after = await text();
		const readOnly = ((await api.workspace.fs.stat(uri)).permissions ?? 0) & 1;

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(original));

		return { "fallback": fallback.startsWith("unreadable") ? fallback : "default", "write": write, "after": after === written, "readOnly": readOnly, "restored": await text() === original };
	});

	assert.equal(found.fallback, "default", "deleted, the editor's default shows through");
	assert.equal(found.write, "written", "a new one can be written");
	assert.equal(found.after, true, "and it's what's read");
	assert.equal(found.readOnly, 0, "and it isn't read-only");
	assert.equal(found.restored, true);
});

// What the editor keeps, discovered from what was written and read (ARCHITECTURE.md, *Discovered, not declared*): by now the tour has
// run code (evidence, samples, runs), kept notes, and parsed with BABLR.
test("stores: discovered from what's written and read", async () => {
	const { discoveredStores } = await import("../shared/architecture-model.ts");
	const stores = new Map(discoveredStores(session.snapshot()).map((store) => [store.store, store]));
	const named = (store) => stores.get(store) ?? { "writers": [], "readers": [] };

	assert.ok(named(".silo/evidence/…/<file>.jsonl").writers.includes("workbench"), "runtime evidence, written by core");
	assert.ok(named(".silo/evidence/…/<file>.jsonl").readers.includes("ext:insights"), "and read by the insights extension");
	assert.ok(named(".silo/notes/…/<file>.jsonl").writers.includes("ext:notes"), "notes, written by the notes extension");
	assert.ok(named(".silo/runs/<file>.jsonl").writers.includes("workbench"), "each run's envelope");
	assert.ok(named(".silo/local/…/<file>.jsonl").writers.length > 0, "samples, on this machine");
	assert.ok(named("IndexedDB bablr").writers.includes("bablr"), "BABLR's cache of parses");
});

// The components inside one realm's hub, discovered (ARCHITECTURE.md, *Discovered, not declared*): the workbench's subscriptions, grouped by
// the function that registered them — or, in a minified build, by namespace — so core's BABLR and its runtime evidence
// come out as two parts of the workbench, not one.
test("components: a realm's hub, told apart by who subscribed", async () => {
	const { componentsOf } = await import("../shared/architecture-model.ts");
	const workbench = session.snapshot().topology.workbench;
	const components = componentsOf(workbench);
	const holding = (subject) => components.find((component) => component.subjects.includes(subject));

	assert.ok(holding("annotations.resolve()") !== undefined, "core's BABLR, serving annotations");
	assert.ok(holding("evidence.observed") !== undefined, "core's runtime evidence");
	assert.notEqual(holding("annotations.resolve()"), holding("evidence.observed"), "two components, not one");
	assert.deepEqual(holding("annotations.resolve()").subjects.filter((subject) => subject.startsWith("annotations.")), ["annotations.classify()", "annotations.refer()", "annotations.resolve()", "annotations.spans()"], "what one component serves stays together");
});

// Drawn on the view: each hub's components a row in its box, and a hub link's messages a line to the component that
// handles them — a note's resolve lands on core's BABLR component (startBablr, or `annotations` where the build kept no
// names), not on the workbench as a whole.
test("components: on the view, a message's line lands on the component that handles it", async () => {
	const { componentsOf } = await import("../shared/architecture-model.ts");
	const name = componentsOf(session.snapshot().topology.workbench).find((component) => component.subjects.includes("annotations.resolve()")).component;

	// The tour's files have taken its tab by now: open it again.
	await session.workbench().evaluate(() => globalThis.__editor.api.commands.executeCommand("architecture.open"));

	const lines = await eventually("the resolve's component line", async () => {
		const found = await session.workbench().evaluate(() => [...document.querySelectorAll("g[data-edge^='component:']")].map((line) => ({ "id": line.dataset.edge, "messages": line.querySelector("title")?.textContent.split("\n") ?? [] })));

		return found.some((line) => line.messages.includes("annotations.resolve()")) ? found : undefined;
	});
	const rows = await session.workbench().evaluate(() => [...document.querySelectorAll(".arch-component-row")].map((row) => row.dataset.node));

	assert.ok(rows.includes(`component:workbench:${name}`), "the component's row, in the workbench's box");
	const row = `component:workbench:${name}`;
	const resolve = lines.find((line) => line.messages.includes("annotations.resolve()")).id;

	assert.ok(resolve.endsWith(":" + row) || resolve.includes(":" + row + ":"), "the resolve, to that row");
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
