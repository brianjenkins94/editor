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

/** What a save selects, waited for — or, timed out, what happened instead: whether the file is still dirty (a save VS
 *  Code dropped selects nothing), the runs since the save (what started, when, and how it ended: none queued, one slow, or
 *  one that ran without its trace kept) and the traces kept on the file. NEXT.md *Watching*. */
async function afterSave(what, path, probe) {
	const saved = Date.now();

	return eventually(what, probe, 60_000).catch(async (error) => {
		const state = await session.workbench().evaluate(async ({ file, since }) => {
			const { api } = globalThis.__editor;
			const traces = await Promise.resolve(api.workspace.fs.readFile(api.Uri.file(`/workspace/.silo/local/traces/${file.slice("/workspace/".length)}.jsonl`))).then((bytes) => new TextDecoder().decode(bytes), () => "");

			return {
				"dirty": api.workspace.textDocuments.find((document) => document.uri.path === file)?.isDirty,
				"sessions": api.debug.activeDebugSession?.name,
				"traces": traces.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).map((trace) => `${trace.test?.id ?? trace.program ?? "(own)"} ${trace.trigger} ${trace.at}`).slice(-8),
				"since": since
			};
		}, { "file": path, "since": new Date(saved).toISOString() });
		const runs = await session.request("runs.list", {}, 10_000).then((listed) => listed.filter((run) => run.startedAt >= saved - 5000).map((run) => `${run.title} ${run.state} +${run.startedAt - saved}ms${run.endedAt === undefined ? "" : ` for ${run.endedAt - run.startedAt}ms`}`), (failed) => [String(failed)]);

		throw new Error(`${error.message} (${path} ${state.dirty === true ? "still dirty: the save didn't land" : "saved"}; runs since the save: ${JSON.stringify(runs)}; debugging ${state.sessions ?? "nothing"}; traces kept on it, latest last: ${JSON.stringify(state.traces)}; saved at ${state.since})`);
	});
}

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
// Tests (RUNNING.md, *Tests*): `node --test` runs a test file in the debugger on the editor's node:test, failing if a
// test did, and each test is kept as a trace on each file it ran — the declarations it executed there, by BABLR span.
test("tests: node --test keeps a trace of each test on each file it ran", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const write = (path, lines) => api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(lines.join("\n")));

		await write("/workspace/calc.js", ["function add(a, b) {", "\treturn a + b;", "}", "", "function subtract(a, b) {", "\treturn a - b;", "}", "", "module.exports = { add, subtract };", ""]);
		await write("/workspace/calc.test.js", ["const assert = require(\"node:assert\");", "const { describe, test } = require(\"node:test\");", "const { add, subtract } = require(\"./calc.js\");", "", "describe(\"calc\", () => {", "\ttest(\"adds\", () => {", "\t\tassert.equal(add(1, 2), 3);", "\t});", "", "\ttest(\"subtracts\", async () => {", "\t\tawait new Promise((resolve) => setTimeout(resolve, 5));", "\t\tassert.equal(subtract(3, 2), 1);", "\t});", "});", "", "test(\"fails\", () => {", "\tassert.equal(add(1, 1), 3);", "});", ""]);
		await write("/workspace/calc-add.test.js", ["const assert = require(\"node:assert\");", "const { test } = require(\"node:test\");", "const { add } = require(\"./calc.js\");", "", "test(\"adds\", () => {", "\tassert.equal(add(2, 2), 4);", "});", ""]);
	});
	// (two files, run one after the other and kept as they end: each test's trace on calc.js, none lost to the other's)
	await session.terminal("node --test calc.test.js calc-add.test.js", { "fresh": true });

	const run = await eventually("the test run's end", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title === "node --test calc.test.js" && each.state !== "running"), 60_000);

	assert.equal(run.exitCode, 1, "a test failed, so the run did");

	const keptOn = (file) => workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => ""), `/workspace/.silo/local/traces/${file}.jsonl`).then((text) => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).filter((trace) => trace.test !== undefined));
	let seen = [];
	const kept = await eventually("each test kept on calc.js", async () => {
		const traces = await keptOn("calc.js");

		seen = traces.map((trace) => trace.test.id);

		return traces.length >= 4 ? traces : undefined;
	}, 60_000).catch((error) => {
		// (what was kept by then, and what the page said of keeping and of the runs)
		const said = session.notable().filter((line) => /kept|keep|margin|node --test|debug\.start|tests/iu.test(line)).slice(-30);

		throw new Error(`${error.message}: kept ${JSON.stringify(seen)}\n${said.join("\n")}`, { "cause": error });
	});
	const of = (id) => kept.find((trace) => trace.test.id === id);

	assert.deepEqual([of("calc.test.js › calc › adds")?.test.outcome, of("calc.test.js › calc › subtracts")?.test.outcome, of("calc.test.js › fails")?.test.outcome, of("calc-add.test.js › adds")?.test.outcome], ["pass", "pass", "fail", "pass"]);
	// What each executed of calc.js: adds and fails ran add, subtracts ran subtract — one declaration each.
	assert.equal(of("calc.test.js › calc › adds").declarations.length, 1);
	assert.deepEqual(of("calc.test.js › fails").declarations, of("calc.test.js › calc › adds").declarations);
	assert.notDeepEqual(of("calc.test.js › calc › subtracts").declarations, of("calc.test.js › calc › adds").declarations);
	// And on the test file itself, each test's own body (not the runner's code, which is node:test's).
	assert.equal((await keptOn("calc.test.js")).length, 3);
});

