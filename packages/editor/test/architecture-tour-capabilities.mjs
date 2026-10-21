/**
 * Architecture tour, capabilities and the debugger: capability decisions and the rules that make them (the Rules view,
 * placed rules, a mocked call), real effects, the agent and workspace tools, and the debugger (imports, breakpoints, a
 * program's server and stdin, the terminal, the event loop, explore orderings) — each checked against what the live
 * architecture view saw.
 *
 * One of the tour's shards, each in a session of its own so they run side by side (architecture-tour-session.mjs);
 * the diagram of what they saw together is architecture-diagram.mjs's.
 *
 *   node --test test/architecture-tour-capabilities.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasLabel } from "./architecture-harness.mjs";
import { eventually, inRuleView, openRule, pressInRuleView, ruleRows, ruleStatus, session, tour } from "./architecture-tour-session.mjs";

tour("architecture-tour-capabilities");

// Capability decisions on the line (LIVE-VALUES.md, step 8): a call the policy hasn't decided stops the run at its line,
// and asks there, in the notes margin — what it would do, from the run's own values, and Allow once / Allow always / Deny.
// Deny fails the call as the policy would; Skip doesn't make it, the run going on; Allow once lets it run; Allow always
// writes my policy override, and the next run goes straight through. Rule… opens the rule editor there (RULES.md),
// prefilled with the call: widened to a glob and saved, it decides the call, and the next run's.
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
		const folder = api.Uri.file("/workspace/.silo/policy");
		const policies = (await api.workspace.fs.readDirectory(folder).then((entries) => entries, () => [])).map(([name]) => name).filter((name) => name.endsWith(".json"));

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
		const box = document.querySelector("[data-item=\"ask\"]");

		return box === null ? undefined : { "what": box.querySelector(".pane-markdown").textContent.trim(), "choices": [...box.querySelectorAll(".live-values-choices > .live-values-split > .live-values-choice:not(.more), .live-values-choices > .live-values-choice")].map((button) => button.textContent), "lasting": [...box.querySelectorAll(".live-values-split:first-child .live-values-menu-item")].map((item) => (item.disabled ? `(${item.textContent})` : item.textContent)) };
	});
	// (The tour's first run pays for the run's cold start: in CI 40–50s, and past 60s on a slow runner, where it had failed
	// three times in nine; the runs after it are warm.)
	let cold = true;
	const start = async () => {
		const stopped = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, cold ? 180_000 : 60_000);

		cold = false;

		assert.equal(stopped.reason, "capability", "stopped by the policy, not a breakpoint");
		assert.equal(stopped.line, 5);
		assert.deepEqual(await eventually("the question on its line", asked), { "what": "writeFileSync '/workspace/out.txt' fs:write", "choices": ["Allow", "Skip", "Deny", "Rule…"], "lasting": ["this call", "this run", "always"] });

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

	// Skip: the call isn't made, the run goes on (the stand-in answers), and its line says so.
	const skipped = await session.request(`debug.session.${(await start()).session}.decide`, { "choice": "skip" }, 60_000);

	assert.equal(skipped.state, "terminated");
	assert.deepEqual(skipped.output, ["wrote /workspace/out.txt"], "the run went on past it");
	assert.equal(await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.stat(globalThis.__editor.api.Uri.file("/workspace/out.txt")).then(() => true, () => false)), false, "nothing written");
	assert.equal(await eventually("the skipped call on its line", () => workbench.evaluate(() => [...document.querySelector(".live-values-row[data-line=\"4\"]")?.children ?? []].map((child) => child.textContent.trim()).filter(Boolean).join(" ") || undefined)), "skipped fs:write /workspace/out.txt");

	// Allow, from the margin's own button (this call): the call runs; nothing is written to the policy.
	await start();
	await workbench.evaluate(() => {
		[...document.querySelectorAll("[data-item=\"ask\"] .live-values-choice")].find((button) => button.textContent === "Allow").click();
	});
	await eventually("the question answered", async () => (await asked()) === undefined || undefined);
	assert.deepEqual(await silo("read"), [], "Allow once writes no rule");

	// Allow always: my override gets the rule, and the next run isn't stopped.
	const always = await session.request(`debug.session.${(await start()).session}.decide`, { "choice": "allow-always" }, 60_000);

	assert.equal(always.state, "terminated");
	assert.deepEqual(always.output, ["wrote /workspace/out.txt"]);
	assert.equal(await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file("/workspace/out.txt")).then((bytes) => new TextDecoder().decode(bytes), () => undefined)), "hello", "written for real (RUNNING.md, step 2)");
	assert.deepEqual((await silo("read")).flatMap((policy) => policy.rules.map(({ when, then }) => ({ "when": when, "then": then }))), [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "is", "argument": "/workspace/out.txt" }] }, "then": [{ "action_id": "allow" }] }]);

	const again = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

	assert.equal(again.state, "terminated", "allowed always: no stop");
	assert.deepEqual(again.output, ["wrote /workspace/out.txt"]);

	// A rule: Rule… — the call's capability and resource, then allow — the resource widened to a glob, and saved.
	const status = ruleStatus;
	const saveable = () => inRuleView(() => [...document.querySelectorAll(".rule-panel-choice")].find((button) => button.textContent === "Save as rule")?.disabled === false);
	const resourceRow = (change) => inRuleView(([selector, value, event]) => {
		const field = document.querySelectorAll(".rule-panel .rule-editor-group.top > .rule-editor-rows > .rule-editor-row")[1].querySelector(selector);

		field.value = value;
		field.dispatchEvent(new Event(event));
	}, change);

	// The store drops its cached grant when its file watcher reports the delete: until then a run still goes through.
	await silo("clear");
	await eventually("a run the policy stops again", async () => {
		const run = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

		return run.reason === "capability" || undefined;
	});
	assert.deepEqual(await eventually("the question on its line", asked), { "what": "writeFileSync '/workspace/out.txt' fs:write", "choices": ["Allow", "Skip", "Deny", "Rule…"], "lasting": ["this call", "this run", "always"] });
	await workbench.evaluate(() => {
		[...document.querySelectorAll("[data-item=\"ask\"] .live-values-choice")].find((button) => button.textContent === "Rule…").click();
	});
	assert.equal(await eventually("the rule editor, prefilled", status), "Covers this call: allows it");
	await resourceRow([".rule-editor-operator", "matches", "change"]);
	await resourceRow([".rule-editor-argument", "/tmp/*", "input"]);
	assert.equal(await status(), "Doesn't cover this call");
	assert.equal(await saveable(), false, "a rule that doesn't cover the call can't decide it");
	await resourceRow([".rule-editor-argument", "/workspace/*.txt", "input"]);
	assert.equal(await status(), "Covers this call: allows it");
	assert.equal(await saveable(), true);
	await pressInRuleView("Save as rule");
	await eventually("the question answered", async () => (await asked()) === undefined || undefined);
	assert.deepEqual((await silo("read")).flatMap((policy) => policy.rules.map(({ when, then }) => ({ "when": when, "then": then }))), [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/*.txt" }] }, "then": [{ "action_id": "allow" }] }]);

	const ruled = await session.request("debug.start", { "program": "/workspace/gated.js", "breakpoints": [] }, 60_000);

	assert.equal(ruled.state, "terminated", "the rule allows it: no stop");
	assert.deepEqual(ruled.output, ["wrote /workspace/out.txt"]);

	// As the next tests expect it: no override, no file it wrote, and the Explorer back where a stop put Run and Debug.
	await silo("clear");
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/out.txt")).then(() => undefined, () => undefined);
		await api.commands.executeCommand("workbench.view.explorer");
	});
});

// Real effects (RUNNING.md, step 2): a call the policy allows happens for real — a read gets the file, and what it read
// is recorded (a rule can give it back) — and a call nobody allowed (one the static check can't see, so never asked
// about) fails as a denied one would, rather than quietly doing nothing.
test("real effects: an allowed read reads the file, recorded; a call nobody allowed fails", async () => {
	const workbench = session.workbench();
	const write = (path, text) => workbench.evaluate(([file, body]) => globalThis.__editor.api.workspace.fs.writeFile(globalThis.__editor.api.Uri.file(file), new TextEncoder().encode(body)), [path, text]);

	await write("/workspace/rates.json", "{ \"US\": 0.07, \"CA\": 0.13 }");
	await write("/workspace/effects.js", [
		"const fs = require(\"node:fs\");",
		"",
		"const rates = JSON.parse(fs.readFileSync(\"/workspace/rates.json\", \"utf8\"));",
		"",
		"console.log(\"rate\", rates.CA);",
		"",
		"const method = [\"write\", \"FileSync\"].join(\"\");",
		"",
		"try {",
		"\tfs[method](\"/workspace/sneaky.txt\", \"x\");",
		"} catch (error) {",
		"\tconsole.log(error.code);",
		"}",
		""
	].join("\n"));

	try {
		const ran = await session.request("debug.start", { "program": "/workspace/effects.js", "breakpoints": [] }, 60_000);

		assert.equal(ran.state, "terminated");
		assert.deepEqual(ran.output, ["rate 0.13", "EACCES"], "the real file read; the unasked write refused");
		assert.equal(await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.stat(globalThis.__editor.api.Uri.file("/workspace/sneaky.txt")).then(() => true, () => false)), false, "nothing written");

		const recorded = await eventually("what it read, recorded", async () => (await session.request("capability.recorded", { "capability": "fs:read", "resource": "/workspace/rates.json" }, 10_000)) ?? undefined);

		assert.equal(recorded.value, "{ \"US\": 0.07, \"CA\": 0.13 }", "the text it read");

		// Both, in its envelope in the run ledger: what it did to the world, and what it was refused.
		const run = await eventually("its run, ended", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.title.endsWith(" effects.js") && each.state === "exited"));
		const envelope = await eventually("its envelope", () => workbench.evaluate(async (id) => {
			const { api } = globalThis.__editor;
			const folder = api.Uri.file("/workspace/.silo/runs");

			for (const [name] of await api.workspace.fs.readDirectory(folder).then((found) => found, () => [])) {
				const line = new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.joinPath(folder, name))).split("\n").find((each) => each.includes(id));

				if (line !== undefined) {
					return JSON.parse(line);
				}
			}

			return undefined;
		}, run.id));

		assert.deepEqual(envelope.effects, [
			{ "capability": "fs:read", "resource": "/workspace/rates.json", "how": "made", "calls": 1, "decided": "policy" },
			{ "capability": "fs:write", "resource": "/workspace/sneaky.txt", "how": "denied", "calls": 1, "decided": "policy" }
		], "its effects: the read made, the write refused — both by the policy, nobody asked");

		// The ledger, asked what tried to write sneaky.txt (debug-mcp's runs_ledger): this run, and its refused write.
		const asked = await session.request("runs.ledger", { "capability": "fs", "resource": "sneaky.txt" }, 10_000);

		assert.equal(asked.runs[0]?.id, run.id, "the run that tried it, newest first");
		assert.deepEqual(asked.effects.map(({ capability, how }) => `${capability} ${how}`), ["fs:write denied"], "only the effects asked about");
	} finally {
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;

			for (const path of ["/workspace/effects.js", "/workspace/rates.json", "/workspace/sneaky.txt"]) {
				await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
			}
		});
	}
});

// A package's call beyond its baseline (decide.ts → the capability prompt, shell-preview.ts): the prompt says whose call it
// is and why it's asked — here, a package the baseline never read — and Allow always keeps a rule about that package's
// calls only. It's a dialog over the shell (with or without a preview open), gone once it's answered.
test("package prompt: whose call, and why it's asked; Allow always is about that package; the dialog closes", async () => {
	const workbench = session.workbench();
	const write = (path, text) => workbench.evaluate(([file, body]) => globalThis.__editor.api.workspace.fs.writeFile(globalThis.__editor.api.Uri.file(file), new TextEncoder().encode(body)), [path, text]);
	const remove = (path) => workbench.evaluate((file) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(file), { "recursive": true }).then(() => undefined, () => undefined), path);

	// (the baseline made, as the project opened: what the prompt says is what it says of the package)
	await eventually("the baseline", () => workbench.evaluate(() => globalThis.__editor.api.workspace.fs.stat(globalThis.__editor.api.Uri.file("/workspace/.silo/baseline.json")).then(() => true, () => undefined)), 120_000);
	await write("/workspace/node_modules/sneaky/package.json", JSON.stringify({ "name": "sneaky", "version": "1.0.0", "main": "index.js" }));
	await write("/workspace/node_modules/sneaky/index.js", "const fs = require(\"node:fs\");\n\nmodule.exports = () => fs.writeFileSync(\"/workspace/sneaky-out.txt\", \"x\");\n");
	await write("/workspace/package-call.js", "require(\"sneaky\")();\nconsole.log(\"wrote\");\n");

	try {
		const ran = session.request("debug.start", { "program": "/workspace/package-call.js", "breakpoints": [] }, 120_000);
		const prompt = session.page.locator("wa-dialog", { "hasText": "sneaky 1.0.0" });

		// (the dialog's host has no box of its own: what shows is its content)
		await prompt.locator("wa-button", { "hasText": "Allow always" }).waitFor({ "timeout": 60_000 });

		const text = await prompt.innerText();

		assert.match(text, /sneaky 1\.0\.0 · fs:write/u, "whose call it is, and what");
		assert.match(text, /The baseline has nothing of sneaky/u, "why it's asked");
		assert.match(text, /for sneaky's calls only/u, "what Allow always keeps");

		await prompt.locator("wa-button", { "hasText": "Allow always" }).click();
		assert.deepEqual((await ran).output, ["wrote"], "allowed: the call made");

		const { mine } = await session.execute("silo.rules.files");

		assert.deepEqual(mine.rules[0].when.predicates.filter(({ "target_id": targetId }) => targetId !== "resource").map(({ "target_id": targetId, argument }) => [targetId, argument]), [["capability", "fs:write"], ["package", "sneaky"]], "a rule about sneaky's calls");
		await session.execute("silo.rules.set", mine.rules[0]);

		await eventually("the dialog, closed", async () => (await prompt.count() === 0) || undefined);
	} finally {
		await remove("/workspace/node_modules/sneaky");
		await remove("/workspace/package-call.js");
		await remove("/workspace/sneaky-out.txt");
	}
});

// ESLint (extensions/eslint): real ESLint and the preset, under almostnode in the extension's worker, from the toolchain
// the build packs — a type-aware rule reports with the workspace's types, and fix-all fixes what the editor hides.
test("eslint: real ESLint in its worker — a type-aware problem reported, and fix-all", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/src/lint-probe.ts");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("async function load(): Promise<number> {\n\treturn 1;\n}\n\nexport function run(): void {\n\tvar unused = 1;\n\tload();\n\tconsole.log(unused)\n}\n"));
		await api.window.showTextDocument(uri);
	});

	try {
		const codes = await eventually("eslint's problems", () => workbench.evaluate(() => {
			const { api } = globalThis.__editor;
			const found = api.languages.getDiagnostics(api.Uri.file("/workspace/src/lint-probe.ts")).filter((diagnostic) => diagnostic.source === "eslint").map((diagnostic) => diagnostic.code);

			return found.includes("ts/no-floating-promises") ? found : undefined;
		}), 120_000);

		assert.ok(codes.includes("no-var"), "a rule without types, beside it: " + codes.join(", "));

		const fixed = await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;
			const actions = await api.commands.executeCommand("vscode.executeCodeActionProvider", api.Uri.file("/workspace/src/lint-probe.ts"), new api.Range(0, 0, 0, 0), "source.fixAll.eslint");
			const action = actions.find((each) => each.edit !== undefined);

			return action?.edit.entries()[0][1][0].newText;
		});

		assert.match(fixed, /console\.log\(unused\);/u, "fix-all adds the semicolon the editor hides");
	} finally {
		await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file("/workspace/src/lint-probe.ts")));
	}
});

// A program's file calls are the editor's to make (EXTENSION-POINTS.md, 2: the runtime's files, through core) — so a read
// is what the editor has: an open editor's unsaved text, not what's on disk.
test("a program's read is the editor's: an open editor's unsaved text", async () => {
	const workbench = session.workbench();

	try {
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;
			const data = api.Uri.file("/workspace/unsaved-rates.json");

			await api.workspace.fs.writeFile(data, new TextEncoder().encode("{ \"CA\": 0.13 }"));
			await api.workspace.fs.writeFile(api.Uri.file("/workspace/unsaved-read.js"), new TextEncoder().encode("const fs = require(\"node:fs\");\n\nconsole.log(fs.readFileSync(\"/workspace/unsaved-rates.json\", \"utf8\"));\n"));

			// Edited in its editor, not saved.
			const document = await api.workspace.openTextDocument(data);
			const edit = new api.WorkspaceEdit();

			edit.replace(data, new api.Range(0, 0, document.lineCount, 0), "{ \"CA\": 0.15 }");
			await api.workspace.applyEdit(edit);
		});

		const ran = await session.request("debug.start", { "program": "/workspace/unsaved-read.js", "breakpoints": [] }, 60_000);

		assert.deepEqual(ran.output, ["{ \"CA\": 0.15 }"], "the editor's text, unsaved");
	} finally {
		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;
			const data = api.Uri.file("/workspace/unsaved-rates.json");
			const document = api.workspace.textDocuments.find((each) => each.uri.toString() === data.toString());

			// (its edit undone, then the files gone)
			if (document?.isDirty === true) {
				const edit = new api.WorkspaceEdit();

				edit.replace(data, new api.Range(0, 0, document.lineCount, 0), "{ \"CA\": 0.13 }");
				await api.workspace.applyEdit(edit);
				await document.save();
			}

			for (const path of ["/workspace/unsaved-read.js", "/workspace/unsaved-rates.json"]) {
				await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
			}
		});
	}
});

// Allow this run: a call in a loop asks once — every call like it is allowed until the run ends, and nothing is kept.
// The program's other files are gated and hooked as its entry is (MODULES.md): a capability call in a file it imports
// stops there and asks in that file's margin; a rule placed in it sets its variable when the program gets there.
test("capability decisions and placed rules: in a file the program imports, as in its entry", async () => {
	const workbench = session.workbench();
	const write = (path, lines) => workbench.evaluate(([file, text]) => globalThis.__editor.api.workspace.fs.writeFile(globalThis.__editor.api.Uri.file(file), new TextEncoder().encode(text)), [path, lines.join("\n")]);

	await write("/workspace/store.js", ["const { writeFileSync } = require(\"node:fs\");", "", "function save(name) {", "\twriteFileSync(\"/workspace/\" + name, \"kept\");", "\treturn name;", "}", "module.exports = { save };", ""]);
	await write("/workspace/saving.js", ["const { save } = require(\"./store.js\");", "", "console.log(\"saved\", save(\"notes.txt\"));", ""]);
	await write("/workspace/tally.js", ["function tally(items) {", "\tlet total = 0;", "", "\tfor (const item of items) {", "\t\ttotal += item;", "\t}", "", "\treturn total;", "}", "module.exports = { tally };", ""]);
	await write("/workspace/tallied.js", ["const { tally } = require(\"./tally.js\");", "", "console.log(tally([1, 2, 3]));", ""]);

	let rule;

	try {
		const stopped = await session.request("debug.start", { "program": "/workspace/saving.js", "breakpoints": [] }, 60_000);

		assert.equal(stopped.reason, "capability", "stopped by the policy, in the imported file");
		assert.equal(stopped.file, "/workspace/store.js");
		assert.equal(stopped.line, 4);

		// Its question, in that file's margin.
		await workbench.evaluate(() => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file("/workspace/store.js")));
		assert.equal(await eventually("the question in the imported file's margin", () => workbench.evaluate(() => document.querySelector("[data-item=\"ask\"] .pane-markdown")?.textContent.trim())), "writeFileSync '/workspace/notes.txt' fs:write");

		const ended = await session.request(`debug.session.${stopped.session}.decide`, { "choice": "deny" }, 30_000);

		assert.equal(ended.state, "terminated", "denied: the call fails, the run ends");

		// A rule placed in tally.js — total starts at 100 — set when the program gets there.
		const source = (await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file("/workspace/tally.js")).then((bytes) => new TextDecoder().decode(bytes))));
		const statement = "let total = 0;";
		const [place] = await workbench.evaluate(([text, start, end]) => globalThis.__editor.api.commands.executeCommand("editor.annotations.refer", text, "tally.js", [{ "start": start, "end": end }]).then((answer) => answer.value), [source, source.indexOf(statement), source.indexOf(statement) + statement.length]);

		rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "tally.js" }, { "target_id": "at", "operator_id": "is", "argument": place }] }, "then": [{ "action_id": "set", "target_id": "variables.total", "argument": 100 }] };
		await session.execute("silo.rules.set", undefined, rule);

		const ruled = await session.request("debug.start", { "program": "/workspace/tallied.js", "breakpoints": [] }, 60_000);

		assert.deepEqual(ruled.output, ["106"], "total set to 100 at its statement, in the imported file");
	} finally {
		for (const each of await session.request("debug.sessions", undefined, 10_000).catch(() => [])) {
			await session.request(`debug.session.${each.session}.stop`, undefined, 30_000).catch(() => undefined);
		}

		if (rule !== undefined) {
			await session.execute("silo.rules.set", rule).catch(() => undefined);
		}

		await workbench.evaluate(async () => {
			const { api } = globalThis.__editor;

			for (const path of ["/workspace/store.js", "/workspace/saving.js", "/workspace/tally.js", "/workspace/tallied.js"]) {
				await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
			}

			await api.commands.executeCommand("workbench.view.explorer");
		});
	}
});

// Skip always (util/silo's `skip`): my override skips the call — the run asked goes past it, and every run after goes past
// it without stopping, the call not made and its line saying it was skipped. Deny always likewise fails it, unasked.
test("capability decisions: Skip always and Deny always — every run goes past the call, or fails at it, unasked", async () => {
	const workbench = session.workbench();
	const program = "/workspace/skipping.js";
	// My policy overrides (.silo/policy/<me>.json): read, or cleared.
	const overrides = (action) => workbench.evaluate(async (what) => {
		const { api } = globalThis.__editor;
		const folder = api.Uri.file("/workspace/.silo/policy");
		const names = (await api.workspace.fs.readDirectory(folder).then((entries) => entries, () => [])).map(([name]) => name).filter((name) => name.endsWith(".json"));

		if (what === "clear") {
			for (const name of names) {
				await api.workspace.fs.delete(api.Uri.joinPath(folder, name));
			}

			return [];
		}

		return (await Promise.all(names.map(async (name) => JSON.parse(new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.joinPath(folder, name))))))).flatMap((policy) => policy.rules.map(({ when, then }) => ({ "when": when, "then": then })));
	}, action);
	const written = () => workbench.evaluate(() => globalThis.__editor.api.workspace.fs.stat(globalThis.__editor.api.Uri.file("/workspace/skipped.txt")).then(() => true, () => false));

	try {
		await overrides("clear");
		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode("import { writeFileSync } from \"node:fs\";\n\nwriteFileSync(\"/workspace/skipped.txt\", \"x\");\nconsole.log(\"done\");\n"));
			await api.window.showTextDocument(api.Uri.file(path));
		}, program);

		const stopped = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

		assert.equal(stopped.reason, "capability", "asked at the write");

		const skipped = await session.request(`debug.session.${stopped.session}.decide`, { "choice": "skip-always" }, 60_000);

		assert.equal(skipped.state, "terminated");
		assert.deepEqual(skipped.output, ["done"], "the run went past it");
		assert.deepEqual(await overrides("read"), [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "is", "argument": "/workspace/skipped.txt" }] }, "then": [{ "action_id": "skip" }] }], "kept in my policy");

		const again = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

		assert.equal(again.state, "terminated", "the next run doesn't stop there");
		assert.deepEqual(again.output, ["done"]);
		assert.equal(await written(), false, "never made");
		assert.equal(await eventually("the skipped call on its line", () => workbench.evaluate(() => [...document.querySelector(".live-values-row[data-line=\"2\"]")?.children ?? []].map((child) => child.textContent.trim()).filter(Boolean).join(" ") || undefined)), "skipped fs:write /workspace/skipped.txt");

		// Deny always, as the other lasting choice: the run asked fails there, and the next one fails there without asking.
		await overrides("clear");

		// (Asked again once the policy's change is seen: a run before that still goes past it.)
		const asked = await eventually("asked again, the skip gone", async () => {
			const run = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

			return run.reason === "capability" ? run : undefined;
		});
		const denied = await session.request(`debug.session.${asked.session}.decide`, { "choice": "deny-always" }, 60_000);

		assert.match(denied.output.join("\n"), /EACCES/u);

		const refused = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

		assert.equal(refused.state, "terminated", "denied always: no stop");
		assert.match(refused.output.join("\n"), /EACCES/u, "the call fails, as a denied one does");
	} finally {
		await overrides("clear");
		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;

			await api.commands.executeCommand("workbench.action.closeActiveEditor");
			await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
		}, program);
	}
});

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

// The workspace as an agent works in it (workspace-tools.ts; debug-mcp's files_*, shell and git tools): a file written,
// run in the shell, edited by an exact string, read back numbered, found and searched, and its change as git's diff.
test("workspace tools: write, run, edit, read, find, search and diff — as on a local machine", async () => {
	const request = (subject, data) => session.request(subject, data, 60_000);

	try {
		assert.deepEqual(await request("files.write", { "path": "agent/greet.js", "content": "function greet(name) {\n\treturn \"hello, \" + name;\n}\n\nconsole.log(greet(\"workspace\"));\n" }), { "path": "agent/greet.js", "created": true, "lines": 6 });

		const ran = await request("shell.run", { "command": "node greet.js", "cwd": "agent" });

		assert.equal(ran.exitCode, 0);
		assert.match(ran.output, /hello, workspace/u, "run in the workspace's shell");

		// eslint-disable-next-line no-template-curly-in-string -- the program's text, a template literal in it
		assert.deepEqual(await request("files.edit", { "path": "agent/greet.js", "old": "\"hello, \" + name", "new": "`hello, ${name}!`" }), { "path": "agent/greet.js", "replaced": 1 });
		await assert.rejects(request("files.edit", { "path": "agent/greet.js", "old": "greet", "new": "hail" }), /2 times/u, "an ambiguous edit says so, and changes nothing");

		const read = await request("files.read", { "path": "/workspace/agent/greet.js", "offset": 2, "limit": 1 });

		// eslint-disable-next-line no-template-curly-in-string -- the program's text, a template literal in it
		assert.deepEqual([read.from, read.to, read.lines, read.content], [2, 2, 6, "2\t\treturn `hello, ${name}!`;"]);
		assert.match((await request("shell.run", { "command": "node agent/greet.js" })).output, /hello, workspace!/u, "the edit, saved");
		// (in the order it's printed: the line's other output comes back when the line's done, node's as it runs)
		assert.equal((await request("shell.run", { "command": "echo first; node agent/greet.js; echo last" })).output.trim(), "first\nhello, workspace!\nlast");

		assert.deepEqual((await request("files.glob", { "pattern": "agent/**/*.js" })).files, ["agent/greet.js"]);
		assert.deepEqual((await request("files.grep", { "pattern": "greet\\(", "glob": "agent/**" })).matches.map(({ line }) => line), [1, 5]);
		assert.match((await request("git.diff", { "path": "agent/greet.js" })).diff, /^--- \/dev\/null\n\+\+\+ b\/agent\/greet\.js\n@@ -0,0 \+1,5 @@\n\+function greet/u);

		await assert.rejects(request("files.read", { "path": "../etc/passwd" }), /outside the workspace/u);
		assert.equal((await request("shell.run", { "command": "cat agent/nope" })).exitCode, 1);
	} finally {
		await request("shell.run", { "command": "rm -r agent" }).catch(() => undefined);
	}
});

