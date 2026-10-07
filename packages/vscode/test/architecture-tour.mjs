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
test("node script: a task runs under the tsval debugger", async () => {
	await session.terminal(`echo "require('fs').writeFileSync('/workspace/tour-out.txt', 'tour');" > tour.js && node tour.js`, { "fresh": true });
	await session.until("the debug worker", alive("debug-worker"));
	await session.until("the debug session's launch", hasLabel("pod", "debug-worker", /^debug\.session\..+\.control$/u));

	// One run, one id: the registry's run is the debug session's (its launch config carries it).
	const run = await eventually("the run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title === "node tour.js" && each.state === "running"));
	const sessionRun = await session.workbench().evaluate(() => globalThis.__editor.api.debug.activeDebugSession?.configuration.__runId);

	assert.equal(sessionRun, run.id, "the session carries the registry's run id");
});

// A program that renders opens its render surface, the shell's tsval Preview window; one that draws nothing — the task
// above — doesn't, so it covers no code.
test("render surface: a tsval program that renders opens it", async () => {
	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/render.js"), new TextEncoder().encode("ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('p', null, 'tour'));\n"));
	});

	const started = await session.request("debug.start", { "program": "/workspace/render.js", "breakpoints": [] }, 60_000);

	assert.equal(started.state, "idle", "mounted, waiting for events");
	await session.until("the tsval render surface", hasLabel("shell", "tsval-preview", /^init/u));
	await session.request(`debug.session.${started.session}.stop`, undefined, 30_000);
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
	const rows = () => workbench.evaluate(() => Object.fromEntries([...document.querySelectorAll(".live-values-row")].map((row) => [row.dataset.line, [...row.children].filter((child) => !child.classList.contains("live-values-mock")).map((child) => child.textContent.trim())])));

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

	// Reformatted while paused — blank lines above, indented with spaces, mid wrapped, no semicolons: every row moves
	// with its code (anchored by BABLR spans, not line numbers).
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file("/workspace/victor.js"));
		const text = editor.document.getText();
		const reformatted = text.replaceAll("\t", "  ").replace("{\n", "{\n\n\n").replace("Math.floor((low + high) / 2);", "Math.floor(\n      (low + high) / 2\n    );").replaceAll(";\n", "\n");

		await editor.edit((builder) => { builder.replace(new api.Range(editor.document.positionAt(0), editor.document.positionAt(text.length)), reformatted); });
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
	await eventually("the values gone with the session", async () => Object.keys(await rows()).length === 0 || undefined);
	// (Each draw renders the note again, asynchronously: wait for it.)
	assert.equal(await eventually("the note, still there", () => workbench.evaluate(() => document.querySelector(".notes-margin-entry strong")?.textContent)), "Binary search", "the note stays");
	// Leave the workbench as the next tests expect it: no note, no breakpoint, and the Explorer back where a breakpoint's
	// stop put the Run and Debug view (they open files from its tree).
	await show([]);
	await session.request("debug.breakpoints", { "program": "/workspace/victor.js", "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
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
		await workbench.evaluate(() => { [...document.querySelectorAll('.live-values-row[data-line="2"] button')].find((each) => each.textContent === "Mock…").click(); });
		await eventually("high's rule editor", () => workbench.evaluate(() => document.querySelector(".live-values-rule .rule-editor-then input") !== null || undefined));
		await workbench.evaluate((label) => {
			const input = document.querySelector(".live-values-rule .rule-editor-then input");

			input.value = "3";
			input.dispatchEvent(new Event("input"));
			[...document.querySelectorAll(".live-values-rule .live-values-choices button")].find((each) => each.textContent === label).click();
		}, button);
	};

	await eventually("high's row", async () => (await rows())["2"]?.[1] === "5" || undefined);
	await mockHigh("Just this once");
	await eventually("high, set by hand", () => workbench.evaluate(() => document.querySelector('.live-values-row[data-line="2"] .live-values-set')?.textContent).then((text) => (text === "3" ? text : undefined)));

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
		const listed = await session.request("rules.list", undefined, 10_000);

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
	await session.request("rules.set", { "previous": rule }, 10_000);
	await session.request("debug.breakpoints", { "program": "/workspace/setvalue.js", "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// Mocking process.argv in the margin (RULES.md): its row is there before any run, with Mock… — the rule editor, prefilled
// with the file and the run's arguments. Run runs it with them, once, keeping nothing; Save as rule keeps them in my
// policy — two values, two runs — and a plain run is given them; Remove takes the rule away.
test("mock process.argv: a rule giving it, once or kept, several runs, and a plain run given them", async () => {
	const workbench = session.workbench();
	const program = "/workspace/tax.js";
	const runsOf = async () => (await session.request("runs.list", undefined, 5000)).filter((run) => run.title.includes("tax.js"));
	const givenNow = () => session.request("rules.given", { "program": program, "target": "process.argv" }, 10_000);
	const row = () => workbench.evaluate(() => {
		const line = document.querySelector('.live-values-row[data-line="0"]');

		return line === null ? undefined : { "label": line.querySelector(".live-values-label")?.textContent.trim(), "given": line.querySelector(".live-values-given")?.textContent ?? null };
	});
	// The Mock's panel: open it, read what it says, give process.argv these runs' command lines, press a button.
	const mock = (action, argument) => workbench.evaluate(([what, value]) => {
		const panel = document.querySelector(".live-values-rule");
		const outer = () => panel.querySelector(".rule-editor-then .rule-editor-list.nested");
		const runs = () => [...outer().children].filter((child) => child.classList.contains("rule-editor-list-item"));

		switch (what) {
			case "open":
				[...document.querySelectorAll('.live-values-row[data-line="0"] button')].find((button) => button.textContent === "Mock…").click();

				return true;
			case "status":
				return panel?.querySelector(".live-values-rule-status")?.textContent;
			case "give":
				while (runs().length < value.length) {
					[...outer().children].at(-1).click();
				}

				// Each run's arguments, as a command line.
				for (const [index, line] of value.entries()) {
					const input = runs()[index].querySelector("input");

					input.value = line;
					input.dispatchEvent(new Event("input"));
				}

				return panel.querySelector(".live-values-rule-status").textContent;
			default:
				[...panel.querySelectorAll(".live-values-choices button")].find((button) => button.textContent === what).click();

				return true;
		}
	}, [action, argument]);
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
		await session.request("rules.set", { "previous": before.rule }, 10_000);
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

// Capability decisions on the line (LIVE-VALUES.md, step 8): a call the policy hasn't decided stops the run at its line,
// and asks there, in the notes margin — what it would do, from the run's own values, and Allow once / Allow always / Deny.
// Deny fails the call as the policy would; Allow once lets it run; Allow always writes my policy override, and the next
// run goes straight through. Rule… opens the rule editor there (RULES.md), prefilled with the call: widened to a glob and
// saved, it decides the call, and the next run's.
test("capability decisions: a gated call asks on its line, and the choice resumes the run", async () => {
	const workbench = session.workbench();
	const source = [
		"import { writeFileSync } from \"node:fs\";",
		"",
		"const target = \"/workspace/out.txt\";",
		"",
		"writeFileSync(target, \"hello\");",
		"console.log(\"wrote\", target);",
		""
	].join("\n");
	const silo = (what) => workbench.evaluate(async (action) => {
		const { api } = globalThis.__editor;
		const folder = api.Uri.file("/workspace/.silo");
		const policies = (await api.workspace.fs.readDirectory(folder).then((entries) => entries, () => [])).map(([name]) => name).filter((name) => name.endsWith(".policy.json") && name !== "policy.json");

		if (action === "clear") {
			for (const name of policies) {
				await api.workspace.fs.delete(api.Uri.joinPath(folder, name));
			}

			return [];
		}

		return Promise.all(policies.map(async (name) => JSON.parse(new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.joinPath(folder, name))))));
	}, what);
	// The margin's question, as shown: the call, what it reaches, and which choices it offers.
	const asked = () => workbench.evaluate(() => {
		const box = document.querySelector(".live-values-ask");

		return box === null ? undefined : { "what": box.querySelector(".live-values-ask-what").textContent, "choices": [...box.querySelectorAll("button")].map((button) => (button.disabled ? `(${button.textContent})` : button.textContent)) };
	});
	const start = async () => {
		const stopped = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

		assert.equal(stopped.reason, "capability", "stopped by the policy, not a breakpoint");
		assert.equal(stopped.line, 5);
		assert.deepEqual(await eventually("the question on its line", asked), { "what": "writeFileSync '/workspace/out.txt' fs:write", "choices": ["Allow once", "Allow always", "Deny", "Rule…"] });

		return stopped;
	};

	await silo("clear");
	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/gated.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		await api.window.showTextDocument(uri);
	}, source);

	// Deny: the call fails as a denied one would, and the uncaught error ends the run.
	const denied = await session.request(`debug.session.${(await start()).session}.decide`, { "choice": "deny" }, 60_000);

	assert.equal(denied.state, "terminated");
	assert.match(denied.output.join("\n"), /EACCES/u, "the call threw EACCES");
	await eventually("the question gone with the run", async () => (await asked()) === undefined || undefined);

	// Allow once, from the margin's own button: the call runs; nothing is written to the policy.
	await start();
	await workbench.evaluate(() => { [...document.querySelectorAll(".live-values-ask button")].find((button) => button.textContent === "Allow once").click(); });
	await eventually("the question answered", async () => (await asked()) === undefined || undefined);
	assert.deepEqual(await silo("read"), [], "Allow once writes no rule");

	// Allow always: my override gets the rule, and the next run isn't stopped.
	const always = await session.request(`debug.session.${(await start()).session}.decide`, { "choice": "allow-always" }, 60_000);

	assert.equal(always.state, "terminated");
	assert.deepEqual(always.output, ["wrote /workspace/out.txt"]);
	assert.deepEqual((await silo("read")).flatMap((policy) => policy.rules.map(({ when, then }) => ({ when, then }))), [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "is", "argument": "/workspace/out.txt" }] }, "then": [{ "action_id": "allow" }] }]);

	const again = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

	assert.equal(again.state, "terminated", "allowed always: no stop");
	assert.deepEqual(again.output, ["wrote /workspace/out.txt"]);

	// A rule: Rule… — the call's capability and resource, then allow — the resource widened to a glob, and saved.
	const status = () => workbench.evaluate(() => document.querySelector(".live-values-rule-status")?.textContent);
	const saveable = () => workbench.evaluate(() => [...document.querySelectorAll(".live-values-rule button")].find((button) => button.textContent === "Save as rule")?.disabled === false);
	const resourceRow = (change) => workbench.evaluate(([selector, value, event]) => {
		const field = document.querySelectorAll(".live-values-rule .rule-editor-group.top > .rule-editor-rows > .rule-editor-row")[1].querySelector(selector);

		field.value = value;
		field.dispatchEvent(new Event(event));
	}, change);

	// The store drops its cached grant when its file watcher reports the delete: until then a run still goes through.
	await silo("clear");
	await eventually("a run the policy stops again", async () => {
		const run = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

		return run.reason === "capability" || undefined;
	});
	assert.deepEqual(await eventually("the question on its line", asked), { "what": "writeFileSync '/workspace/out.txt' fs:write", "choices": ["Allow once", "Allow always", "Deny", "Rule…"] });
	await workbench.evaluate(() => { [...document.querySelectorAll(".live-values-ask button")].find((button) => button.textContent === "Rule…").click(); });
	assert.equal(await eventually("the rule editor, prefilled", status), "Covers this call: allows it");
	await resourceRow([".rule-editor-operator select", "matches", "change"]);
	await resourceRow([".rule-editor-argument", "/tmp/*", "input"]);
	assert.equal(await status(), "Doesn't cover this call");
	assert.equal(await saveable(), false, "a rule that doesn't cover the call can't decide it");
	await resourceRow([".rule-editor-argument", "/workspace/*.txt", "input"]);
	assert.equal(await status(), "Covers this call: allows it");
	assert.equal(await saveable(), true);
	await workbench.evaluate(() => { [...document.querySelectorAll(".live-values-rule button")].find((button) => button.textContent === "Save as rule").click(); });
	await eventually("the question answered", async () => (await asked()) === undefined || undefined);
	assert.deepEqual((await silo("read")).flatMap((policy) => policy.rules.map(({ when, then }) => ({ when, then }))), [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/*.txt" }] }, "then": [{ "action_id": "allow" }] }]);

	const ruled = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

	assert.equal(ruled.state, "terminated", "the rule allows it: no stop");
	assert.deepEqual(ruled.output, ["wrote /workspace/out.txt"]);

	// As the next tests expect it: no override, and the Explorer back where a stop put Run and Debug.
	await silo("clear");
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// The Rules view (rules-view.ts): every rule as a sentence, mine first; a rule saved anywhere shows up in it, and one
// opened there can be removed.
test("rules view: every rule as a sentence, opened and removed there", async () => {
	const workbench = session.workbench();
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/*.txt" }] }, "then": [{ "action_id": "allow" }] };
	const lines = () => workbench.evaluate(() => {
		const view = document.querySelector(".rules-view");

		return view === null ? undefined : [...view.querySelectorAll(".rules-view-sentence")].map((each) => each.textContent);
	});

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("silo.rules.focus"));
	await session.request("rules.set", { "rule": rule }, 10_000);
	assert.deepEqual(await eventually("the rule, listed", async () => ((await lines())?.length === 1 ? lines() : undefined)), ["capability is fs:write and resource matches /workspace/*.txt → allow"]);

	// Opened: the rule editor under it, with Remove.
	await workbench.evaluate(() => { document.querySelector(".rules-view-rule").click(); });
	await eventually("its editor", () => workbench.evaluate(() => [...document.querySelectorAll(".rules-view .live-values-rule button")].some((button) => button.textContent === "Remove") || undefined));
	await workbench.evaluate(() => { [...document.querySelectorAll(".rules-view .live-values-rule button")].find((button) => button.textContent === "Remove").click(); });
	assert.deepEqual(await eventually("no rules", async () => ((await lines())?.length === 0 ? lines() : undefined)), []);
	assert.deepEqual((await session.request("rules.list", undefined, 10_000)).mine.rules, []);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// A rule placed in the code whose place is lost (its statement gone): broken in the Rules view, and re-placed at the
// code selected in the editor — then found where it was put.
test("rules view: a rule whose place is lost, re-placed at a selection", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/placed.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("let x = 1;\nlet y = 2;\nconsole.log(x, y);\n"));
		await api.window.showTextDocument(uri);
		await api.commands.executeCommand("silo.rules.focus");
	});

	// A place in code that isn't there any more.
	const [gone] = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.annotations.refer", "let gone = 0;\n", "placed.js", [{ "start": 0, "end": 13 }]));
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "placed.js" }, { "target_id": "at", "operator_id": "is", "argument": gone }] }, "then": [{ "action_id": "set", "target_id": "variables.x", "argument": 5 }] };
	const listed = () => session.request("rules.list", undefined, 10_000);

	await session.request("rules.set", { "rule": rule }, 10_000);
	assert.equal((await listed()).mine.places[0].status, "orphaned");
	assert.match(await eventually("the broken rule", () => workbench.evaluate(() => document.querySelector(".rules-view-rule.broken .rules-view-sentence")?.textContent)), /place in the code is lost/u);

	// Select `let y = 2;`, open the rule, Re-place at selection.
	await workbench.evaluate(() => {
		const { api } = globalThis.__editor;
		const editor = api.window.activeTextEditor;

		editor.selection = new api.Selection(1, 0, 1, 10);
	});
	await workbench.evaluate(() => { document.querySelector(".rules-view-rule.broken").click(); });
	await eventually("Re-place at selection", () => workbench.evaluate(() => [...document.querySelectorAll(".rules-view .live-values-rule button")].some((button) => button.textContent === "Re-place at selection") || undefined));
	await workbench.evaluate(() => { [...document.querySelectorAll(".rules-view .live-values-rule button")].find((button) => button.textContent === "Re-place at selection").click(); });

	const placed = await eventually("the rule, re-placed", async () => {
		const { mine } = await listed();

		return mine.places[0]?.status !== "orphaned" ? mine : undefined;
	});

	assert.equal(placed.places[0].line, 2);
	assert.deepEqual(placed.rules[0].then, rule.then);
	await session.request("rules.set", { "previous": placed.rules[0] }, 10_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// Where rules apply (RULES.md): a placed rule is marked in the margin's gutter column beside the code it's placed at,
// its sentence on hover. As that code is edited it's followed — through the edit history's bursts, a small step at a
// time — so the mark stays on it, sure, through changes that from its stored place alone would be only a weak match;
// and saving the file keeps the rule's place there (its reference made again), mine and the shared contract's alike,
// through ESLint's fixes on save too.
test("placed rules: marked beside their code, followed through edits, and kept placed on save", async () => {
	const workbench = session.workbench();
	const marks = () => workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-mark.rule-placed")].map((mark) => ({ "title": mark.title, "uncertain": mark.classList.contains("uncertain") })));
	const listed = () => session.request("rules.list", undefined, 10_000);
	const read = (path) => workbench.evaluate(async (file) => {
		const { api } = globalThis.__editor;

		return api.workspace.fs.readFile(api.Uri.file(file)).then((bytes) => new TextDecoder().decode(bytes), () => null);
	}, path);
	const write = (path, text) => workbench.evaluate(async ([file, contents]) => {
		const { api } = globalThis.__editor;

		await (contents === null ? api.workspace.fs.delete(api.Uri.file(file)) : api.workspace.fs.writeFile(api.Uri.file(file), new TextEncoder().encode(contents)));
	}, [path, text]);
	const edit = (fromLine, toLine, text) => workbench.evaluate(async ([from, to, contents]) => {
		const { api } = globalThis.__editor;
		const editor = api.window.activeTextEditor;

		await editor.edit((builder) => { builder.replace(new api.Range(from, 0, to, 0), contents); });
	}, [fromLine, toLine, text]);

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/marked.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("let price = 10;\nlet tax = 2;\nconsole.log(price + tax);\n"));
		await api.window.showTextDocument(uri);
	});

	const [here] = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.annotations.refer", "let price = 10;\nlet tax = 2;\nconsole.log(price + tax);\n", "marked.js", [{ "start": 16, "end": 28 }]));
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "marked.js" }, { "target_id": "at", "operator_id": "is", "argument": here }] }, "then": [{ "action_id": "set", "target_id": "variables.tax", "argument": 5 }] };
	// The shared contract's own rule, placed there too (written as a person would: silo reads the contract).
	const shared = { ...rule, "then": [{ "action_id": "set", "target_id": "variables.tax", "argument": 7 }] };
	const contract = await read("/workspace/.silo/policy.json");

	await write("/workspace/.silo/policy.json", JSON.stringify({ "version": 1, "rules": [shared, ...contract === null ? [] : JSON.parse(contract).rules ?? []] }, null, "\t") + "\n");
	await session.request("rules.set", { "rule": rule }, 10_000);

	const [mark] = await eventually("the rules' mark", async () => {
		const shown = await marks();

		return shown.length === 1 && shown[0].title.includes("shared") ? shown : undefined;
	});

	assert.match(mark.title, /^My rule: .*tax.*\nA shared rule: .*tax/su);
	assert.equal(mark.uncertain, false);

	// Edited twice — the statement changed two lines down, then made a const (a step of its own: a burst apart) — it's
	// followed edit by edit, each step sure, where its stored place alone would find it only uncertainly.
	await edit(0, 2, "let price = 10;\n\n// tax, doubled\nlet tax = 2 * 2;\n");
	await eventually("found again, by a match", async () => ((await listed()).mine.places[0]?.status === "re-placed" || undefined));
	await session.page.waitForTimeout(1_000); // the edit history's burst closes
	await edit(3, 4, "const tax = 2 * 2;\n");

	const followed = await eventually("followed through both edits", async () => {
		const { mine } = await listed();
		const shown = await marks();

		return mine.places[0]?.line === 4 && shown.length === 1 ? { "place": mine.places[0], "mark": shown[0] } : undefined;
	});

	assert.notEqual(followed.place.status, "uncertain");
	assert.equal(followed.mark.uncertain, false);

	// Saved — ESLint's fix makes `let price` a const too — and kept at the place it was followed to: mine, and the
	// shared contract's, found by their own ids from then on.
	const { added } = (await listed()).mine.rules[0];

	await workbench.evaluate(() => globalThis.__editor.api.window.activeTextEditor.document.save());

	const kept = await eventually("their places kept", async () => {
		const { mine, shared: theirs } = await listed();
		const moved = (rules, from) => rules.find((each) => JSON.stringify(each.then) === JSON.stringify(from.then) && JSON.stringify(each.when) !== JSON.stringify(from.when));

		return moved(mine.rules, rule) !== undefined && moved(theirs.rules, shared) !== undefined ? { "mine": mine, "shared": theirs } : undefined;
	});

	assert.deepEqual([kept.mine.places[0].status, kept.mine.places[0].line], ["attached", 4]);
	assert.deepEqual([kept.shared.places[0].status, kept.shared.places[0].line], ["attached", 4]);
	assert.equal(kept.mine.rules[0].added, added, "moving a place isn't deciding anything");
	await session.request("rules.set", { "previous": kept.mine.rules[0] }, 10_000);
	await write("/workspace/.silo/policy.json", contract);
	await eventually("no mark", async () => ((await marks()).length === 0 || undefined));
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.closeActiveEditor");
		await api.workspace.fs.delete(api.Uri.file("/workspace/marked.js"));
	});
});

// A call's result given instead of the call (RULES.md, slice 2): at an async fetch's capability stop (the debugger steps
// async code — tsval's steppedAsync), Rule… — prefilled with what it returned the last time it ran for real, when
// that's recorded — Save as rule: the run goes on with that result, and the next run isn't stopped there.
test("mock a call's result: given at its capability stop, from what it returned for real", async () => {
	const workbench = session.workbench();
	const program = "/workspace/rates.js";
	const url = "https://api.example.com/rates";
	const source = ["async function main() {", `\tconst response = await fetch("${url}");`, "\tconst rates = await response.json();", "", "\tconsole.log(\"CA\", rates.CA);", "}", "", "main();", ""].join("\n");

	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/rates.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
		await api.window.showTextDocument(uri);
	}, source);
	// What it returned for real, as the service worker's net gate records a preview's fetch (.silo/local/recorded.json).
	await workbench.evaluate(async (recorded) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/.silo/local/recorded.json"), new TextEncoder().encode(JSON.stringify(recorded)));
	}, { "version": 1, "results": { [`net ${url}`]: { "value": { "CA": 0.13, "FR": 0.2 }, "at": new Date().toISOString() } } });

	// Stopped inside the async function, at the fetch.
	const stopped = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.equal(stopped.reason, "capability");
	assert.equal(stopped.line, 2);
	await eventually("the question", () => workbench.evaluate(() => document.querySelector(".live-values-ask") !== null || undefined));
	await workbench.evaluate(() => { [...document.querySelectorAll(".live-values-ask button")].find((button) => button.textContent === "Rule…").click(); });

	const status = () => workbench.evaluate(() => document.querySelector(".live-values-rule-status")?.textContent);

	assert.match(await eventually("the rule, given what it returned", status), /^Covers this call: gives it what it returned on /u);
	assert.equal(await workbench.evaluate(() => document.querySelector(".live-values-rule .rule-editor-then .rule-editor-action-target select").value), "result");
	await workbench.evaluate(() => { [...document.querySelectorAll(".live-values-rule button")].find((button) => button.textContent === "Save as rule").click(); });

	// Saved, the run goes on with it (and ends); the next run is given it with no stop, past both awaits.
	await eventually("the question answered", () => workbench.evaluate(() => document.querySelector(".live-values-ask") === null || undefined));

	const again = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.equal(again.state, "terminated", "given by the rule: no stop");
	assert.deepEqual(again.output.filter((line) => !line.startsWith("→")), ["CA 0.13"]);

	// And a breakpoint after the awaits stops there, in the async function.
	const paused = await session.request("debug.start", { "program": program, "breakpoints": [5] }, 60_000);

	assert.equal(paused.line, 5);
	assert.equal(paused.function, "main");
	await session.request(`debug.session.${paused.session}.stop`, undefined, 30_000);

	const { mine } = await session.request("rules.list", undefined, 10_000);

	await session.request("rules.set", { "previous": mine.rules[0] }, 10_000);
	await session.request("debug.breakpoints", { "program": program, "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// The preview's capability prompt (shell-preview.ts): Rule… makes the rule in the Rules view, prefilled with the call,
// and the call waits on it — saved, it decides the call.
test("preview prompt: Rule… makes the rule in the Rules view, and the call waits on it", async () => {
	const workbench = session.workbench();
	// A preview's own fetch: the service worker gates it, and asks in that preview's window.
	const preview = await eventually("a preview", () => session.page.frames().find((frame) => /\/__virtual__\/[^/]+\/\d+\//u.test(frame.url())));
	// (A host the previews reach anyway: esm.sh.)
	const decided = preview.evaluate(() => fetch("https://esm.sh/").then((response) => response.statusText, (error) => String(error)));
	const rule = session.page.locator("wa-button", { "hasText": "Rule…" });

	await rule.first().waitFor({ "timeout": 30_000 });
	await rule.first().click();
	await eventually("the rule, in the Rules view", () => workbench.evaluate(() => document.querySelector(".rules-view .live-values-rule-status")?.textContent).then((text) => (text === "Covers this call: allows it" ? text : undefined)));
	await workbench.evaluate(() => { [...document.querySelectorAll(".rules-view .live-values-rule button")].find((button) => button.textContent === "Save as rule").click(); });
	// Allowed: the fetch goes out (wherever it gets) instead of the gate's 403.
	assert.notEqual(await decided, "Capability denied");

	const { mine } = await session.request("rules.list", undefined, 10_000);

	assert.deepEqual(mine.rules[0].when.predicates.map(({ target_id, argument }) => [target_id, argument]), [["capability", "net"], ["resource", "esm.sh"]]);
	await session.request("rules.set", { "previous": mine.rules[0] }, 10_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
});

// The program's projection (PROJECTIONS.md): the open file's steps as cards in the notes margin — statements written
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

// tsval's event loop in the debugger: a task's timers run on it — steppable, on a virtual clock (so a timer measured by
// Date.now() takes exactly its delay, every run) — where before a task's setTimeout wasn't there at all.
test("debugger: a task's timers run on tsval's deterministic event loop", async () => {
	const workbench = session.workbench();
	const program = "/workspace/timers.js";

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(["const start = Date.now();", "", "setTimeout(() => {", "\tconsole.log(\"waited\", Date.now() - start);", "}, 30);", "void Promise.resolve().then(() => console.log(\"first\"));", ""].join("\n")));
	}, program);

	const ran = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.deepEqual(ran.output, ["first", "waited 30"]);
	await workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(path)), program);
});

// How the last run ended short, in the margin's strip: a ✕ on the line it crashed on (the error on hover) — through a
// reformat too, anchored by the throw's span — gone when it runs again and finishes.
test("run ends: a crash is marked on the line it threw on, and stays on it through a reformat", async () => {
	const workbench = session.workbench();
	const crashed = () => workbench.evaluate(() => {
		const mark = document.querySelector(".notes-margin-mark.run-crashed");
		const lineHeight = Number.parseFloat(getComputedStyle(document.querySelector(".notes-margin")).lineHeight);

		return mark === null ? undefined : { "line": Math.round(Number.parseFloat(mark.style.top) / lineHeight) + 1, "title": mark.title };
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

		await editor.edit((builder) => { builder.replace(new api.Range(editor.document.positionAt(0), editor.document.positionAt(text.length)), "// parse\n\n" + text.replaceAll("\t", "    ").replaceAll(";\n", "\n")); });
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

test("node script: a service runs on the script worker, and stopping it leaves the previews up", async () => {
	await session.terminal(`echo "setInterval(() => console.log('tick'), 300);" > forever.js && node forever.js`, { "fresh": true });
	await session.until("the script worker's run", hasLabel("workbench", "node-scripts", /^node\.start$/u));
	await eventually("a running service", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.kind === "service" && run.state === "running") || undefined);
	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node forever.js" && run.state === "stopped") || undefined);

	const preview = session.page.frames().find((frame) => /__virtual__\/[^/]+\/5173\/$/u.test(frame.url()));

	assert.equal(await preview?.evaluate(async () => (await fetch(location.href)).status), 200);
});

// What a node service read of the workspace is recorded (RULES.md, slice 2), as a preview's fetches are: by the path as
// the script wrote it — what a debug run's stand-in asks for — so a rule can give a debug run what the real one read.
// (A service runs for real, on the script worker; a task runs under the debugger, where every such call is a stand-in.)
test("record: a node service's reads of the workspace, kept to be given back", async () => {
	const workbench = session.workbench();
	const rates = "{ \"US\": 0.07, \"CA\": 0.13 }\n";

	await workbench.evaluate(async (text) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file("/workspace/rates.json"), new TextEncoder().encode(text));
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/read-rates.js"), new TextEncoder().encode("const fs = require('fs');\nconst rates = JSON.parse(fs.readFileSync('rates.json', 'utf8'));\nsetInterval(() => console.log(Object.keys(rates).length), 300);\n"));
	}, rates);
	await session.terminal("node read-rates.js", { "fresh": true });

	const recorded = await eventually("the read, recorded", async () => (await session.request("capability.recorded", { "capability": "fs:read", "resource": "rates.json" }, 10_000)) ?? undefined);

	assert.equal(recorded.value, rates);
	await session.page.keyboard.press("Control+C");
	await eventually("the service stopped", async () => (await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node read-rates.js" && run.state === "stopped") || undefined);
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/rates.json"));
		await api.workspace.fs.delete(api.Uri.file("/workspace/read-rates.js"));
	});
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