// Selection (RUNNING.md, *Unattended runs*: "What runs"): a save runs again the test files whose tests executed code it
// changed — calc.test.js, which ran subtract — and not one whose tests didn't (calc-add.test.js runs add alone).
test("selection: a save reruns the tests that executed what changed, and only those", async () => {
	const workbench = session.workbench();
	const keptOn = (file) => workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => ""), `/workspace/.silo/local/traces/${file}.jsonl`).then((text) => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).filter((trace) => trace.test !== undefined));
	const testOf = (traces, id) => traces.find((trace) => trace.test.id === id);

	const before = await eventually("the tests kept on calc.js", async () => {
		const traces = await keptOn("calc.js");

		return testOf(traces, "calc-add.test.js › adds") === undefined || testOf(traces, "calc.test.js › calc › subtracts") === undefined ? undefined : traces;
	}, 60_000);

	// subtract edited and saved (the editor focused first, as typing there would leave it).
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/calc.js"));
		const text = editor.document.getText();
		const at = text.indexOf("return a - b;");

		await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "return a - b;".length)), "return a - b + 0;");
		});
		await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
	});
	await session.page.keyboard.press("ControlOrMeta+s");

	const after = await afterSave("calc.test.js run again, after the save", "/workspace/calc.js", async () => {
		const traces = await keptOn("calc.js");

		return testOf(traces, "calc.test.js › calc › subtracts")?.trigger === "edit" ? traces : undefined;
	});

	assert.notDeepEqual(testOf(after, "calc.test.js › calc › subtracts").declarations, testOf(before, "calc.test.js › calc › subtracts").declarations, "it ran the edited subtract");
	// Its file ran, each of its tests with it: adds ran as before, so it's the same trace, counted again.
	assert.equal(testOf(after, "calc.test.js › calc › adds").count, testOf(before, "calc.test.js › calc › adds").count + 1);
	assert.equal(testOf(after, "calc-add.test.js › adds").at, testOf(before, "calc-add.test.js › adds").at, "calc-add.test.js didn't run: nothing of it reached subtract");
	// On the architecture view: selection asked core's BABLR for the saved text's spans, by the bridge's command (its host's
	// totals go out a moment after; waited for here, so the diagram has it however the tour's timing falls).
	await session.until("running → the bridge, by command", hasLabel("ext:running", "ext:bridge", /^cmd editor\.annotations\.spans$/u), 30_000);

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor"));
});

// The program by feature (History's, drawn by core as the features map): as the manifest names them. A feature that owns
// calc.js by its path owns its code, and the tests whose traces ran it, as each last came out.
const CALCULATOR = { "Calculator": { "Arithmetic": { "what": "Adds and subtracts.", "paths": ["calc.js"] } } };