test("capability decisions: Allow this run lets a loop's calls through, until the run ends", async () => {
	const workbench = session.workbench();
	const program = "/workspace/looped.js";
	const policies = () => workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		return (await api.workspace.fs.readDirectory(api.Uri.file("/workspace/.silo/policy")).then((entries) => entries, () => [])).map(([name]) => name).filter((name) => name.endsWith(".json"));
	});

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		// eslint-disable-next-line no-template-curly-in-string -- the program's own template literal, as text
		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(["import { writeFileSync } from \"node:fs\";", "", "for (const name of [\"a\", \"b\", \"c\"]) {", "\twriteFileSync(`/workspace/${name}.txt`, name);", "}", "console.log(\"wrote 3\");", ""].join("\n")));
		await api.window.showTextDocument(uri);
	}, program);

	const before = await policies();
	const stopped = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.equal(stopped.reason, "capability");

	// The resource is computed on the line (a template) — known all the same, from a fork run to the call — so Allow always
	// is offered too.
	const question = await eventually("its question", () => workbench.evaluate(() => {
		const box = document.querySelector("[data-item=\"ask\"]");

		return box === null ? undefined : { "what": box.querySelector(".pane-markdown").textContent.trim(), "choices": [...box.querySelectorAll(".live-values-choices > .live-values-split > .live-values-choice:not(.more), .live-values-choices > .live-values-choice")].map((button) => button.textContent), "lasting": [...box.querySelectorAll(".live-values-split:first-child .live-values-menu-item")].map((item) => (item.disabled ? `(${item.textContent})` : item.textContent)) };
	}));

	assert.deepEqual(question, { "what": "writeFileSync '/workspace/a.txt' fs:write", "choices": ["Allow", "Skip", "Deny", "Rule…"], "lasting": ["this call", "this run", "always"] });

	// Every fs:write until the run ends: asked once, for the loop's three.
	const ran = await session.request(`debug.session.${stopped.session}.decide`, { "choice": "allow-run" }, 60_000);

	assert.equal(ran.state, "terminated", "no stop on the next turns");
	assert.deepEqual(ran.output, ["wrote 3"]);
	assert.deepEqual(await policies(), before, "nothing kept");

	const written = ["/workspace/a.txt", "/workspace/b.txt", "/workspace/c.txt"];

	assert.deepEqual(await workbench.evaluate((paths) => Promise.all(paths.map((path) => globalThis.__editor.api.workspace.fs.readFile(globalThis.__editor.api.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => undefined))), written), ["a", "b", "c"], "written for real (RUNNING.md, step 2)");

	// A new run asks again.
	const again = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.equal(again.reason, "capability");
	await session.request(`debug.session.${again.session}.stop`, undefined, 30_000);
	await workbench.evaluate(async (paths) => {
		const { api } = globalThis.__editor;

		for (const path of paths) {
			await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
		}
	}, [program, ...written]);
});

