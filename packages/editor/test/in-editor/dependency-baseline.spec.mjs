/**
 * The dependency baseline, and what goes beyond it, where it is (extensions/capabilities/baseline.ts, growth.ts,
 * exceptions.ts): a dependency's version that grew a capability is warned on its line in package.json, with the lightbulb's
 * allow or refuse as a rule in your policy; and what was answered at a call in runs is said on that call. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, quickFix, runCommand } from "./editor.mjs";

/** A baseline in which react's version grew `net` since it was added, as a repository that shares its baseline commits
 *  it (the editor reads `.silo/baseline.json` first, else its own `.silo/local/` copy). */
const BASELINE = JSON.stringify({
	"consumer": {},
	"packages": { "react": { "version": "19.3.1", "caps": ["env", "net"], "grew": { "net": "19.3.1" } } },
	"join": 1
}, undefined, 2);

/** A run in which `fetch` to example.com was allowed once, at its stop. */
const RUN = JSON.stringify({
	"type": "run",
	"id": "run-1",
	"title": "Run — src/call.mjs",
	"entry": "src/call.mjs",
	"cwd": "src",
	"startedAt": "2026-11-09T10:00:00.000Z",
	"endedAt": "2026-11-09T10:00:01.000Z",
	"exit": 0,
	"user": "local",
	"environment": { "runtime": "tsval", "name": "default" },
	"files": {},
	"effects": [{ "capability": "net", "resource": "https://example.com/", "how": "made", "calls": 1, "decided": "once" }]
});

test("a dependency that grew is warned on its line, the lightbulb decides it, and an answer given at a call is on it", async ({ page }) => {
	const workbench = await openEditor(page, {
		"package.json": "{\n  \"dependencies\": {\n    \"react\": \"19.3.1\"\n  }\n}\n",
		".silo/baseline.json": `${BASELINE}\n`,
		".silo/runs/local.jsonl": `${RUN}\n`,
		"src/call.mjs": "await fetch(\"https://example.com/\");\n"
	});

	const rows = await problems(workbench);
	const grew = rows.filter({ "hasText": "react 19.3.1 can do more than when it was added: net" });

	await expect(grew).toHaveCount(1, { "timeout": 60_000 });

	// Its lightbulb, on react's line: allowed always, as a rule about react's net calls, and the warning goes.
	await openFile(workbench, "package.json");
	await codeOf(workbench).press("Control+g");

	const go = workbench.locator(".quick-input-widget input").first();

	await go.fill(":3:6");
	await go.press("Enter");
	await quickFix(workbench, "Allow react's net, always");
	await expect(grew).toHaveCount(0, { "timeout": 30_000 });

	// The call: what's answered at it in runs, beside how the policy decides it. (package.json closed first: its schema
	// warning, open, takes the room in Problems that a list draws only so much of)
	await runCommand(workbench, "View: Close All Editors");
	await openFile(workbench, "src/call.mjs");

	// (the call's finding first: TypeScript's server, cold, then the canary, as capability-findings.spec allows for)
	const call = rows.filter({ "hasText": "net: fetch → https://example.com/" });

	try {
		await expect(call).toHaveCount(1, { "timeout": 90_000 });
	} catch (error) {
		// (what Problems said instead)
		throw new Error(`${String(error)}; Problems said ${JSON.stringify(await rows.allTextContents())}`, { "cause": error });
	}

	await expect(call).toContainText("Answered at the call: allowed once in 1 run");
});