test("features: a feature's code and tests, from the manifest, on the features map", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async (manifest) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.createDirectory(api.Uri.file("/workspace/.silo"));
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/.silo/manifest.json"), new TextEncoder().encode(JSON.stringify(manifest, undefined, 2) + "\n"));
	}, CALCULATOR);

	const reading = await eventually("the feature, with its tests", async () => {
		const found = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features"));

		return found?.features?.find((each) => each.name === "Arithmetic")?.tests.length >= 4 ? found : undefined;
	}, 60_000);
	const index = reading.features.findIndex((each) => each.name === "Arithmetic");
	const arithmetic = reading.features[index];

	assert.equal(arithmetic.area, "Calculator");
	assert.deepEqual(reading.code.filter((code) => code.owners.includes(index) && code.name !== "(top)").map((code) => [code.file, code.name, code.owners.length]), [["calc.js", "add", 1], ["calc.js", "subtract", 1]]);
	assert.deepEqual(arithmetic.tests.map((test) => test.id), ["calc-add.test.js › adds", "calc.test.js › calc › adds", "calc.test.js › calc › subtracts", "calc.test.js › fails"]);
	assert.equal(arithmetic.tests.find((test) => test.id === "calc.test.js › fails").outcome, "fail");

	// The map, in its side bar: a card per area, a block for each feature in it, its name underlined when it's in focus.
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("features.map.focus"));
	await eventually("the map's blocks", async () => ((await workbench.evaluate(() => document.querySelectorAll(".fm-root .fm-chart rect").length)) > 0 || undefined), 30_000);
	assert.equal(await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features.focus", "Arithmetic")), true);
	assert.equal((await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features"))).focused, index);
	await eventually("its name marked in focus", async () => ((await workbench.evaluate(() => document.querySelector(".fm-root span.fm-focused")?.textContent ?? "")).startsWith("Arithmetic") || undefined), 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features.unfocus"));
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// A feature's decision, set in the editor (Features: Set Feature Status…): into the feature ledger,
// .silo/features.json — shared, so it's committed with the code — by its name and the files of the code only it owns.
test("features: a feature's status, set in the editor, goes into the ledger", async () => {
	const workbench = session.workbench();

	assert.equal(await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features.setStatus", "Arithmetic", "parked", "not worked on for now")), true);

	const ledger = JSON.parse(await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file("/workspace/.silo/features.json")).then((bytes) => new TextDecoder().decode(bytes))));

	assert.deepEqual({ ...ledger["Arithmetic"], "since": "" }, { "status": "parked", "why": "not worked on for now", "since": "", "paths": ["calc.js"] });
	assert.equal((await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.features"))).features.find((feature) => feature.name === "Arithmetic")?.status, "parked", "the view shows it");

	// On the architecture view, the ledger is a store History writes and reads (waited for: its host's totals go out a
	// moment after).
	const { discoveredStores } = await import("../shared/architecture-model.ts");

	await session.until("History writing and reading the ledger", (snapshot) => {
		const ledger = discoveredStores(snapshot).find((store) => store.store === ".silo/<file>.json");

		return ledger?.writers.includes("ext:history") === true && ledger.readers.includes("ext:history");
	}, 30_000);
});

// The ledger's drift in Problems (packages/silo/README.md, *The feature ledger*: "In the editor"): `silo check`'s checks,
// held to the workspace by History — a feature stopped while its code is still there is a problem on the ledger, at its
// entry, until the code or the decision changes.
test("features: the ledger's drift in Problems — stopped but present, until the decision changes", async () => {
	const workbench = session.workbench();
	const ledgerFile = "/workspace/.silo/features.json";
	const read = () => workbench.evaluate((file) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(file)).then((bytes) => new TextDecoder().decode(bytes)), ledgerFile);
	const write = (text) => workbench.evaluate(([file, contents]) => globalThis.__editor.api.workspace.fs.writeFile(globalThis.__editor.api.Uri.file(file), new TextEncoder().encode(contents)), [ledgerFile, text]);
	const problems = () => workbench.evaluate((file) => globalThis.__editor.api.languages.getDiagnostics(globalThis.__editor.api.Uri.file(file)).filter((each) => each.source === "silo").map((each) => ({ "line": each.range.start.line, "message": each.message })), ledgerFile);
	const before = await read();
	const ledger = JSON.parse(before);

	await write(JSON.stringify({ ...ledger, "calculator": { "status": "stopped", "why": "replaced by the spreadsheet", "since": "2026-10-25", "paths": ["calc.js"] } }, undefined, "\t") + "\n");

	try {
		const found = await eventually("the drift, in Problems", async () => (await problems()).find((each) => each.message.startsWith("stopped but present: ")), 60_000);
		const lines = (await read()).split("\n");

		assert.ok(lines[found.line].includes("\"calculator\""), `at its entry: ${JSON.stringify(found)}`);
		assert.match(found.message, /change the code: .+; or the decision: /u, "both ways out");

		// The decision changes: active again — the problem goes.
		await write(JSON.stringify({ ...ledger, "calculator": { "status": "active", "why": "kept after all", "since": "2026-10-25", "paths": ["calc.js"] } }, undefined, "\t") + "\n");
		await eventually("the drift, gone", async () => ((await problems()).length === 0 || undefined), 60_000);
	} finally {
		await write(before);
	}
});

// Dormant ways in, where they're registered (packages/silo/README.md, *The feature ledger*: "In the editor"): what `silo
// check` lists — CI's records load a way in's files and never run its own code — marked in the evidence's purple with
// its price, Keep and Remove writing the ledger as `silo status` and `silo remove` would.
test("features: a dormant way in is marked where it's registered, and Keep / Remove write the ledger", async () => {
	const workbench = session.workbench();
	const write = (files) => workbench.evaluate(async (entries) => {
		const { api } = globalThis.__editor;

		for (const [path, text] of entries) {
			await api.workspace.fs.writeFile(api.Uri.file("/workspace/" + path), new TextEncoder().encode(text));
		}
	}, Object.entries(files));
	const read = (path) => workbench.evaluate((file) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file("/workspace/" + file)).then((bytes) => new TextDecoder().decode(bytes), () => undefined), path);
	const dormantIn = (path) => workbench.evaluate((file) => globalThis.__editor.api.languages.getDiagnostics(globalThis.__editor.api.Uri.file("/workspace/" + file)).filter((each) => each.source === "silo" && each.message.startsWith("dormant: ")).map((each) => ({ "line": each.range.start.line, "message": each.message })), path);
	const ledgerBefore = await read(".silo/features.json");

	// Two commands a test loaded the files of and never ran: tidy's handler in the file that registers it, archive's in a
	// file of its own.
	await write({
		"archiver/package.json": JSON.stringify({ "name": "archiver", "contributes": { "commands": [{ "command": "archiver.archive", "title": "Archive" }, { "command": "archiver.tidy", "title": "Tidy" }] } }, undefined, "\t") + "\n",
		"archiver/archive.ts": "export function archive(): number {\n\treturn 1;\n}\n",
		"archiver/extension.ts": "import { archive } from \"./archive\";\n\nexport function activate(context: any): void {\n\tcontext.subscriptions.push(vscode.commands.registerCommand(\"archiver.archive\", archive), vscode.commands.registerCommand(\"archiver.tidy\", tidy));\n}\n\nfunction tidy(): number {\n\treturn 2;\n}\n",
		".silo/evidence/ci/architecture.json": JSON.stringify({ "reach": { "archiver/extension.ts": { "(top level), activate": [1] }, "archiver/archive.ts": { "(top level)": [1] } } }) + "\n"
	});

	try {
		await workbench.evaluate(() => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file("/workspace/archiver/extension.ts")));

		const found = await eventually("the two dormant ways in, at their registration", async () => {
			const each = await dormantIn("archiver/extension.ts");

			return each.length >= 2 ? each : undefined;
		}, 90_000);

		assert.ok(found.every((each) => each.line === 3), `on the line that registers them: ${JSON.stringify(found)}`);
		assert.match(found.find((each) => each.message.includes("archiver.archive")).message, /^dormant: command archiver\.archive — CI's runs load its files and never run its code; deleting it frees .*1 file/u, "its price: archive.ts is only its");

		// Purple, beside it: the lightbulb's two ways out.
		const actions = await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;
			const uri = api.Uri.file("/workspace/archiver/extension.ts");

			return (await api.commands.executeCommand("vscode.executeCodeActionProvider", uri, new api.Range(3, 0, 3, 200))).map((action) => action.title);
		});

		assert.ok(actions.includes("Keep \"archiver.tidy\" for 90 days…") && actions.includes("Remove \"archiver.archive\"…"), JSON.stringify(actions));

		// Keep: an active entry, by its key, that asks again in 90 days — and it's not dormant any more.
		assert.equal(await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.ledger.keep", "command|archiver.tidy", "the tour's")), true);

		const kept = JSON.parse(await read(".silo/features.json"))["archiver.tidy"];

		assert.deepEqual([kept.status, kept.why, kept.key], ["active", "the tour's", "command|archiver.tidy"]);
		assert.equal(kept.until, new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10));
		await eventually("tidy, decided", async () => ((await dormantIn("archiver/extension.ts")).every((each) => !each.message.includes("archiver.tidy")) || undefined), 60_000);

		// Remove: archive.ts, only its, deleted; its manifest entry gone; its tombstone; the registration left by hand.
		const removed = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("history.ledger.remove", "command|archiver.archive", "the tour's"));

		assert.equal(removed.nothing, false);
		assert.deepEqual(removed.files, ["archiver/archive.ts"]);
		assert.deepEqual(removed.manifests, ["archiver/package.json"]);
		assert.match(removed.text, /its way in, to take out by hand: where archiver\/extension\.ts states it/u);
		assert.equal(await read("archiver/archive.ts"), undefined, "deleted");
		assert.deepEqual(JSON.parse(await read("archiver/package.json")).contributes.commands.map((each) => each.command), ["archiver.tidy"]);

		const tombstone = JSON.parse(await read(".silo/features.json"))["archiver.archive"];

		assert.deepEqual([tombstone.status, tombstone.key, tombstone.paths], ["removed", "command|archiver.archive", ["archiver/archive.ts"]]);
		assert.match(tombstone.restore ?? "", /^git checkout \S+ -- archiver\/archive\.ts$/u);
	} finally {
		await workbench.evaluate(async (ledger) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("workbench.action.closeActiveEditor");

			for (const path of ["archiver", ".silo/evidence/ci"]) {
				await api.workspace.fs.delete(api.Uri.file("/workspace/" + path), { "recursive": true }).then(() => undefined, () => undefined);
			}

			if (ledger !== undefined) {
				await api.workspace.fs.writeFile(api.Uri.file("/workspace/.silo/features.json"), new TextEncoder().encode(ledger));
			}
		}, ledgerBefore);
	}
});

