/**
 * Packages and types from the CDN (workbench/node-modules-provider.ts, ata.ts), as a person has them: an import of a
 * package the project depends on type-checks with nothing installed, at the version package.json pins — its types are
 * what TypeScript reads, so a mistake against them is a problem. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, problems } from "./editor.mjs";

test("an import of a dependency type-checks against its own types, nothing installed", async ({ page }) => {
	const workbench = await openEditor(page, {
		"package.json": "{\n  \"type\": \"module\",\n  \"dependencies\": {\n    \"nanoid\": \"5.0.9\"\n  }\n}\n",
		"tsconfig.json": "{ \"compilerOptions\": { \"module\": \"esnext\", \"moduleResolution\": \"bundler\", \"target\": \"esnext\", \"strict\": true } }\n",
		"src/id.ts": "import { nanoid } from \"nanoid\";\n\nexport const id: number = nanoid();\nexport const sized: string = nanoid(10);\n"
	});

	await openFile(workbench, "src/id.ts");

	const rows = await problems(workbench);

	// (its types read: nanoid() is a string, so the first is a problem and the second isn't; unread, neither would be)
	await expect(rows.filter({ "hasText": "Type 'string' is not assignable to type 'number'" })).toHaveCount(1, { "timeout": 180_000 });
	await expect(rows.filter({ "hasText": "Cannot find module 'nanoid'" })).toHaveCount(0);
	await expect(rows.filter({ "hasText": "is not assignable" })).toHaveCount(1);
});
