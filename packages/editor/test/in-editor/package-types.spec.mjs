/**
 * Packages and types from the CDN (workbench/node-modules-provider.ts, ata.ts), as a person has them: an import of a
 * package the project depends on type-checks with nothing installed, at the version package.json pins — its types are
 * what TypeScript reads, so a mistake against them is a problem; and one in the project's own folder (`file:`), linked
 * into node_modules (workbench/install.ts) for a run to import. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, problems, runCommand } from "./editor.mjs";

test("an import of a dependency type-checks against its own types, nothing installed", async ({ page }) => {
	const workbench = await openEditor(page, {
		"package.json": "{\n  \"type\": \"module\",\n  \"dependencies\": {\n    \"nanoid\": \"5.0.9\"\n  }\n}\n",
		"tsconfig.json": "{ \"compilerOptions\": { \"module\": \"esnext\", \"moduleResolution\": \"bundler\", \"target\": \"esnext\", \"strict\": true, \"types\": [\"nanoid\"] } }\n",
		"src/id.ts": "import { nanoid } from \"nanoid\";\n\nexport const id: number = nanoid();\nexport const sized: string = nanoid(10);\n"
	});

	await openFile(workbench, "src/id.ts");

	const rows = await problems(workbench);

	// (its types read: nanoid() is a string, so the first is a problem and the second isn't; unread, neither would be)
	await expect(rows.filter({ "hasText": "Type 'string' is not assignable to type 'number'" })).toHaveCount(1, { "timeout": 180_000 });
	await expect(rows.filter({ "hasText": "Cannot find module 'nanoid'" })).toHaveCount(0);
	await expect(rows.filter({ "hasText": "is not assignable" })).toHaveCount(1);
	// (nor does its tsconfig, which names the package's types, miss them)
	await expect(rows.filter({ "hasText": "Cannot find type definition file" })).toHaveCount(0, { "timeout": 60_000 });
});

test("a dependency in the project's own folder (file:) is linked into node_modules, and a run imports it", async ({ page }) => {
	const workbench = await openEditor(page, {
		// (F5's runs only: no live runs)
		".vscode/settings.json": "{ \"run.liveRuns\": false, \"terminal.integrated.gpuAcceleration\": \"off\" }\n",
		"package.json": "{\n  \"type\": \"module\",\n  \"dependencies\": {\n    \"greeter\": \"file:./packages/greeter\"\n  }\n}\n",
		"packages/greeter/package.json": "{ \"name\": \"greeter\", \"version\": \"1.2.3\", \"type\": \"module\", \"main\": \"index.js\" }\n",
		"packages/greeter/index.js": "export const greet = (name) => \"hello \" + name;\n",
		"main.mjs": "import { greet } from \"greeter\";\n\nconsole.log(greet(\"linked\"));\n"
	});

	await openFile(workbench, "main.mjs");
	await codeOf(workbench).press("F5");
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(workbench.locator(".repl .output", { "hasText": "hello linked" }).first()).toBeVisible({ "timeout": 120_000 });

	// (where node would look for it: node_modules/greeter, its package.json the folder's)
	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially("cat node_modules/greeter/package.json\n");
	await expect(terminal.output).toContainText("\"version\": \"1.2.3\"", { "timeout": 30_000 });
});