// Beyond a file's own tests (RUNNING.md, *Unattended runs*: "What runs"): a program's run is kept on each module it
// imported too, by the declarations it ran there (lib traces' `program`), so editing one re-runs the programs that ran
// what changed — and only those.
test("selection: an edit to an imported module reruns the programs that ran what changed, and only those", async () => {
	const workbench = session.workbench();
	const write = (path, text) => workbench.evaluate(async ([file, contents]) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(file), new TextEncoder().encode(contents));
	}, [path, text]);
	const reachOn = (file) => workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => ""), `/workspace/.silo/local/traces/${file}.jsonl`).then((text) => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).filter((trace) => trace.program !== undefined));
	const programOf = (traces, program) => traces.find((trace) => trace.program === program);
	const files = ["/workspace/shapes.js", "/workspace/report.js", "/workspace/fence.js"];

	await write(files[0], "export function area(r) {\n\treturn 3 * r * r;\n}\n\nexport function perimeter(r) {\n\treturn 6 * r;\n}\n");
	await write(files[1], "import { area } from \"./shapes.js\";\n\nconsole.log(area(2));\n");
	await write(files[2], "import { perimeter } from \"./shapes.js\";\n\nconsole.log(perimeter(2));\n");

	try {
		assert.deepEqual((await session.request("debug.start", { "program": files[1], "breakpoints": [] }, 60_000)).output, ["12"]);
		assert.deepEqual((await session.request("debug.start", { "program": files[2], "breakpoints": [] }, 60_000)).output, ["12"]);

		const before = await eventually("both programs' reach, kept on shapes.js", async () => {
			const traces = await reachOn("shapes.js");

			return programOf(traces, "report.js") === undefined || programOf(traces, "fence.js") === undefined ? undefined : traces;
		}, 60_000);

		assert.notDeepEqual(programOf(before, "report.js").declarations, programOf(before, "fence.js").declarations, "each ran its own function of it");

		// area edited and saved.
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;
			const editor = await api.window.showTextDocument(api.Uri.file("/workspace/shapes.js"));
			const at = editor.document.getText().indexOf("3 * r * r");

			await editor.edit((builder) => {
				builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "3 * r * r".length)), "Math.PI * r * r");
			});
			await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
		});
		await session.page.keyboard.press("ControlOrMeta+s");

		const after = await afterSave("report.js run again, after the save", "/workspace/shapes.js", async () => {
			const traces = await reachOn("shapes.js");

			return programOf(traces, "report.js")?.trigger === "edit" ? traces : undefined;
		});

		assert.notDeepEqual(programOf(after, "report.js").declarations, programOf(before, "report.js").declarations, "it ran the edited area");
		assert.equal(programOf(after, "fence.js").at, programOf(before, "fence.js").at, "fence.js didn't run: nothing of it reached area");
	} finally {
		await workbench.evaluate(async (paths) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

			for (const path of paths) {
				await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
			}
		}, files);
	}
});

