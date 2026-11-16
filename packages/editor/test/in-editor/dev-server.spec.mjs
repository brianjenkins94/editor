/**
 * The in-browser dev server (workers/node-worker.ts, the terminal's `vite`), as a person has it: a project served from the
 * terminal, its page running isolated as the editor's own is, a save reaching it, another refused, and stopping it. And
 * what a client hears from it (the test's own requests, `request`, made by the shell as any client of it is): its
 * TypeScript compiled, nobody there once it stops, and nobody on a port nothing served. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows, retype } from "./editor.mjs";

test("vite serves a project: its page runs, a save reaches it, another is refused, and it stops", async ({ page, request }) => {
	const workbench = await openEditor(page, { ...devApp("devapp", "from TypeScript"), "devapp/index.html": "<!doctype html><html><body><div id=\"app\"></div><div id=\"isolated\"></div><script type=\"module\" src=\"/src/isolated.ts\"></script><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n", "devapp/src/isolated.ts": "document.querySelector(\"#isolated\")!.textContent = crossOriginIsolated ? \"isolated\" : \"not isolated\";\n" });

	await openFile(workbench, "devapp/src/main.ts");

	const first = await openTerminal(workbench);

	await first.input.pressSequentially("cd devapp && vite\n");
	await expect(first.output).toContainText(/Local:\s+\S+__virtual__\/\S+\/5173\//u, { "timeout": 90_000 });

	const [, address] = /Local:\s+(\S+__virtual__\/\S+\/5173\/)/u.exec(await first.output.textContent());
	const app = page.frameLocator("app-window[data-preview-port] iframe").locator("#app");

	await expect(app).toHaveText("from TypeScript", { "timeout": 60_000 });
	// (SharedArrayBuffer and the rest: an app's page isolated as the editor's own is)
	await expect(page.frameLocator("app-window[data-preview-port] iframe").locator("#isolated")).toHaveText("isolated");

	// Its TypeScript, as a client gets it: compiled.
	const module = await request.get(new URL("src/main.ts", address).href);

	expect(module.status()).toBe(200);
	expect(await module.text()).not.toContain(": string");

	// A save: the terminal says so, and the page has it.
	await retype(workbench, "document.querySelector(\"#app\")!.textContent = \"saved since\";");
	await expect(first.output).toContainText(/\[vite\] (?:hmr update|page reload)/u, { "timeout": 30_000 });
	await expect(app).toHaveText("saved since", { "timeout": 30_000 });

	// Another in the same folder is refused, and says where the first is.
	const second = await openTerminal(workbench);

	await second.input.pressSequentially("cd devapp && vite\n");
	await expect(second.output).toContainText("devapp is already being served on :5173", { "timeout": 30_000 });

	// Stopped, its window goes.
	await second.input.pressSequentially("ps\n");

	const row = second.output.locator("div", { "hasText": /running\s+service\s+5173/u });

	await expect(row).toBeVisible({ "timeout": 15_000 });

	const [run] = (await row.textContent()).trim().split(/\s+/u);

	await second.input.pressSequentially(`kill ${run}\n`);
	await expect(previewWindows(page)).toHaveCount(0, { "timeout": 30_000 });

	// Nobody there now, as a client hears it; nor on a port nothing ever served — said, not hung.
	const gone = await request.get(address);

	expect([gone.status(), await gone.text()]).toEqual([503, "No server listening on port 5173"]);
	expect((await request.get(new URL("../9/", address).href)).ok()).toBe(false);
});