// The Rules view (the capabilities extension's tree, rules-tree.ts; its editor, the Rule view, rule-view.ts): every rule as a sentence,
// mine first; a rule saved anywhere shows up in it, and one opened can be removed.
test("rules view: every rule as a sentence, opened and removed there", async () => {
	const workbench = session.workbench();
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/*.txt" }] }, "then": [{ "action_id": "allow" }] };
	const lines = () => ruleRows(workbench);

	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("silo.rules.focus"));
	await session.execute("silo.rules.set", undefined, rule);
	assert.deepEqual(await eventually("the rule, listed", async () => ((await lines())?.length === 1 ? lines() : undefined)), ["capability is fs:write and resource matches /workspace/*.txt → allow"]);

	// Opened: the rule editor (the Rule view), with Remove.
	await openRule(workbench, "first");
	await eventually("its editor", () => inRuleView(() => [...document.querySelectorAll(".rule-panel-choice")].some((button) => button.textContent === "Remove") || undefined));
	await pressInRuleView("Remove");
	assert.deepEqual(await eventually("no rules", async () => ((await lines())?.length === 0 ? lines() : undefined)), []);
	assert.deepEqual((await session.execute("silo.rules.files")).mine.rules, []);
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
	const [gone] = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.annotations.refer", "let gone = 0;\n", "placed.js", [{ "start": 0, "end": 13 }]).then((answer) => answer.value));
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "placed.js" }, { "target_id": "at", "operator_id": "is", "argument": gone }] }, "then": [{ "action_id": "set", "target_id": "variables.x", "argument": 5 }] };
	const listed = () => session.execute("silo.rules.files");

	await session.execute("silo.rules.set", undefined, rule);
	assert.equal((await listed()).mine.places[0].status, "orphaned");
	assert.match(await eventually("the broken rule", async () => (await ruleRows(workbench))?.find((label) => /place in the code is lost/u.test(label))), /place in the code is lost/u);

	// Select `let y = 2;`, open the rule, Re-place at selection.
	await workbench.evaluate(() => {
		const { api } = globalThis.__editor;
		const editor = api.window.activeTextEditor;

		editor.selection = new api.Selection(1, 0, 1, 10);
	});
	await openRule(workbench, "broken");
	await eventually("Re-place at selection", () => inRuleView(() => [...document.querySelectorAll(".rule-panel-choice")].some((button) => button.textContent === "Re-place at selection") || undefined));
	await pressInRuleView("Re-place at selection");

	const placed = await eventually("the rule, re-placed", async () => {
		const { mine } = await listed();

		return mine.places[0]?.status !== "orphaned" ? mine : undefined;
	});

	assert.equal(placed.places[0].line, 2);
	assert.deepEqual(placed.rules[0].then, rule.then);
	await session.execute("silo.rules.set", placed.rules[0]);
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
	const listed = () => session.execute("silo.rules.files");
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

		await editor.edit((builder) => {
			builder.replace(new api.Range(from, 0, to, 0), contents);
		});
	}, [fromLine, toLine, text]);

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/marked.js");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("let price = 10;\nlet tax = 2;\nconsole.log(price + tax);\n"));
		await api.window.showTextDocument(uri);
	});

	const [here] = await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.annotations.refer", "let price = 10;\nlet tax = 2;\nconsole.log(price + tax);\n", "marked.js", [{ "start": 16, "end": 28 }]).then((answer) => answer.value));
	const rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": "marked.js" }, { "target_id": "at", "operator_id": "is", "argument": here }] }, "then": [{ "action_id": "set", "target_id": "variables.tax", "argument": 5 }] };
	// The shared contract's own rule, placed there too (written as a person would: silo reads the contract).
	const shared = { ...rule, "then": [{ "action_id": "set", "target_id": "variables.tax", "argument": 7 }] };
	const contract = await read("/workspace/.silo/policy.json");

	await write("/workspace/.silo/policy.json", JSON.stringify({ "version": 1, "rules": [shared, ...contract === null ? [] : JSON.parse(contract).rules ?? []] }, null, "\t") + "\n");
	await session.execute("silo.rules.set", undefined, rule);

	const [mark] = await eventually("the rules' mark", async () => {
		const shown = await marks();

		// Both rules on it: each policy file's write redraws the margin, and the first can land between the two.
		return shown.length === 1 && shown[0].title.includes("My rule") && shown[0].title.includes("shared") ? shown : undefined;
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
		const { mine, "shared": theirs } = await listed();
		const moved = (rules, from) => rules.find((each) => JSON.stringify(each.then) === JSON.stringify(from.then) && JSON.stringify(each.when) !== JSON.stringify(from.when));

		return moved(mine.rules, rule) !== undefined && moved(theirs.rules, shared) !== undefined ? { "mine": mine, "shared": theirs } : undefined;
	});

	assert.deepEqual([kept.mine.places[0].status, kept.mine.places[0].line], ["attached", 4]);
	assert.deepEqual([kept.shared.places[0].status, kept.shared.places[0].line], ["attached", 4]);
	assert.equal(kept.mine.rules[0].added, added, "moving a place isn't deciding anything");
	await session.execute("silo.rules.set", kept.mine.rules[0]);
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
	await eventually("the question", () => workbench.evaluate(() => document.querySelector("[data-item=\"ask\"]") !== null || undefined));
	await workbench.evaluate(() => {
		[...document.querySelectorAll("[data-item=\"ask\"] .live-values-choice")].find((button) => button.textContent === "Rule…").click();
	});

	assert.match(await eventually("the rule, given what it returned", async () => ((await ruleStatus() ?? "").startsWith("Covers this call: gives it what it returned on ") ? ruleStatus() : undefined)), /^Covers this call: gives it what it returned on /u);
	assert.equal(await inRuleView(() => document.querySelector(".rule-panel .rule-editor-then .rule-editor-action-target").value), "result");
	await pressInRuleView("Save as rule");

	// Saved, the run goes on with it (and ends); the next run is given it with no stop, past both awaits.
	await eventually("the question answered", () => workbench.evaluate(() => document.querySelector("[data-item=\"ask\"]") === null || undefined));

	const again = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	assert.equal(again.state, "terminated", "given by the rule: no stop");
	assert.deepEqual(again.output.filter((line) => !line.startsWith("→")), ["CA 0.13"]);

	// And a breakpoint after the awaits stops there, in the async function.
	const paused = await session.request("debug.start", { "program": program, "breakpoints": [5] }, 60_000);

	assert.equal(paused.line, 5);
	assert.equal(paused.function, "main");
	await session.request(`debug.session.${paused.session}.stop`, undefined, 30_000);

	const { mine } = await session.execute("silo.rules.files");

	await session.execute("silo.rules.set", mine.rules[0]);
	await session.request("debug.breakpoints", { "program": program, "lines": [] }, 30_000);
	await workbench.evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.view.explorer"));
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

// A debug run's imports go through almostnode (MODULES.md): built-ins and packages load natively — not stepped, as a
// library isn't — and the program's other files are tsval's, where before every import but fs and child_process was inert.
test("debugger: a program's imports — built-ins and its other files — load", async () => {
	const workbench = session.workbench();

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const write = (path, lines) => api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(lines.join("\n")));

		await write("/workspace/greet.js", ["module.exports = (who) => \"hello, \" + who;", ""]);
		await write("/workspace/deps.js", [
			"import path from \"node:path\";",
			"import { EventEmitter } from \"node:events\";",
			"",
			"const greet = require(\"./greet.js\");",
			"const events = new EventEmitter();",
			"",
			"events.on(\"file\", (name) => console.log(greet(name)));",
			"events.emit(\"file\", path.basename(\"/workspace/notes/today.txt\"));",
			""
		]);
	});

	const ran = await session.request("debug.start", { "program": "/workspace/deps.js", "breakpoints": [] }, 60_000);

	assert.equal(ran.state, "terminated");
	assert.deepEqual(ran.output.filter((line) => !line.startsWith("→")), ["hello, today.txt"]);
	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.delete(api.Uri.file("/workspace/deps.js"));
		await api.workspace.fs.delete(api.Uri.file("/workspace/greet.js"));
	});
});

// The program's other files are stepped too (MODULES.md): almostnode resolves an import, tsval evaluates the file — a
// breakpoint in it stops there, a frame naming its file and function, its values in its own margin, and stepping in
// from the importer goes into it.
test("debugger: a breakpoint in a file the program imports, its values, and stepping into it", async () => {
	const workbench = session.workbench();
	const program = "/workspace/measure.ts";
	const imported = "/workspace/shapes.ts";

	await workbench.evaluate(async ([main, shapes]) => {
		const { api } = globalThis.__editor;
		const write = (path, lines) => api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(lines.join("\n")));

		await write(shapes, ["export function area(width: number, height: number): number {", "\tconst product = width * height;", "", "\treturn product;", "}", ""]);
		await write(main, ["import { area } from \"./shapes\";", "", "const size = area(3, 4);", "", "console.log(\"area\", size);", ""]);
	}, [program, imported]);

	try {
		await session.request("debug.breakpoints", { "program": imported, "lines": [2] }, 10_000);

		const stopped = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

		assert.equal(stopped.state, "stopped");
		assert.equal(stopped.file, imported, "stopped in the imported file");
		assert.equal(stopped.line, 2);
		assert.equal(stopped.function, "area");
		assert.equal(stopped.code, "const product = width * height;");
		assert.equal(stopped.locals.find(({ name }) => name === "width")?.value, "3", "its own locals");

		// Its values in its own margin.
		await workbench.evaluate((path) => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file(path)), imported);

		const parameters = await eventually("the imported file's values in its margin", () => workbench.evaluate(() => document.querySelector(".live-values-row[data-line=\"0\"]")?.textContent.trim()));

		assert.equal(parameters, "width = 3, height = 4");

		const ended = await session.request(`debug.session.${stopped.session}.step`, { "action": "continue" }, 30_000);

		assert.equal(ended.state, "terminated");
		assert.ok(ended.output.includes("area 12"), "ran on, back in the importer");

		// Stepping in, from the call in the importer.
		await session.request("debug.breakpoints", { "program": imported, "lines": [] }, 10_000);

		let at = await session.request("debug.start", { "program": program, "breakpoints": [3] }, 60_000);

		assert.equal(at.line, 3);
		assert.equal(at.file, undefined, "the program's own file");

		for (let steps = 0; steps < 12 && at.state === "stopped" && at.file !== imported; steps += 1) {
			at = await session.request(`debug.session.${at.session}.step`, { "action": "stepIn" }, 30_000);
		}

		assert.equal(at.file, imported, "stepped into the imported file");
		assert.equal(at.function, "area");
		await session.request(`debug.session.${at.session}.stop`, undefined, 30_000).catch(() => undefined);
	} finally {
		for (const each of await session.request("debug.sessions", undefined, 10_000).catch(() => [])) {
			await session.request(`debug.session.${each.session}.stop`, undefined, 30_000).catch(() => undefined);
		}

		await session.request("debug.breakpoints", { "program": imported, "lines": [] }, 10_000).catch(() => undefined);
		await workbench.evaluate(async ([main, shapes]) => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file(main));
			await api.workspace.fs.delete(api.Uri.file(shapes));
		}, [program, imported]);
	}
});

// A service under the debugger: a node:http server the program starts (almostnode's, in the debug worker) keeps the run
// alive — idle, serving — and answers the preview's requests for its port, a page with the preview's tap in it (as a
// run's server's: workspace-runtime.ts); the run is a service, with that port.
test("debugger: a program's server answers the preview, and keeps the run alive", async () => {
	const workbench = session.workbench();
	const program = "/workspace/serve.js";
	const get = async (url) => {
		const reply = await session.request("virtual.request", { "port": 4321, "method": "GET", "url": url, "headers": {} }, 30_000);
		const body = reply.body instanceof Uint8Array ? reply.body : Uint8Array.from(Array.isArray(reply.body) ? reply.body : Object.values(reply.body));

		return `${reply.status} ${new TextDecoder().decode(body)}`;
	};

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode([
			"import http from \"node:http\";",
			"",
			"let hits = 0;",
			"const server = http.createServer((request, response) => {",
			"\tif (request.url === \"/page\") {",
			"\t\tresponse.writeHead(200, { \"content-type\": \"text/html\" });",
			"\t\tresponse.end(\"<html><head><title>p</title></head><body>hi</body></html>\");",
			"\t\treturn;",
			"\t}",
			"\thits += 1;",
			"\tresponse.writeHead(200, { \"content-type\": \"text/plain\" });",
			"\tresponse.end(\"hello \" + request.url + \" #\" + hits);",
			"});",
			"",
			"server.listen(4321, () => console.log(\"up\"));",
			""
		].join("\n")));
	}, program);

	const started = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);

	try {
		assert.equal(started.state, "idle", "serving, not ended");

		// Its preview, opened on its port (RUNNING.md, step 4) — the program's own server answering it, no dev server.
		const preview = await eventually("its preview window", () => session.page.frames().find((frame) => /\/__virtual__\/[^/]+\/4321\//u.test(frame.url())));

		assert.match(await eventually("the page", async () => (await preview.evaluate(() => document.body?.textContent ?? "").catch(() => "")) || undefined), /^hello \/ #\d+$/u);

		const first = await get("/hello");
		const hits = Number(/#(\d+)$/u.exec(first)?.[1]);

		assert.match(first, /^200 hello \/hello #\d+$/u);
		assert.equal(await get("/again"), `200 hello /again #${hits + 1}`, "the program's state, kept between requests");
		assert.match(await get("/page"), /^200 <html><head>\n<script>.*__editorTap.*<\/script><title>p<\/title>/su, "a page it serves gets the preview's tap first, as a run's server's does");
		assert.ok((await session.request("runs.list", undefined, 5000)).some((run) => run.kind === "service" && run.port === 4321), "a service, with its port");
		await session.until("its server, observed", hasLabel("debug-worker", "server:4321", /./u));
		await session.request(`debug.session.${started.session}.stop`, undefined, 30_000);
		await eventually("its preview closed with the run", () => !session.page.frames().some((frame) => /\/__virtual__\/[^/]+\/4321\//u.test(frame.url())) || undefined);
	} finally {
		await session.request(`debug.session.${started.session}.stop`, undefined, 30_000).catch(() => undefined);
		await workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(path)), program);
	}
});

// stdin under the debugger: a program listening on process.stdin waits (idle) for input — the Debug Console's lines, or
// debug.session.<id>.stdin — and goes on with each; it ends when it stops listening.
test("debugger: a program reads its stdin from the Debug Console", async () => {
	const workbench = session.workbench();
	const program = "/workspace/echo.js";

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode([
			"process.stdin.on(\"data\", (chunk) => {",
			"\tconst line = String(chunk).trim();",
			"",
			"\tconsole.log(\"got \" + line.toUpperCase());",
			"\tif (line === \"bye\") {",
			"\t\tprocess.stdin.removeAllListeners(\"data\");",
			"\t}",
			"});",
			"console.log(\"ready\");",
			""
		].join("\n")));
	}, program);

	const started = await session.request("debug.start", { "program": program, "breakpoints": [] }, 60_000);
	const output = async () => (await session.request(`debug.session.${started.session}.state`, undefined, 10_000)).output;

	try {
		assert.equal(started.state, "idle", "waiting on its input");
		assert.deepEqual(started.output, ["ready"]);
		await session.request(`debug.session.${started.session}.stdin`, { "data": "hi\n" }, 10_000);
		await eventually("its answer", async () => ((await output()).includes("got HI") || undefined));
		await session.request(`debug.session.${started.session}.stdin`, { "data": "bye\n" }, 10_000);
		await eventually("the run over, once it stops listening", async () => (!(await session.request("debug.sessions", undefined, 10_000)).some((each) => each.session === started.session && each.state !== "terminated") || undefined));
	} finally {
		await session.request(`debug.session.${started.session}.stop`, undefined, 30_000).catch(() => undefined);
		await workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(path)), program);
	}
});

// `node` in the terminal is a run like any other (RUNNING.md, step 3): in the debugger, with the command line's arguments,
// the shell's directory and environment; its output in that terminal, and what's typed there its stdin. (Through a
// terminal's shell process, driven over the hub — `terminal.run`, as a task's terminal is — rather than typed into one.)
test("terminal: node runs in the debugger with its args, cwd and env — output and stdin in the terminal", async () => {
	const workbench = session.workbench();
	// (A terminal's id as a task's is — one of a kind, so the diagram folds it: `terminal.in.*`.)
	const id = crypto.randomUUID();
	const screen = () => workbench.evaluate(() => (globalThis.__terminalSeen ?? []).join(""));
	const type = (text) => workbench.evaluate(([terminal, keys]) => {
		globalThis.__architecture.hub.publish(`terminal.in.${terminal}`, keys);
	}, [id, text]);

	await workbench.evaluate(async (terminal) => {
		const { api } = globalThis.__editor;

		globalThis.__terminalSeen = [];
		globalThis.__terminalOff = globalThis.__architecture.hub.subscribe(`terminal.out.${terminal}`, (data) => {
			globalThis.__terminalSeen.push(String(data));
		});
		await api.workspace.fs.createDirectory(api.Uri.file("/workspace/sub"));
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/argv.js"), new TextEncoder().encode([
			"console.log(\"args\", process.argv.slice(2).join(\",\"), \"in\", process.cwd(), \"with\", process.env.GREETING ?? \"none\");",
			"process.stdin.on(\"data\", (chunk) => {",
			"\tconst line = String(chunk).trim();",
			"",
			"\tconsole.log(\"got \" + line);",
			"\tif (line === \"bye\") {",
			"\t\tprocess.stdin.removeAllListeners(\"data\");",
			"\t}",
			"});",
			""
		].join("\n")));
	}, id);

	try {
		assert.equal(await session.request("terminal.run", { "id": id, "command": "export GREETING=hey && cd sub && node ../argv.js one two", "cwd": "/workspace" }, 10_000), true);
		await eventually("its output, in the terminal", async () => ((await screen()).includes("args one,two in /workspace/sub with hey") || undefined));
		await session.until("its terminal, seen", () => true); // (the diagram sees the terminal's subjects while they're there)
		assert.ok((await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node ../argv.js one two" && run.runtime === "tsval" && run.state === "running"), "a run, in the debugger");

		// Typed in the terminal (a line at a time, as a terminal gives it): the program's stdin.
		await type("hi\r");
		await eventually("its answer", async () => ((await screen()).includes("got hi") || undefined));
		await type("bye\r");
		await eventually("the run over", async () => ((await session.request("runs.list", undefined, 5000)).some((run) => run.title === "node ../argv.js one two" && run.state === "exited") || undefined));
		assert.ok(!(await screen()).includes("running in the Debug Console"), "no pointer elsewhere: it's here");
	} finally {
		await workbench.evaluate(async (terminal) => {
			const { api } = globalThis.__editor;

			globalThis.__terminalOff?.();
			globalThis.__architecture.hub.publish(`terminal.stop.${terminal}`, {});
			await api.workspace.fs.delete(api.Uri.file("/workspace/argv.js")).then(() => undefined, () => undefined);
			await api.workspace.fs.delete(api.Uri.file("/workspace/sub"), { "recursive": true }).then(() => undefined, () => undefined);
		}, id);
	}
});

// The event loop in the debugger: its own scope in the Variables view (the virtual clock, the timers pending) — and Skip
// Waits, from the debug toolbar: a 5s timer fires at once, its clock still reading +5000ms.
test("debugger: the event loop's scope, and Skip Waits", async () => {
	const workbench = session.workbench();
	const program = "/workspace/waits.js";
	// The Event loop scope, as a stop reports it (the Variables view shows the same rows).
	const loopOf = (outcome) => Object.fromEntries(outcome.eventLoop.map(({ name, value }) => [name, value]));

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode(["const start = Date.now();", "setTimeout(() => {", "\tconsole.log(\"waited\", Date.now() - start);", "}, 5000);", ""].join("\n")));
	}, program);

	const first = await session.request("debug.start", { "program": program, "breakpoints": [1, 3] }, 60_000);

	// (Stopped however it goes: a session left paused would hold up the tests after this one.)
	try {
		assert.equal(first.line, 1);
		assert.match(loopOf(first).time, /^\+0ms · /u);

		// (The debug toolbar's Skip Waits does this for the active session.)
		await session.request(`debug.session.${first.session}.pace`, { "pace": "fast" }, 10_000);

		const started = Date.now();
		const inTimer = await session.request(`debug.session.${first.session}.step`, { "action": "continue" }, 30_000);

		const took = Date.now() - started;

		assert.equal(inTimer.line, 3);
		assert.ok(took < 4_000, `the 5s wait skipped (took ${took}ms)`);

		const loop = loopOf(inTimer);

		assert.match(loop.time, /^\+5000ms · /u);
		assert.equal(loop.pace, "skipping waits");
	} finally {
		// Left as the other tests expect it: no session, no breakpoints, the Explorer back (a stop opens Run and Debug).
		await session.request(`debug.session.${first.session}.stop`, undefined, 30_000).catch(() => undefined);
		await session.request("debug.breakpoints", { "program": program, "lines": [] }, 30_000);
		await workbench.evaluate(async (path) => {
			const { api } = globalThis.__editor;

			await api.workspace.fs.delete(api.Uri.file(path));
			await api.commands.executeCommand("workbench.view.explorer");
		}, program);
	}
});

// Exploring a race (tsval's explore): every ordering of the file's fetch results and its timer run, the distinct endings
// found — and one of them debugged, run exactly that way (its schedule, as a launch's eventLoop).
test("explore orderings: a race's endings, each debugged by its schedule", async () => {
	const workbench = session.workbench();
	const program = "/workspace/race.js";
	const allowNet = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "net" }] }, "then": [{ "action_id": "allow" }] };

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(path), new TextEncoder().encode([
			"let last;",
			"fetch(\"https://a.example/\").then(() => { last = \"a\"; });",
			"fetch(\"https://b.example/\").then(() => { last = \"b\"; });",
			"void setTimeout(() => console.log(last ?? \"nothing yet\"), 10);",
			""
		].join("\n")));
	}, program);
	// (The fetches allowed: a debug run doesn't stop at them to ask.)
	await session.execute("silo.rules.set", undefined, allowNet);

	const explored = await session.request("debug.explore", { "program": program }, 120_000);

	assert.ok(explored.complete);
	assert.deepEqual(explored.outcomes.map(({ output }) => output[0]).sort(), ["a", "b", "nothing yet"]);

	const [first] = explored.outcomes.filter(({ output }) => output[0] === "a");
	const ran = await session.request("debug.start", { "program": program, "breakpoints": [], "eventLoop": { ...explored.eventLoop, "schedule": first.schedule } }, 60_000);

	assert.deepEqual(ran.output, ["a"], "the ordering, run again in the debugger");

	const [rule] = (await session.execute("silo.rules.files")).mine.rules;

	await session.execute("silo.rules.set", rule);
	await workbench.evaluate((path) => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file(path)), program);
});

// ESLint lints with the workspace's own eslint.config, as on a desktop — the repository's code, run in the worker: its
// rules over the preset's, loaded afresh as it changes; one that can't load is a problem on it, and the preset lints; and
// it can't reach out.
test("eslint: the workspace's own eslint.config — its rules, reloaded as it changes; one that can't load says so; no network", async () => {
	const workbench = session.workbench();
	const write = (path, text) => workbench.evaluate(async ([file, contents]) => {
		const { api } = globalThis.__editor;

		await api.workspace.fs.writeFile(api.Uri.file(file), new TextEncoder().encode(contents));
	}, [path, text]);
	const codes = (path) => workbench.evaluate((file) => {
		const { api } = globalThis.__editor;

		return api.languages.getDiagnostics(api.Uri.file(file)).filter((diagnostic) => diagnostic.source === "eslint").map((diagnostic) => [diagnostic.code ?? "", diagnostic.message]);
	}, path);

	await write("/workspace/src/config-probe.ts", "export function run(): void {\n\tvar count = 1;\n\tconsole.log(count);\n}\n");
	await write("/workspace/eslint.config.js", "import config from \"@brianjenkins94/util/eslint\";\n\nexport default [...config, { \"rules\": { \"no-var\": \"off\", \"no-console\": \"error\" } }];\n");
	await workbench.evaluate(() => globalThis.__editor.api.window.showTextDocument(globalThis.__editor.api.Uri.file("/workspace/src/config-probe.ts")));

	try {
		const own = await eventually("the workspace config's rules", async () => {
			const found = (await codes("/workspace/src/config-probe.ts")).map(([code]) => code);

			return found.includes("no-console") ? found : undefined;
		}, 240_000);

		assert.ok(!own.includes("no-var"), "a rule it turns off is off: " + own.join(", "));

		await write("/workspace/eslint.config.js", "import nope from \"eslint-plugin-nope\";\n\nexport default [nope];\n");

		const said = await eventually("the config's problem", async () => (await codes("/workspace/eslint.config.js")).find(([, message]) => message.includes("couldn't load this config")), 240_000);

		assert.match(said[1], /eslint-plugin-nope/u, "it says why: " + said[1]);

		const preset = await eventually("the preset, meanwhile", async () => {
			const found = (await codes("/workspace/src/config-probe.ts")).map(([code]) => code);

			return found.includes("no-var") ? found : undefined;
		}, 240_000);

		assert.ok(!preset.includes("no-console"), "the preset's rules, not the broken config's: " + preset.join(", "));

		// (and the repository's code can't reach out: the worker's network is shut before it runs)
		await write("/workspace/eslint.config.js", "await fetch(\"https://example.com/?leak\");\n\nexport default [];\n");

		const shut = await eventually("the network refused", async () => (await codes("/workspace/eslint.config.js")).find(([, message]) => message.includes("has no network")), 240_000);

		assert.match(shut[1], /fetch/u, "its fetch was refused: " + shut[1]);
	} finally {
		// (the config gone, the worker starts afresh with the preset and lints every open document again: done before the
		// session's checks. Last but those, as a worker started afresh is cold: a later save would wait on it)
		await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file("/workspace/eslint.config.js")).then(() => undefined, () => undefined));
		await eventually("the preset again", async () => ((await codes("/workspace/src/config-probe.ts")).some(([code]) => code === "no-var") && (await codes("/workspace/eslint.config.js")).length === 0 ? true : undefined), 240_000).catch(() => undefined);
		await workbench.evaluate(() => globalThis.__editor.api.workspace.fs.delete(globalThis.__editor.api.Uri.file("/workspace/src/config-probe.ts")).then(() => undefined, () => undefined));
	}
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