// Halting (RUNNING.md, *Unattended runs*): a run a save selected, which nobody's looking at, gives a call what it returned
// the last time it ran for real — and halts before one that never did, its line saying so with Rule… and Pin…. Pinning
// a value is a rule: runs after an edit are given it.
test("halt: a selected run halts before a call that never ran for real, and a pinned value is a rule", async () => {
	const workbench = session.workbench();
	const url = "https://rates.example.test/eur";

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const write = (path, lines) => api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(lines.join("\n")));

		await write("/workspace/rates.js", ["async function rate() {", "\treturn 2;", "}", "", "module.exports = { rate };", ""]);
		await write("/workspace/rates.test.js", ["const assert = require(\"node:assert\");", "const { test } = require(\"node:test\");", "const { rate } = require(\"./rates.js\");", "", "test(\"rate\", async () => {", "\tassert.equal(await rate(), 2);", "});", ""]);
	});
	await session.terminal("node --test rates.test.js", { "fresh": true });
	await eventually("rates.test.js's test kept on rates.js", async () => (await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file("/workspace/.silo/local/traces/rates.js.jsonl")).then((bytes) => new TextDecoder().decode(bytes), () => ""))).includes("rates.test.js › rate") || undefined, 60_000);

	// rate() now fetches — a call no run ever made for real — and the save selects rates.test.js, which ran rate.
	await workbench.evaluate(async (address) => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/rates.js"));
		const text = editor.document.getText();
		const at = text.indexOf("return 2;");

		await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "return 2;".length)), `const response = await fetch("${address}");\n\n\treturn Number(await response.text());`);
		});
		await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
	}, url);
	await session.page.keyboard.press("ControlOrMeta+s");

	const state = await eventually("the selected run halted on rates.js", async () => {
		const found = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "rates.js").catch(() => undefined));

		return found?.end?.kind === "stopped" && /halted before net/u.test(found.end.message ?? "") ? found : undefined;
	}, 60_000);
	const halt = state.values.find((row) => row.label === "halted");

	assert.match(state.end.message, new RegExp(`halted before net ${url.replaceAll(".", "\\.")}: it never ran for real`, "u"));
	assert.deepEqual(halt?.cells, [`net ${url}`], "the call it halted before, on its line");
	assert.ok(await workbench.evaluate(() => [...document.querySelectorAll("wa-button, button")].some((button) => button.textContent.trim() === "Pin…")), "Pin… on its line");

	// Pinning a value: a rule in my policy — runs after an edit give the call that value.
	assert.equal(await workbench.evaluate(([address, line]) => globalThis.__editor.api.commands.executeCommand("margin.pin", "file:///workspace/rates.js", "net", address, line, "2"), [url, halt.line - 1]), true);

	const rules = await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const folder = api.Uri.file("/workspace/.silo/policy");
		const files = await api.workspace.fs.readDirectory(folder);

		return (await Promise.all(files.map(async ([name]) => new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.joinPath(folder, name)))))).join("\n");
	});

	assert.ok(rules.includes(url) && rules.includes("\"trigger\""), "the pin, a rule for runs after an edit");
	// On the architecture view: the pin runs the file again by the running extension's command (waited for: its host's
	// totals go out a moment after).
	await session.until("the Margin → running, by command", hasLabel("ext:margin", "ext:running", /^cmd run\.live\.again$/u), 30_000);

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor"));
});

