/**
 * What a way in reaches (extensions/history/reach.ts), as a person asks it: on a way in's registration, the lightbulb's
 * “What … reaches”: a quick pick of the feature owning it, what only it reaches, and every place naming it, each opening it.
 * Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, quickFix } from "./editor.mjs";

const files = {
	".vscode/settings.json": "{ \"run.liveRuns\": false }\n",
	".silo/features.json": `${JSON.stringify({
		"Greeting": {
			"status": "active",
			"why": "says hello",
			"since": "2026-11-07",
			"what": "Says hello.",
			"ways": ["hub request|demo.greet"],
			"paths": ["app.mjs"]
		}
	}, undefined, "\t")}\n`,
	"tsconfig.json": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n",
	"hub.mjs": "export const hub = {};\n\nexport function serve(_hub, _name, handler) {\n\treturn handler;\n}\n",
	"app.mjs": "import { hub, serve } from \"./hub.mjs\";\n\nfunction greet() {\n\treturn \"hello\";\n}\n\nserve(hub, \"demo.greet\", greet);\n",
	"caller.mjs": "export const asks = \"demo.greet\";\n",
	"test/app.test.mjs": "export const asked = \"demo.greet\";\n",
	"README.md": "# Demo\n\n`demo.greet` says hello.\n"
};

test("on a way in's registration, the lightbulb shows what it reaches, and a place picked opens", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const pick = workbench.locator(".quick-input-widget");
	const row = (text) => pick.locator(".monaco-list-row", { "hasText": text });

	await openFile(workbench, "app.mjs");
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).press("ArrowLeft");

	for (let line = 1; line < 7; line += 1) {
		await codeOf(workbench).press("ArrowDown");
	}

	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 7" })).toBeVisible({ "timeout": 30_000 });
	// (the lightbulb's there once History has read the program)
	await quickFix(workbench, "What hub request demo.greet reaches");
	await expect(pick.locator(".quick-input-title")).toContainText("hub request demo.greet: Greeting", { "timeout": 30_000 });
	await expect(pick.locator("input").first()).toHaveAttribute("placeholder", /^Only it reaches [1-9]\d* declarations?, /u);

	for (const each of [
		"Registered (1)",
		"Code naming it (1)",
		"Tests naming it (1)",
		"Docs naming it (1)",
		"caller.mjs:1",
		"test/app.test.mjs:1",
		"README.md:3"
	]) {
		await expect(row(each).first()).toBeVisible({ "timeout": 30_000 });
	}

	// A place picked opens.
	await row("caller.mjs:1").first().click();
	await expect(pick).toBeHidden({ "timeout": 30_000 });
	await expect(workbench.locator(".tab.active", { "hasText": "caller.mjs" })).toBeVisible({ "timeout": 30_000 });
});
