/**
 * What a test running in the editor uses to open one: an instance of its own, in a preview window (shared/instance.ts),
 * holding only the files it's given, and the way a person gets around it.
 */
import { expect } from "@playwright/test";

let instances = 0;

/** An editor of its own, holding `files` (each path from its workspace's root, with its text): its workbench, once it's up. `extension`: one from outside the editor, by its address. */
export async function openEditor(page, files, { extension } = {}) {
	instances += 1;

	const seed = encodeURIComponent(Buffer.from(JSON.stringify(files)).toString("base64"));

	await page.goto(`?instance=test-${String(Date.now())}-${String(instances)}&seed=${seed}${extension === undefined ? "" : `&extension=${encodeURIComponent(extension)}`}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });

	return workbench;
}

/** A command, from the palette, as a person runs one. */
export async function runCommand(workbench, title) {
	await workbench.locator(".monaco-workbench").first().press("F1");

	const input = workbench.locator(".quick-input-widget input[type='text'], .quick-input-widget input:not([type])").first();

	await input.fill(`>${title}`);
	await expect(workbench.locator(".quick-input-list .monaco-list-row.focused", { "hasText": title }).first()).toBeVisible({ "timeout": 15_000 });
	await input.press("Enter");
}

/** A file from the Explorer, by its path: each folder opened on the way, as a person goes. */
export async function openFile(workbench, path) {
	const parts = path.split("/");

	for (const [at, name] of parts.entries()) {
		const row = workbench.getByRole("treeitem", { "name": name, "exact": true });

		await expect(row).toBeVisible({ "timeout": 30_000 });

		if (at === parts.length - 1) {
			// (twice, to keep it: a click's tab is a preview, which the next file opened takes the place of)
			await row.dblclick();
		} else if (await row.getAttribute("aria-expanded") === "false") {
			await row.click();
		}
	}

	await expect(workbench.locator(".tab.active", { "hasText": parts.at(-1) })).toBeVisible({ "timeout": 30_000 });
}

/** The Problems panel, opened: its rows, each file's and each problem's. */
export async function problems(workbench) {
	await runCommand(workbench, "View: Focus Problems");
	await expect(workbench.locator(".markers-panel")).toBeVisible({ "timeout": 30_000 });

	return workbench.locator(".markers-panel .monaco-list-row");
}

/** Where a person's typing goes in the open file. */
export const codeOf = (workbench) => workbench.locator(".editor-instance .native-edit-context").first();

/** What a workspace is seeded with for a test to read its terminal: drawn as DOM rows, as this setting has it, not on a canvas. */
export const READABLE_TERMINAL = { ".vscode/settings.json": "{ \"terminal.integrated.gpuAcceleration\": \"off\" }\n" };

/** A new terminal, at its prompt: where its keys go, and what it shows (READABLE_TERMINAL). */
export async function openTerminal(workbench) {
	await runCommand(workbench, "Terminal: Create New Terminal");

	const output = workbench.locator(".xterm-rows").last();

	await expect(output).toContainText("/workspace $", { "timeout": 30_000 });

	return { "input": workbench.locator(".xterm-helper-textarea").last(), "output": output };
}

/** The open file's text replaced, as a person does it, and saved. */
export async function retype(workbench, text) {
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).pressSequentially(text);
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });
}

/** A page of a dev server: it puts `said` in `#app`, in TypeScript, so running at all says it was compiled. */
export const devApp = (folder, said) => ({
	...READABLE_TERMINAL,
	[`${folder}/index.html`]: "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
	[`${folder}/src/main.ts`]: `const said: string = ${JSON.stringify(said)};\n\ndocument.querySelector("#app")!.textContent = said;\n`
});

/** What a dev server's window is: as many as are open. */
export const previewWindows = (page) => page.locator("app-window[data-preview-port]");