// A picked run (a ball of the Margin's) shows its own coverage, not the latest run's: kept with each run as it came.
test("runs kept: picking an older run shows its own coverage", async () => {
	const workbench = session.workbench();
	const uri = "file:///workspace/pick.js";
	const edit = async (from, to) => {
		await workbench.evaluate(async ([find, replace]) => {
			const { api } = globalThis.__editor;
			const editor = api.window.activeTextEditor;
			const at = editor.document.getText().indexOf(find);

			await editor.edit((builder) => {
				builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + find.length)), replace);
			});
			await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
		}, [from, to]);
		await session.page.keyboard.press("ControlOrMeta+s");
	};

	const state = () => workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "pick.js").catch(() => undefined));
	const kindAt = (found, line) => found.marks.find((mark) => mark.line === line && mark.kind.startsWith("coverage-"))?.kind;
	// (each branch's line as the file is now, 1-based: a save's fixes can move lines)
	const lineOf = (text) => workbench.evaluate((find) => globalThis.__editor.api.window.activeTextEditor.document.getText().split("\n").findIndex((line) => line.includes(find)) + 1, text);

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/pick.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["const x = 1;", "", "if (x > 0) {", "\tconsole.log(\"positive\");", "} else {", "\tconsole.log(\"negative\");", "}", ""].join("\n")));
		await api.window.showTextDocument(uri);
	});
	await edit("const x = 1;", "const x = 2;");
	await eventually("the first run's coverage", async () => (kindAt(await state() ?? { "marks": [] }, await lineOf("positive")) === "coverage-ran" || undefined), 60_000);
	await edit("const x = 2;", "const x = -2;");

	const latest = await eventually("the second run, and its coverage", async () => {
		const found = await state();

		return found?.runs.length >= 2 && kindAt(found, await lineOf("negative")) === "coverage-ran" ? found : undefined;
	}, 60_000);

	const positive = await lineOf("positive");
	const negative = await lineOf("negative");

	assert.notEqual(kindAt(latest, positive), "coverage-ran", "the latest run took the other branch");

	const older = latest.runs.at(-2);

	await workbench.evaluate(([file, id]) => globalThis.__editor.api.commands.executeCommand("margin.pickRun", file, id), [uri, older.id]);

	const picked = await eventually("the older run, picked", async () => {
		const found = await state();

		return found?.runs.find((run) => run.id === older.id)?.picked === true ? found : undefined;
	});

	assert.equal(kindAt(picked, positive), "coverage-ran", "its own: the branch it took");
	assert.notEqual(kindAt(picked, negative), "coverage-ran");

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor"));
});

