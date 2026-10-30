/**
 * Architecture tour, what runs decide: node --test's trace of each test on each file, what a save selects to run again,
 * features from the manifest and the ledger, a selected run's halt, kept runs, purity — each checked against what the
 * live architecture view saw.
 *
 * One of the tour's shards, each in a session of its own so they run side by side (architecture-tour-session.mjs);
 * the diagram of what they saw together is architecture-diagram.mjs's.
 *
 *   node --test test/architecture-tour-selection.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasLabel } from "./architecture-harness.mjs";
import { eventually, session, tour } from "./architecture-tour-session.mjs";

tour("architecture-tour-selection");

/**
 * Replace `find` with `replace` in `path`, shown in an editor, as typing would, then save it with Ctrl+S, as a person
 * does (a save's selection follows the key, not the API). The edit is tried again until the text has it: an editor not
 * ready yet declines it (`editor.edit` answers false), and then there's nothing to save and nothing is selected.
 */
async function editAndSave(path, find, replace) {
	const workbench = session.workbench();

	await eventually(`the edit in ${path}`, () => workbench.evaluate(async ([file, from, to]) => {
		const { api } = globalThis.__editor;
		const editor = await api.window.showTextDocument(api.Uri.file(file));
		const text = editor.document.getText();

		if (text.includes(to) && !text.includes(from)) {
			return true;
		}

		const at = text.indexOf(from);

		if (at === -1) {
			return undefined;
		}

		const applied = await editor.edit((builder) => {
			builder.replace(new api.Range(editor.document.positionAt(at), editor.document.positionAt(at + from.length)), to);
		});

		return applied && editor.document.getText().includes(to) ? true : undefined;
	}, [path, find, replace]), 30_000);
	// (the editor focused first, as typing there would leave it)
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.action.focusActiveEditorGroup"));
	await session.page.keyboard.press("ControlOrMeta+s");
}

/** What a save selects, waited for — or, timed out, what happened instead: whether the file is still dirty (a save VS
 *  Code dropped selects nothing), the runs since the save (what started, when, and how it ended: none queued, one slow, or
 *  one that ran without its trace kept) and the traces kept on the file. NEXT.md *Watching*. */
async function afterSave(what, path, probe) {
	const saved = Date.now();
	const before = await session.workbench().evaluate((file) => globalThis.__editor.api.workspace.textDocuments.find((document) => document.uri.path === file)?.getText(), path);

	return eventually(what, probe, 60_000).catch(async (error) => {
		const state = await session.workbench().evaluate(async ({ file, since }) => {
			const { api } = globalThis.__editor;
			const traces = await Promise.resolve(api.workspace.fs.readFile(api.Uri.file(`/workspace/.silo/local/traces/${file.slice("/workspace/".length)}.jsonl`))).then((bytes) => new TextDecoder().decode(bytes), () => "");

			return {
				"dirty": api.workspace.textDocuments.find((document) => document.uri.path === file)?.isDirty,
				"disk": await Promise.resolve(api.workspace.fs.readFile(api.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined),
				"queue": await Promise.resolve(api.commands.executeCommand("run.live.state")).catch((failed) => String(failed)),
				"sessions": api.debug.activeDebugSession?.name,
				"traces": traces.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)).map((trace) => `${trace.test?.id ?? trace.program ?? "(own)"} ${trace.trigger} ${trace.at}`).slice(-8),
				"since": since
			};
		}, { "file": path, "since": new Date(saved).toISOString() });
		const runs = await session.request("runs.list", {}, 10_000).then((listed) => listed.filter((run) => run.startedAt >= saved - 5000).map((run) => `${run.title} ${run.state} +${run.startedAt - saved}ms${run.endedAt === undefined ? "" : ` for ${run.endedAt - run.startedAt}ms`}`), (failed) => [String(failed)]);

		const landed = state.dirty === true ? "still dirty: the save didn't land" : state.disk === before ? "saved, with the edit on disk" : "not dirty, but the disk hasn't the text the editor had: the edit or the save went astray";

		throw new Error(`${error.message} (${path} ${landed}; runs since the save: ${JSON.stringify(runs)}; debugging ${state.sessions ?? "nothing"}; traces kept on it, latest last: ${JSON.stringify(state.traces)}; saved at ${state.since}; the live runs' queue: ${JSON.stringify(state.queue)})`);
	});
}

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

	// subtract edited and saved.
	await editAndSave("/workspace/calc.js", "return a - b;", "return a - b + 0;");

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
		await editAndSave("/workspace/shapes.js", "3 * r * r", "Math.PI * r * r");

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
	await editAndSave("/workspace/rates.js", "return 2;", `const response = await fetch("${url}");\n\n\treturn Number(await response.text());`);

	// (timed out, what the save did — afterSave — and how the Margin last saw the file's run end)
	let ended;
	const state = await afterSave("the selected run halted on rates.js", "/workspace/rates.js", async () => {
		const found = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("margin.state", "rates.js").catch(() => undefined));

		ended = found?.end;

		return found?.end?.kind === "stopped" && /halted before net/u.test(found.end.message ?? "") ? found : undefined;
	}).catch((error) => {
		throw new Error(`${error.message}; the Margin's run end on rates.js, last seen: ${JSON.stringify(ended) ?? "none"}`, { "cause": error });
	});
	const halt = state.values.find((row) => row.label === "halted");

	assert.match(state.end.message, new RegExp(`halted before net ${url.replaceAll(".", "\\.")}: it never ran for real`, "u"));
	assert.deepEqual(halt?.cells, [`net ${url}`], "the call it halted before, on its line");
	// (drawn once the Margin has the halt: waited for, as the halt was)
	await eventually("Pin… on its line", () => workbench.evaluate(() => [...document.querySelectorAll("wa-button, button")].some((button) => button.textContent.trim() === "Pin…") || undefined), 30_000);

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
	// (the getter's line as the file has it: a save's ESLint fixes may have spread it over several)
	const written = await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const lines = new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.file("/workspace/getter.ts"))).split("\n");

		return lines.findIndex((line) => line.includes("counter.n += 1")) + 1;
	});

	assert.equal(card(found, "read").flagged, `judged pure, but wrote n (line ${String(written)})`, "the run saw it write outside itself, through the getter");

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

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
