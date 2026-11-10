/**
 * Type Queries (extensions/type-queries/extension.ts), as a person has them: `// ^?` under an expression says its type at
 * the end of the comment, as the TypeScript Playground does, and says it again when another file changes it. Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, retype } from "./editor.mjs";

const LOADED = { "timeout": 90_000 };

test("a query says the type of what its caret points at, and again when another file changes it", async ({ page }) => {
	const workbench = await openEditor(page, {
		"lib.ts": "export const greet = (name: string) => \"Hello, \" + name;\n",
		"main.ts": "import { greet } from \"./lib\";\n\nconst message = greet(\"world\");\n//    ^?\n"
	});
	const code = workbench.locator(".editor-instance .view-lines").first();

	await openFile(workbench, "main.ts");
	await expect(code).toContainText("const message: string", LOADED);

	// The function it calls, changed in its own file: the query's answer follows.
	await openFile(workbench, "lib.ts");
	await retype(workbench, "export const greet = (name: string) => name.length;\n");
	await openFile(workbench, "main.ts");
	await expect(code).toContainText("const message: number", LOADED);
});