// A long run's ball follows it as it goes (RUNTIME-EVIDENCE.md, *Runs kept, as balls*): out beside the line the run is on
// while it's still going — past the bounds on what's kept of its values, into its second loop — and settling where it
// ended once it has, not rolled again from the top. (A Run: a live run on a save stops at a million statements.)
test("runs kept: a long run's ball follows it while it goes, then settles", async () => {
	const workbench = session.workbench();
	const program = "/workspace/loops.js";
	const state = () => workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "loops.js").catch(() => undefined));
	// (the ball, and the text of the code line beside its centre)
	const ball = () => workbench.evaluate(() => {
		const element = [...document.querySelectorAll(".notes-margin-ball")].find((each) => !each.hidden);

		if (element === undefined) {
			return { "out": false };
		}

		const { top, height } = element.getBoundingClientRect();
		const beside = [...document.querySelectorAll(".view-lines .view-line")].find((line) => {
			const rect = line.getBoundingClientRect();

			return rect.top <= top + height / 2 && top + height / 2 < rect.bottom;
		});

		return { "out": true, "settled": element.classList.contains("settled"), "line": beside?.textContent.replace(/\s+/gu, " ").trim() ?? null };
	});

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["let total = 0;", "", "for (let i = 0; i < 3000000; i += 1) {", "\ttotal += i % 7;", "}", "", "let count = 0;", "", "for (let j = 0; j < 3000000; j += 1) {", "\tcount += j % 3;", "}", "", "console.log(total, count);", ""].join("\n")));
		await api.window.showTextDocument(uri);
	}, program);

	const ran = session.request("debug.start", { "program": program, "breakpoints": [] }, 120_000);
	// Going: its ball in the strip has no colour yet, and the gutter's is out beside the line the run is on.
	const going = (lines) => eventually(`the run's ball, out beside ${lines} while it goes`, async () => {
		const [found, shown] = [await state(), await ball()];

		return found?.runs.at(-1)?.state === undefined && shown.out && !shown.settled && lines.test(shown.line ?? "") ? { ...shown, "dropped": found.dropped } : undefined;
	}, 60_000);

	// (in the second loop: past the first's 50 turns kept, where it is comes with each batch all the same — and what
	// wasn't kept is counted as it goes)
	const second = await going(/count \+= j % 3|j < 3000000/u);

	assert.ok(second.dropped > 3_000_000, `the first loop's values dropped by then: ${JSON.stringify(second)}`);
	assert.deepEqual((await ran).output, ["8999994 3000000"]);

	// Ended: it ran, and the ball settles where it was rather than rolling from the top again.
	await eventually("the run, ended", async () => ((await state())?.runs.at(-1)?.state === "ran" || undefined), 30_000);

	// (the pane draws its ball a moment after the Margin's state says so)
	await eventually("the ball, settled where the run ended — not rolled again from the top", async () => {
		const shown = await ball();

		return !shown.out || shown.settled || undefined;
	}, 10_000);
	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.closeActiveEditor");
		await api.workspace.fs.delete(api.Uri.file(path));
	}, program);
});

// Purity (packages/silo/README.md, *Purity*): each function's card says what silo's static check judges it — and one
// judged pure that a run saw write outside itself says so: here, through a getter, which the check assumes has no
// effects (an assumption broken: a finding).
test("purity: a function's verdict on its card, and a pure one a run saw write outside, flagged", async () => {
	const workbench = session.workbench();
	const state = () => workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "getter.ts").catch(() => undefined));
	const card = (found, title) => found?.cards.find((each) => each.title === title);

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/getter.ts");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["const counter = { n: 0 };", "const box = { get value() { counter.n += 1; return 1; } };", "", "function read(o: { value: number }) {", "\treturn o.value;", "}", "", "function add(a: number, b: number) {", "\treturn a + b;", "}", "", "console.log(read(box), add(1, 2));", ""].join("\n")));

		const editor = await api.window.showTextDocument(uri);
		const at = editor.document.getText().indexOf("add(1, 2)");

		await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "add(1, 2)".length)), "add(2, 3)");
		});
		await api.commands.executeCommand("workbench.action.focusActiveEditorGroup");
	});
	await session.page.keyboard.press("ControlOrMeta+s");

	const found = await eventually("the cards, with their purity and the run's writes", async () => {
		const current = await state();

		return card(current, "add")?.purity !== undefined && card(current, "read")?.flagged !== undefined ? current : undefined;
	}, 60_000);

	assert.equal(card(found, "add").purity, "pure");
	assert.equal(card(found, "add").flagged, undefined, "a pure function the run saw keep to itself");
	assert.equal(card(found, "read").purity, "pure", "judged pure statically: a getter's effects are assumed away");
	// (the getter's line: a save's ESLint fixes may have spread it over several)
	assert.match(card(found, "read").flagged, /^judged pure, but wrote n \(line [23]\)$/u, "the run saw it write outside itself, through the getter");

	// A statement inside another (the getter's, inside box's) on its own line, not stacked under the outer one's: when the
	// save spread the getter over lines, its row is beside its line.
	const tops = await workbench.evaluate(() => {
		const row = [...document.querySelectorAll(".notes-margin-cell .live-values-row")].find((each) => each.querySelector(".live-values-label")?.textContent.trim().startsWith("counter.n"));
		const line = [...document.querySelectorAll(".view-line")].find((each) => each.textContent.includes("counter.n += 1"));

		return { "row": row?.getBoundingClientRect().top, "line": line?.getBoundingClientRect().top, "spread": line !== undefined && !line.textContent.includes("const box") };
	});

	if (tops.spread) {
		assert.ok(Math.abs(tops.row - tops.line) < 1, `the getter's row beside its line (row at ${tops.row}, line at ${tops.line})`);
	}

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor"));
});

