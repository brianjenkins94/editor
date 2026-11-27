/**
 * `page.route` in a Playwright test run in the editor's debugger (packages/playwright's route.ts, shell/preview-routes.ts,
 * the service worker's routedFirst): the app's requests its routes match are theirs to answer — one to its own server
 * fulfilled with JSON, one to another site fulfilled before anyone's asked whether it may go, one aborted — and what no
 * route matches goes where it was going. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openTerminal, READABLE_TERMINAL, runCommand } from "./editor.mjs";

const LEDGER = {
	"The app": { "status": "active", "why": "An app to test.", "since": "2026-11-27", "what": "An app to test.", "tests": ["pwapp/route.spec.mjs"] }
};
const files = {
	...READABLE_TERMINAL,
	".silo/features.json": JSON.stringify(LEDGER, null, 2) + "\n",
	"pwapp/index.html": "<!doctype html><html><body><button>not yet</button><output></output><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
	"pwapp/real.txt": "real",
	"pwapp/src/main.ts": [
		"const button = document.querySelector(\"button\")!;",
		"const text = async (url: string) => fetch(url).then(async (response) => (response.ok ? response.text() : \"status \" + String(response.status)), () => \"failed\");",
		"",
		"button.textContent = \"ready\";",
		"button.addEventListener(\"click\", async () => {",
		"\tconst said = await Promise.all([text(\"/api/greeting\"), text(\"https://api.example.invalid/weather\"), text(\"/real.txt\"), text(\"/blocked\")]);",
		"",
		"\tdocument.querySelector(\"output\")!.textContent = said.join(\" | \");",
		"});",
		""
	].join("\n"),
	"pwapp/route.spec.mjs": [
		"import { expect, test } from \"@playwright/test\";",
		"",
		"test(\"its requests, answered by routes\", async ({ page }) => {",
		"\tawait page.route(\"**/api/greeting\", async (route) => route.fulfill({ \"json\": { \"text\": \"hello\" } }));",
		"\tawait page.route(\"https://api.example.invalid/**\", async (route) => route.fulfill({ \"body\": \"sunny\" }));",
		"\tawait page.route(\"**/blocked\", async (route) => route.abort());",
		"\tawait page.getByRole(\"button\").click();",
		"\tawait expect(page.locator(\"output\")).toHaveText(\"{\\\"text\\\":\\\"hello\\\"} | sunny | real | failed\", { \"timeout\": 30000 });",
		"});",
		""
	].join("\n")
};

test("a spec's routes answer the app's requests: fulfilled, aborted, or on where they were going", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });
	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially("cd pwapp && vite\n");

	const app = page.frameLocator("app-window[data-preview-port] iframe");

	await expect(app.locator("button")).toHaveText("ready", { "timeout": 90_000 });
	await runCommand(workbench, "View: Hide Panel");
	await runCommand(workbench, "View: Toggle Primary Side Bar Visibility");
	await runCommand(workbench, "Features and Tests: Show");
	await expect(row("route.spec.mjs")).toContainText("UI spec", { "timeout": 30_000 });
	await row("route.spec.mjs").locator("wa-button[aria-label='Run pwapp/route.spec.mjs']").click();
	// (its time once it's run: then its test, passed)
	await expect(row("route.spec.mjs")).toContainText(/\d+ m?s/u, { "timeout": 120_000 });
	await row("route.spec.mjs").locator(".fv-toggle").click();
	await expect(row("its requests, answered by routes")).toContainText(/\d+ m?s/u);
	await expect(row("its requests, answered by routes")).not.toContainText("fail");
	await expect(app.locator("output")).toHaveText("{\"text\":\"hello\"} | sunny | real | failed");
});
