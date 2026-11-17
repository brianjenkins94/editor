/**
 * The debugger (extensions/tsval: node:test on tsval in the debug worker), as a person has it: a test file run from Features
 * and tests, each test's outcome, a failure's sides, a timer on the run's event loop, a read through the runtime's files and
 * a package loaded; a program's capability calls stopped and answered in the margin — allowed, skipped, denied — as the
 * program and the disk then have them; a breakpoint, a step and a step back; and what's typed at a terminal's run reaching
 * the program. What only an agent has of it (runs_tests' approvals, a run at a commit by its path, a run's spans, the
 * bridge's links) is test/agent-tools.mjs's. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, READABLE_TERMINAL, runCommand } from "./editor.mjs";

test("a test file run from Features and tests: each test's outcome, a failure's sides, a timer, a read", async ({ page }) => {
	const workbench = await openEditor(page, {
		".silo/features.json": JSON.stringify({ "Adding": { "status": "active", "why": "Adds.", "since": "2026-11-16", "what": "Adds.", "tests": ["adds.test.mjs"] } }, null, 2) + "\n",
		"adds.test.mjs": [
			"import assert from \"node:assert/strict\";",
			"import { readFileSync } from \"node:fs\";",
			"import { test } from \"node:test\";",
			"",
			"test(\"adds\", () => { assert.equal(1 + 1, 2); });",
			"test(\"fails\", () => { assert.equal(1 + 1, 3); });",
			"test(\"waits\", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });",
			"test(\"reads its own file\", () => { assert.match(readFileSync(\"/workspace/adds.test.mjs\", \"utf8\"), /adds/u); });",
			""
		].join("\n")
	});
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });

	await runCommand(workbench, "Features and Tests: Show");
	await row("adds.test.mjs").locator("wa-button[aria-label='Run adds.test.mjs']").click({ "timeout": 30_000 });
	await expect(workbench.locator(".fv-table tbody tr.fv-feature", { "hasText": "Adding" })).toContainText("1 failing", { "timeout": 120_000 });
	await row("adds.test.mjs").locator(".fv-toggle").click();

	// (each test's row its name, then its outcome if it failed, then its time)
	for (const passing of [/^adds\d/u, /^waits\d/u, /^reads its own file\d/u]) {
		await expect(row(passing)).toHaveCount(1);
	}

	// The failure, with its sides.
	await expect(row(/^failsfail/u)).toHaveAttribute("title", /\b2\b[\s\S]*\b3\b/u);
});

test("a program's capability calls stop in the margin, on their lines, and are made, skipped or refused as answered", async ({ page }) => {
	const workbench = await openEditor(page, {
		"stops.mjs": [
			"import { writeFileSync } from \"node:fs\";",
			"const said = [];",
			"try { writeFileSync(\"/workspace/stop-allowed.txt\", \"a\"); said.push(\"allowed: wrote\"); } catch { said.push(\"allowed: refused\"); }",
			"try { writeFileSync(\"/workspace/stop-skipped.txt\", \"s\"); said.push(\"skipped: wrote\"); } catch { said.push(\"skipped: refused\"); }",
			"try { writeFileSync(\"/workspace/stop-denied.txt\", \"d\"); said.push(\"denied: wrote\"); } catch { said.push(\"denied: refused\"); }",
			"console.log(said.join(\", \"));",
			""
		].join("\n")
	});
	// (the Margin's question for the call the run is stopped at: one at a time)
	const question = workbench.locator(".pane-item.tone-question, .pane-item.tone-warning");
	const choice = (label) => question.locator("wa-button", { "hasText": label }).first();

	await openFile(workbench, "stops.mjs");
	await codeOf(workbench).press("F5");

	// Each asked on its line, and waiting until it's answered: nothing written meanwhile.
	// (each asked on its line, in a cell of the margin's: the Debug Console, opened as the run starts, put out of the way for
	// the room — a short window leaves the editor a few lines, under a cell or two — and brought back to read)
	await expect(choice("Allow")).toBeAttached({ "timeout": 60_000 });
	await runCommand(workbench, "View: Hide Panel");

	for (const answer of ["Allow", "Skip", "Deny"]) {
		await choice(answer).click({ "timeout": 30_000 });
	}

	await runCommand(workbench, "View: Toggle Panel Visibility");
	await expect(workbench.locator(".repl .output", { "hasText": "allowed: wrote, skipped: wrote, denied: refused" }).first()).toBeVisible({ "timeout": 60_000 });

	// As the disk has it: the allowed write made, the skipped and the denied not.
	const shown = (name) => workbench.locator(`[role='treeitem'][aria-level='1'][aria-label='${name}']`);

	await expect(shown("stop-allowed.txt")).toBeVisible({ "timeout": 30_000 });
	await expect(shown("stop-skipped.txt")).toHaveCount(0);
	await expect(shown("stop-denied.txt")).toHaveCount(0);
});

test("a breakpoint stops the run; a step goes on a line, and a step back returns to it", async ({ page }) => {
	const workbench = await openEditor(page, { "steps.mjs": "let x = 1;\nx = 2;\nx = 3;\nconsole.log(\"x is \" + x);\n" });
	const toolbar = (name) => workbench.locator(`.debug-toolbar .action-label[aria-label^='${name}']`);

	await openFile(workbench, "steps.mjs");
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("F9");
	await codeOf(workbench).press("F5");
	// (where it's stopped, as Call Stack says: the file and its line)
	const at = workbench.locator(".debug-call-stack .monaco-list-row").first();

	await expect(at).toContainText("steps.mjs2:1", { "timeout": 60_000 });
	await toolbar("Step Over").click();
	await expect(at).toContainText("steps.mjs3:1", { "timeout": 30_000 });
	await toolbar("Step Back").click();
	await expect(at).toContainText("steps.mjs2:1", { "timeout": 30_000 });
	// Continued, it runs to its end: from line 2 again, x ends as it would have.
	await toolbar("Continue").click();
	await expect(workbench.locator(".repl .output", { "hasText": "x is 3" }).first()).toBeVisible({ "timeout": 30_000 });
});

test("stdin: what's typed at a terminal's run reaches the program", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "stdin.mjs": "process.stdin.on(\"data\", (data) => { console.log(\"got \" + String(data).trim()); process.exit(0); });\nconsole.log(\"listening\");\n" });
	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially("node stdin.mjs\n");
	// (typed once the program reads: before, a line goes to no one)
	await expect(terminal.output).toContainText("listening", { "timeout": 60_000 });
	await terminal.input.pressSequentially("hello\n");
	await expect(terminal.output).toContainText("got hello", { "timeout": 60_000 });
});
