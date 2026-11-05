/**
 * Capability findings (extensions/capabilities), as a person has them: a call that reaches the outside is marked in the code
 * and listed in Problems, saying what it reaches, as written or as a background run found it. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, problems, retype } from "./editor.mjs";

const PROGRAM = `import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const name = "report";

execSync("ls");
writeFileSync(\`/workspace/\${name}.txt\`, "written");
`;

test("a call that reaches outside says so in Problems: a literal's resource at once, a computed one from a run, and gone with its code", async ({ page }) => {
	const workbench = await openEditor(page, { "calls.mjs": PROGRAM });

	await openFile(workbench, "calls.mjs");

	const rows = await problems(workbench);
	const row = (text) => rows.filter({ "hasText": text });

	await expect(row("exec: execSync → ls")).toHaveCount(1, { "timeout": 90_000 });
	await expect(row("fs:write: writeFileSync → /workspace/report.txt (ran)")).toHaveCount(1, { "timeout": 60_000 });

	// The run that found that made nothing: it's sandboxed.
	await expect(workbench.locator(".explorer-folders-view .monaco-list-row", { "hasText": "report.txt" })).toHaveCount(0);

	await retype(workbench, "const name = \"report\";\n");
	await expect(row("exec: execSync")).toHaveCount(0, { "timeout": 30_000 });
	await expect(row("writeFileSync")).toHaveCount(0, { "timeout": 30_000 });
});
