/**
 * What your edits change (extensions/history), as a person has it: pause typing and the History output says which features
 * changed, and what runs said of them. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype, runCommand } from "./editor.mjs";

const APP = (more) => `import { hub, serve } from "./hub.mjs";

export function greet() {
	return "hello";
}

export function idle() {
	return "idle";
}

serve(hub, "demo.greet", greet);
serve(hub, "demo.idle", idle);
${more}`;
const files = {
	// (what's told here is what the runs this starts said)
	".vscode/settings.json": "{ \"run.liveRuns\": false }\n",
	"tsconfig.json": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n",
	"hub.mjs": "export const hub = {};\n\nexport function serve(_hub, _name, handler) {\n\treturn handler;\n}\n",
	"app.mjs": APP(""),
	"run-it.mjs": "import { greet } from \"./app.mjs\";\n\nconst said = greet();\n"
};

test("the History output says what a pause changed, and whether runs used it", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "app.mjs");
	await runCommand(workbench, "History: Show What Changed");

	const told = workbench.locator(".panel .view-lines").first();

	await expect(told).toContainText("Reading", { "timeout": 60_000 });

	// Added, as you type.
	await retype(workbench, APP("\nserve(hub, \"demo.other\", () => 1);\n"));
	await expect(told).toContainText("added hub request demo.other", { "timeout": 30_000 });

	// Changed, through what it reaches.
	await retype(workbench, APP("\nserve(hub, \"demo.other\", () => 1);\n").replace("\"hello\"", "\"hi\""));
	await expect(told).toContainText("changed hub request demo.greet", { "timeout": 30_000 });

	// Removed.
	await retype(workbench, APP("").replace("\"hello\"", "\"hi\""));
	await expect(told).toContainText("removed hub request demo.other", { "timeout": 30_000 });

	// A run calls one and not the other: runs say so.
	await openFile(workbench, "run-it.mjs");
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(1, { "timeout": 60_000 });
	await runCommand(workbench, "History: Show What Changed");
	await expect(told).toContainText("Runs say: 1 features exercised, 1 dormant", { "timeout": 30_000 });

	// Another run calls the other: said as it changes.
	await retype(workbench, "import { idle } from \"./app.mjs\";\n\nconst said = idle();\n");
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(2, { "timeout": 60_000 });
	await runCommand(workbench, "History: Show What Changed");
	await expect(told).toContainText("exercised hub request demo.idle", { "timeout": 30_000 });
});