// Purity from runs (packages/silo/README.md, *Purity*): what the static check can't decide — a call through `any`, whose
// code isn't known — runs answer, kept as evidence at the function's span across recorded runs: "seen 1,000 times, never
// impure", and more as more runs see it, the span the same while the function's own code is; a call into code no run can
// see into (almostnode's `path`) never says "never impure".
test("purity from runs: a function the check calls unknown, run often and never impure, says so on its card", async () => {
	const workbench = session.workbench();
	const state = () => workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "dispatch.ts").catch(() => undefined));
	const card = (found, title) => found?.cards.find((each) => each.title === title);
	const runs = new Set();
	const run = async (times) => {
		await workbench.evaluate(async (count) => {
			const { api } = globalThis.__editor;
			const uri = api.Uri.file("/workspace/dispatch.ts");

			await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["import path from \"node:path\";", "", "const doubler: any = { \"double\": (x: number) => x * 2 };", "", "function twice(o: any, x: number) {", "\treturn o.double(x);", "}", "", "function joined(parts: string[]) {", "\treturn path.join(...parts);", "}", "", "let total = 0;", "", `for (let i = 0; i < ${count}; i += 1) {`, "\ttotal += twice(doubler, i);", "}", "", "console.log(total, joined([\"a\", \"b\"]));", ""].join("\n")));
			const editor = await api.window.showTextDocument(uri);

			// (a run takes the open document's text: the rewrite in it first)
			for (let tries = 0; tries < 100 && !editor.document.getText().includes(`i < ${count};`); tries += 1) {
				await new Promise((resolve) => {
					setTimeout(resolve, 100);
				});
			}
		}, times);
		// (a recorded run — Run, F5, a test's: a save's live run keeps no evidence)
		await session.request("debug.start", { "program": "/workspace/dispatch.ts" }, 60_000);
		await eventually("its run, ended", async () => {
			const ended = (await session.request("runs.list", undefined, 5000)).find((each) => each.title.endsWith("dispatch.ts") && each.state === "exited" && !runs.has(each.id));

			if (ended !== undefined) {
				runs.add(ended.id);
			}

			return ended;
		}, 60_000);
	};

	await run(1000);

	const first = await eventually("twice's card, with what the run saw", async () => {
		const current = await state();

		return card(current, "twice")?.seen !== undefined && card(current, "joined")?.seen !== undefined ? current : undefined;
	}, 60_000);

	assert.equal(card(first, "twice").purity, "unknown", "a call through any: which code runs isn't known statically");
	assert.equal(card(first, "twice").seen, "seen 1,000 times, never impure");
	assert.equal(card(first, "twice").flagged, undefined);
	assert.equal(card(first, "joined").seen, "seen once, never impure where runs could see", "path.join is almostnode's: code a run can't see into");

	// Another run, the loop's count changed but not twice: its evidence adds up at the same span.
	await run(500);

	let said;
	const second = await eventually("twice's card, with both runs", async () => {
		const current = await state();

		said = card(current, "twice")?.seen;

		return said === "seen 1,500 times, never impure" ? current : undefined;
	}, 60_000).catch((error) => {
		throw new Error(`${error.message} — it says: ${said}`, { "cause": error });
	});

	assert.equal(card(second, "twice").purity, "unknown");

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.closeActiveEditor");
		await api.workspace.fs.delete(api.Uri.file("/workspace/dispatch.ts"));
	});
});

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
