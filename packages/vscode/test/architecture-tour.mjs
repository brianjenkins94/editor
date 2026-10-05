/**
 * Architecture tour: the paths a routine session never takes — a second preview, a node script under the tsval
 * debugger, a cold provoke round, a webview, the git review diff, and this checkout's debug-mcp — each checked
 * against what the live architecture view observed. Slower than the smoke test;
 * run it when the probes or those paths change.
 *
 *   node --test test/architecture-tour.mjs      (see architecture-harness.mjs for the browser + dev server)
 *
 * The observed snapshot is left in $TMPDIR/architecture-tour.json; declared channels still unseen are printed.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { until } from "@brianjenkins94/util/until";

import { alive, hasLabel, startSession } from "./architecture-harness.mjs";

const { channels, seenChannels } = await import("../architecture-model.ts");

let session;

before(async () => {
	session = await startSession({ "debugMcp": true });
	await session.until("the node worker", alive("node"));
});

after(async () => {
	const current = session?.snapshot();

	if (current !== undefined) {
		const seen = seenChannels(current.channels.map((channel) => ({ ...channel, "labels": new Map(Object.entries(channel.labels)) })));

		console.log("declared channels not seen:\n  " + channels.filter((channel) => !seen.has(channel)).map((channel) => `${channel.a} ⇄ ${channel.b}`).join("\n  "));
	}

	await session?.close("architecture-tour");
});

test("debug-mcp: this checkout's debug-mcp joins the hub tree", async () => {
	await session.until("root ⇄ debug-mcp", hasLabel("root", "debug-mcp", /^hello$/u));
});

test("previews: two dev servers side by side", async () => {
	await session.terminal("npm run dev");
	await session.until("preview :5173", hasLabel("preview:5173", "sw", /^GET /u));
	await session.terminal("cd apps/second && npm run dev", { "fresh": true });
	await session.until("preview :5174", hasLabel("preview:5174", "sw", /^GET /u));
	await session.until("its dev server", alive("vite:5174"));

	// Its modules instrumented for runtime evidence (RUNTIME-EVIDENCE.md, the third slice): the page runtime the tap
	// carries has counted what the app's own code did, by file and version, in the original source's positions.
	const counted = await eventually("the preview's runtime evidence", async () => {
		const frame = session.page.frames().find((each) => /\/__virtual__\/[^/]+\/5173\//u.test(each.url()));
		const modules = frame === undefined ? [] : await frame.evaluate(() => globalThis.__evidence?.evidence() ?? []).catch(() => []);
		const ran = modules.filter((module) => module.statements.some((statement) => statement.count > 0));

		return ran.length > 0 ? modules : undefined;
	});

	assert.ok(counted.every((module) => module.file.startsWith("/workspace/") && !module.file.includes("/node_modules/")), "workspace modules only");
	assert.ok(counted.every((module) => /^[0-9a-f]{40}$/u.test(module.version)), "each by its version: the source's blob oid");
});

// A preview run's runtime evidence (RUNTIME-EVIDENCE.md, the third slice): its pages count what its modules did, an HMR
// edit brings a second version of one, and when it stops, both versions are folded into the file's evidence — the
// statements the edit didn't touch counted across both — and the run's envelope lists both.
test("evidence: a preview run, across a hot update", async () => {
	const write = (files) => session.workbench().evaluate(async (all) => {
		const { api } = globalThis.__editor;

		// (The workspace's file system makes no parents.)
		await api.workspace.fs.createDirectory(api.Uri.file("/workspace/evapp/src"));

		for (const [path, text] of Object.entries(all)) {
			await api.workspace.fs.writeFile(api.Uri.file(`/workspace/evapp/${path}`), new TextEncoder().encode(text));
		}
	}, files);
	const main = (word) => `const box = document.getElementById("out");\nfunction label(n?: number) { return n ?? "${word}"; }\nif (box) { box.textContent = String(label(1)) + String(label()); }\n`;

	await write({
		"package.json": JSON.stringify({ "name": "evapp", "private": true, "type": "module", "scripts": { "dev": "vite" } }),
		// eslint-disable-next-line webawesome/no-html-in-strings -- the test app's own page, written to the workspace as a file
		"index.html": "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body><div id=\"out\"></div><script type=\"module\" src=\"./src/main.tsx\"></script></body></html>",
		"src/main.tsx": main("none")
	});
	await session.terminal("cd /workspace/evapp && npm run dev", { "fresh": true });

	const run = await eventually("its run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.cwd === "/workspace/evapp" && each.state === "running"));
	const versions = () => eventually("the page's counts", async () => {
		const frame = session.page.frames().find((each) => each.url().includes(`/${run.port}/`) && each.url().includes("/__virtual__/"));
		const modules = frame === undefined ? [] : await frame.evaluate(() => globalThis.__evidence?.evidence() ?? []).catch(() => []);

		return modules.filter((module) => module.file === "/workspace/evapp/src/main.tsx");
	});

	await eventually("the first version counted", async () => (await versions()).length === 1 || undefined);
	// An HMR edit: the module re-imported as a second version (a .tsx module accepts its own updates).
	await write({ "src/main.tsx": main("nada") });
	await eventually("the second version counted", async () => (await versions()).length === 2 || undefined);
	await session.request("runs.stop", { "id": run.id }, 5000);

	const found = await eventually("its evidence", () => session.workbench().evaluate(async (id) => {
		const { api } = globalThis.__editor;
		const text = (uri) => api.workspace.fs.readFile(uri).then((bytes) => new TextDecoder().decode(bytes), () => "");
		const find = async (folder, name) => {
			for (const [entry, type] of await api.workspace.fs.readDirectory(folder).then((all) => all, () => [])) {
				const child = api.Uri.joinPath(folder, entry);
				const hit = type === api.FileType.Directory ? await find(child, name) : entry === name ? await text(child) : undefined;

				if (hit !== undefined) {
					return hit;
				}
			}

			return undefined;
		};
		const evidence = await find(api.Uri.file("/workspace/.silo/evidence"), "main.tsx.jsonl");
		const runsFolder = api.Uri.file("/workspace/.silo/runs");
		let envelope;

		for (const [name] of await api.workspace.fs.readDirectory(runsFolder).then((all) => all, () => [])) {
			const line = (await text(api.Uri.joinPath(runsFolder, name))).split("\n").find((each) => each.includes(id));

			envelope = line === undefined ? envelope : JSON.parse(line);
		}

		return evidence === undefined || envelope === undefined ? undefined : { "lines": evidence.trim().split("\n").map((line) => JSON.parse(line)), "envelope": envelope };
	}, run.id));

	assert.equal(found.envelope.environment.runtime, "preview");
	assert.equal(found.envelope.versions?.["evapp/src/main.tsx"]?.length, 2, "both versions it ran");
	assert.ok(found.lines.some((line) => line.kind === "reached" && line.ever === 1 && line.w >= 2), "a statement the edit didn't touch, run by both versions: one run, counted twice");
	assert.ok(found.lines.some((line) => line.kind === "value" && line.nullish >= 1), "n ?? …: undefined once");
	assert.ok(found.lines.some((line) => line.kind === "branch"), "the if's arms");
});

test("provoke: a cold transform round in a child worker", async () => {
	await session.request("preview.provoke", { "rounds": 1, "hardReset": true }, 90_000);
	await session.until("node ⇄ provoke worker", hasLabel("node", "provoke", /./u));
	await session.until("the provoke worker's mount", hasLabel("provoke", "zenfs", /^mount /u));
});

// A task — `node <file>` that runs to completion — runs under the tsval debugger (the debug worker), and a
// capability-gated call pauses it.
test("node script: a task runs under the tsval debugger, with its render surface", async () => {
	await session.terminal(`echo "require('fs').writeFileSync('/workspace/tour-out.txt', 'tour');" > tour.js && node tour.js`, { "fresh": true });
	await session.until("the debug worker", alive("debug-worker"));
	await session.until("the debug session's launch", hasLabel("pod", "debug-worker", /^debug\.session\..+\.control$/u));
	await session.until("the tsval render surface", hasLabel("shell", "tsval-preview", /^init/u));

	// One run, one id: the registry's run is the debug session's (its launch config carries it).
	const run = await eventually("the run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title === "node tour.js" && each.state === "running"));
	const sessionRun = await session.workbench().evaluate(() => globalThis.__editor.api.debug.activeDebugSession?.configuration.__runId);

	assert.equal(sessionRun, run.id, "the session carries the registry's run id");
});

// A session VS Code starts itself (F5, Run and Debug, debug_start) is a run in the registry too, ended with the session.
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
	assert.match(ignore, /^local\/$/mu, "what stays on the machine");

	// BABLR's work, kept by content on this machine: f5.js's parse, in the BABLR worker's own IndexedDB (not the
	// workspace), keyed by parse version and blob oid — and nothing left of the caches earlier builds kept in the workspace.
	const cache = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const list = (path) => api.workspace.fs.readDirectory(api.Uri.file(path)).then((found) => found.map(([name]) => name), () => []);
		const keys = await new Promise((resolve) => {
			const open = indexedDB.open("bablr");

			open.onsuccess = () => {
				const request = open.result.transaction("cst").objectStore("cst").getAllKeys();

				request.onsuccess = () => { resolve(request.result); };
				request.onerror = () => { resolve([]); };
			};
			open.onerror = () => { resolve([]); };
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
		const [made] = await commands.executeCommand("editor.annotations.refer", "console.log('f5');\n", "f5.js", [{ "start": 0, "end": 18 }]);
		const [where] = await commands.executeCommand("editor.annotations.resolve", "// above\nconsole.log('f5');\n", "f5.js", [made], { "observed": true });

		return { "ref": made, "found": where };
	});

	assert.match(ref?.span ?? "", /^[0-9a-f]{16}(?:#\d+)?$/u, "a spanAnchors id");
	assert.equal(ref.file, "f5.js");
	assert.deepEqual([found?.status, found?.candidate?.start], ["attached", 9], "found by its id, moved down a line");

	// Shown from the evidence: open the file and edit another line — the session's marks drop, the evidence's follow the
	// statement's span; edit the statement itself, and its mark goes until it runs again.
	const workbench = session.workbench();
	const marks = () => workbench.evaluate(() => document.querySelectorAll(".monaco-editor .margin .cgmr").length);
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

	await edit("append");
	await eventually("the evidence's mark, after an unrelated edit", async () => (await marks()) > 0 || undefined);
	await edit("statement");
	await eventually("no mark on the edited statement", async () => (await marks()) === 0 || undefined);
});

// A service — it keeps running (lifecycle.ts) — needs an event loop tsval doesn't have, so it runs on the script worker
// (the real runtime): its own worker, so stopping it (Ctrl+C terminates that worker) leaves the dev servers' worker, and
// the previews, running.
// What went through a run's ?., ??, parameters, returns and branches (RUNTIME-EVIDENCE.md, the second slice): folded
// into the same evidence file as its coverage, each site under the span that is exactly its node — and the values
// themselves only on this machine, in .silo/local/samples/.
test("evidence: a run's values and branches, beside its coverage", async () => {
	await session.terminal([
		`echo 'const world = { onWin: () => 1 };' > values.js`,
		`echo 'function pick(key) { return key ?? "none"; }' >> values.js`,
		`echo 'for (const key of ["a", undefined]) { if (pick(key) === "a") { world.onWin?.(); } }' >> values.js`,
		`echo 'const won = world.onWin ?? (() => 0);' >> values.js`,
		`echo 'const bonus = won ? 2 : 0;' >> values.js`
	].join(" && "), { "fresh": true });
	await session.request("debug.start", { "program": "/workspace/values.js" }, 60_000);

	const found = await eventually("its values and branches, as evidence", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const find = async (folder, name) => {
			for (const [entry, type] of await api.workspace.fs.readDirectory(folder).then((all) => all, () => [])) {
				const child = api.Uri.joinPath(folder, entry);
				const hit = type === api.FileType.Directory ? await find(child, name) : entry === name ? new TextDecoder().decode(await api.workspace.fs.readFile(child)) : undefined;

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
// Live values (LIVE-VALUES.md): a debug session over the binary search of Bret Victor's *Inventing on Principle*, paused
// on its return — each line's values in the notes margin beside it, a column per turn of the loop, a prose note beside
// them — and gone with the session, the note staying.
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
	const show = (notes) => workbench.evaluate(async ([text, shown]) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/victor.js");

		if (text !== undefined) {
			await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			await api.window.showTextDocument(uri);
		}

		globalThis.__pane.show(uri.toString(), shown);
	}, [notes.length === 0 ? undefined : source, notes]);
	// Each values row by its line (0-based): its label, then its cells, as shown.
	const rows = () => workbench.evaluate(() => Object.fromEntries([...document.querySelectorAll(".live-values-row")].map((row) => [row.dataset.line, [...row.children].map((child) => child.textContent.trim())])));

	await show([{ "id": "about", "fromLine": 0, "toLine": 0, "text": "**Binary search**, as in the talk." }]);

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
	assert.equal(await eventually("the note beside them", () => workbench.evaluate(() => document.querySelector(".notes-margin-entry strong")?.textContent)), "Binary search");

	await session.request(`debug.session.${started.session}.stop`, undefined, 30_000);
	await eventually("the values gone with the session", async () => Object.keys(await rows()).length === 0 || undefined);
	assert.equal(await workbench.evaluate(() => document.querySelector(".notes-margin-entry strong")?.textContent), "Binary search", "the note stays");
	// Leave the workbench as the next tests expect it: no note, no breakpoint, and the Explorer back where a breakpoint's
	// stop put the Run and Debug view (they open files from its tree).
	await show([]);
	await session.request("debug.breakpoints", { "program": "/workspace/victor.js", "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
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

test("node script: a service runs on the script worker, and stopping it leaves the previews up", async () => {
	await session.terminal(`echo "setInterval(() => console.log('tick'), 300);" > forever.js && node forever.js`, { "fresh": true });
	await session.until("the script worker's run", hasLabel("workbench", "node-scripts", /^node\.start$/u));
	await eventually("a running service", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.kind === "service" && run.state === "running") || undefined);
	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.state === "stopped") || undefined);

	const preview = session.page.frames().find((frame) => /__virtual__\/[^/]+\/5173\/$/u.test(frame.url()));

	assert.equal(await preview?.evaluate(async () => (await fetch(location.href)).status), 200);
});

// A note stays with its code (SPAN-ANNOTATIONS.md): kept on its span in .silo/notes/, followed when its code is edited
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

				await editor.edit((builder) => { builder.replace(new api.Range(editor.document.positionAt(text.indexOf(value[0])), editor.document.positionAt(text.indexOf(value[0]) + value[0].length)), value[1]); });

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
	const [placed] = await eventually("the note, kept on its span", async () => (await run("notes")).filter((note) => note.id === id).length > 0 ? run("notes") : undefined);

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

	// On the architecture view, discovered (DISCOVERED-ARCHITECTURE.md): the notes extension calling worker-pod's command,
	// and the insights extension asking the TypeScript plugin for types through VS Code.
	await session.until("notes → worker-pod, by command", hasLabel("ext:notes", "ext:worker-pod", /^cmd editor\.annotations\.resolve$/u));

	// And what a resolve is, as a flow followed by its messages' causes: the pod's call to core caused core's call to the
	// BABLR worker (whose queue names it, though the call goes out later).
	const { flowsOf } = await import("../../observability/src/flows.ts");
	const everything = (message) => [message, ...message.caused.flatMap(everything)];
	// (Polled with the view's snapshot fresh each time: session.snapshot() is the last one polled.)
	const resolveIn = (snapshot) => flowsOf(snapshot.log.filter((sample) => sample.from !== undefined && sample.to !== undefined)).flatMap(everything).find((message) => message.label === "annotations.resolve()" && message.caused.some((child) => child.label === "bablr.resolve()"));
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
	assert.equal(resolve.caused.find((child) => child.label === "bablr.resolve()").inferred, undefined, "named, not inferred");
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

				await editor.edit((builder) => { builder.delete(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + "shift(width, height);\n".length))); });

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

test("webview: a markdown preview", async () => {
	await session.terminal(`echo "# Tour" > TOUR.md`, { "fresh": true });
	await session.page.waitForTimeout(1000);
	await session.open("TOUR.md");
	await session.command("Markdown: Open Preview to the Side");
	await session.until("a webview", alive(/^webview:/u));
	await session.until("workbench ⇄ webview", hasLabel("workbench", /^webview:/u, /./u));
});

test("git review: a diff in the shell", async () => {
	await session.open("App.tsx");
	await session.append("// architecture tour");
	await session.page.keyboard.press("ControlOrMeta+s");
	await session.page.getByTitle("Expand changes panel").click();
	await session.page.waitForTimeout(1500);
	await session.page.getByText("App.tsx").last().click();
	await session.until("Code Hike", hasLabel("sw", "net:lighter.codehike.org", /./u), 30_000);

	// A modified file's cosmetic/semantic verdict, derived from the BABLR worker's cached parses: commit what's there,
	// change a committed file, and deriving its verdict parses the new version into the cache (bablr IndexedDB).
	const parses = () => session.workbench().evaluate(() => new Promise((resolve) => {
		const open = indexedDB.open("bablr");

		open.onsuccess = () => {
			const request = open.result.transaction("cst").objectStore("cst").count();

			request.onsuccess = () => { resolve(request.result); };
			request.onerror = () => { resolve(0); };
		};
		open.onerror = () => { resolve(0); };
	}));
	const before = await parses();

	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/src/index.ts");

		await api.commands.executeCommand("editor.git.commit", "architecture tour");

		const text = new TextDecoder().decode(await api.workspace.fs.readFile(uri));

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text + "\n// reformatted\n"));
		await api.commands.executeCommand("editor.git.refresh");
	});
	await eventually("the change's verdict, from parses the cache now keeps", async () => (await parses()) > before || undefined, 60_000);

	// The edits typed above were recorded as edit history in silo's local/ (its own IndexedDB-backed mount), not in .git/.
	const history = await eventually("the edit history, in silo's local/", () => session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const list = (path) => api.workspace.fs.readDirectory(api.Uri.file(path)).then((found) => found.map(([name]) => name), () => []);
		const kept = await list("/workspace/.silo/local/edit-history");

		return kept.length === 0 ? undefined : { "kept": kept, "git": [...await list("/workspace/.git/edit-history"), ...await list("/workspace/.git/bablr-automerge")] };
	}));

	assert.ok(history.kept.some((name) => name.endsWith(".bin")));
	assert.deepEqual(history.git, [], "nothing of the editor's left in .git/");
});

// VS Code's new windows are panels of the shell's dock (shell-dock.ts): an editor moved out lives on, its DOM in a
// blank frame of the shell, and comes back whichever side closes the window — VS Code (its editors restored to the
// main window) or the user (the panel closed).
test("dock: an editor moved into a new window lands in a panel of the shell's dock, and comes back", async () => {
	const { page } = session;
	const windows = page.locator("iframe[name^=\"vscode-window-\"]");
	const panel = page.locator(".dv-tab", { "hasText": "Editors" });
	const run = (command) => session.workbench().evaluate((id) => globalThis.__editor.api.commands.executeCommand(id), command);
	const editorsInWindow = () => windows.first().evaluate((frame) => frame.contentDocument?.querySelectorAll(".monaco-editor").length ?? 0).catch(() => 0);

	// (The git review's diff, still open over the editor region, would cover the dock's tabs.)
	if (await page.getByTitle("Close diff").isVisible()) {
		await page.getByTitle("Close diff").click();
	}

	await session.open("index.ts");
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	assert.equal(await panel.count(), 1, "its panel");

	// VS Code closes it: back into the main window, and the panel goes with the window.
	await run("workbench.action.restoreEditorsToMainWindow");
	await eventually("the window closed by VS Code", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.ok(await session.workbench().locator(".tabs-container .tab", { "hasText": "index.ts" }).count() > 0, "the editor back in the main window");

	// The user closes it: the panel closed, the window gone from VS Code too.
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel again", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	await panel.locator(".dv-default-tab-action").click();
	await eventually("the window closed by the user", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.deepEqual(await session.conformance(), [], "nothing needs review");
});

// What the editor keeps, discovered from what was written and read (DISCOVERED-ARCHITECTURE.md): by now the tour has
// run code (evidence, samples, runs), kept notes, and parsed with BABLR.
test("stores: discovered from what's written and read", async () => {
	const { discoveredStores } = await import("../architecture-model.ts");
	const stores = new Map(discoveredStores(session.snapshot()).map((store) => [store.store, store]));
	const named = (store) => stores.get(store) ?? { "writers": [], "readers": [] };

	assert.ok(named(".silo/evidence/…/<file>.jsonl").writers.includes("workbench"), "runtime evidence, written by core");
	assert.ok(named(".silo/evidence/…/<file>.jsonl").readers.includes("ext:insights"), "and read by the insights extension");
	assert.ok(named(".silo/notes/…/<file>.jsonl").writers.includes("ext:notes"), "notes, written by the notes extension");
	assert.ok(named(".silo/runs/<file>.jsonl").writers.includes("workbench"), "each run's envelope");
	assert.ok(named(".silo/local/…/<file>.jsonl").writers.length > 0, "samples, on this machine");
	assert.ok(named("IndexedDB bablr").writers.includes("bablr"), "BABLR's cache of parses");
});

// The components inside one realm's hub, discovered (DISCOVERED-ARCHITECTURE.md): the workbench's subscriptions, grouped by
// the function that registered them — or, in a minified build, by namespace — so core's BABLR and its runtime evidence
// come out as two parts of the workbench, not one.
test("components: a realm's hub, told apart by who subscribed", async () => {
	const { componentsOf } = await import("../architecture-model.ts");
	const workbench = session.snapshot().topology.workbench;
	const components = componentsOf(workbench);
	const holding = (subject) => components.find((component) => component.subjects.includes(subject));

	assert.ok(holding("annotations.resolve()") !== undefined, "core's BABLR, serving annotations");
	assert.ok(holding("evidence.observed") !== undefined, "core's runtime evidence");
	assert.notEqual(holding("annotations.resolve()"), holding("evidence.observed"), "two components, not one");
	assert.deepEqual(holding("annotations.resolve()").subjects.filter((subject) => subject.startsWith("annotations.")), ["annotations.refer()", "annotations.resolve()"], "what one component serves stays together");
});

// Drawn on the view: each hub's components a row in its box, and a hub link's messages a line to the component that
// handles them — a note's resolve lands on core's BABLR component (startBablr, or `annotations` where the build kept no
// names), not on the workbench as a whole.
test("components: on the view, a message's line lands on the component that handles it", async () => {
	const { componentsOf } = await import("../architecture-model.ts");
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

// ARCHITECTURE.md's diagram is this tour's (DISCOVERED-ARCHITECTURE.md): rendered from what it saw, last. A local run
// rewrites the block — a change to the editor shows up as a change to it, to commit with the change; in CI (the
// architecture workflow) a block that differs from a fresh tour's fails.
test("the diagram: ARCHITECTURE.md's is this tour's", async () => {
	const { readFile, writeFile } = await import("node:fs/promises");
	const { tourDiagram } = await import("../architecture-model.ts");
	const file = new URL("../ARCHITECTURE.md", import.meta.url);
	const doc = await readFile(file, "utf8");
	const [begin, end] = ["<!-- architecture-tour:begin -->\n", "\n<!-- architecture-tour:end -->"];
	const committed = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
	const fresh = tourDiagram({ ...await session.until("a last look", () => true), "topology": session.topologySeen() });

	if (process.env.CI === undefined) {
		if (fresh !== committed) {
			await writeFile(file, doc.replace(begin + committed + end, begin + fresh + end));
			console.log("ARCHITECTURE.md: the tour's diagram changed — rewritten; commit it with the change");
		}
	} else {
		const [now, then] = [fresh.split("\n"), committed.split("\n")];
		const changes = [...then.filter((line) => !now.includes(line)).map((line) => "- " + line), ...now.filter((line) => !then.includes(line)).map((line) => "+ " + line)];

		assert.deepEqual(changes, [], "ARCHITECTURE.md's diagram isn't this tour's: run the tour locally, which rewrites it, and commit it");
	}
});

/** Poll `probe` (in this process) until it's truthy, waiting the way the page does. */
function eventually(what, probe, timeoutMs = 30_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}
