/**
 * What a test running in the editor uses to open one: an instance of its own, in a preview window (shared/instance.ts),
 * holding only the files it's given, and the way a person gets around it.
 */
import { expect } from "@playwright/test";

/** An editor of its own, holding `files` (each path from its workspace's root, with its text): its workbench, once it's up. `extension`: one from outside the editor, by its address. */
export async function openEditor(page, files, { extension, api } = {}) {
	const seed = encodeURIComponent(Buffer.from(JSON.stringify(files)).toString("base64"));

	// (`api`: its API's address, the test's own — api-stand-in.mjs — for one on localhost)
	await page.goto(`?instance=test-${crypto.randomUUID()}&seed=${seed}${extension === undefined ? "" : `&extension=${encodeURIComponent(extension)}`}${api === undefined ? "" : `&api=${encodeURIComponent(api)}`}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });

	return workbench;
}

/** A command, from the palette, as a person runs one. The palette closes when its window loses focus, as it does to another
 *  spec's editor in the same page (test/in-editor.mjs runs two at once), and an Enter then runs nothing: so it's opened
 *  again until Enter goes to it. */
export async function runCommand(workbench, title) {
	const input = workbench.locator(".quick-input-widget input[type='text'], .quick-input-widget input:not([type])").first();

	for (let tries = 1; tries <= 3; tries += 1) {
		await workbench.locator(".monaco-workbench").first().press("F1");
		await input.fill(`>${title}`);
		await expect(workbench.locator(".quick-input-list .monaco-list-row.focused", { "hasText": title }).first()).toBeVisible({ "timeout": 15_000 });

		const focused = await expect(input).toBeFocused({ "timeout": 1000 }).then(() => true, (error) => {
			if (tries === 3) {
				throw error;
			}

			return false;
		});

		if (focused) {
			await input.press("Enter");

			return;
		}
	}
}

/** A file from the Explorer, by its path: each folder opened on the way, as a person goes. */
export async function openFile(workbench, path) {
	const parts = path.split("/");

	for (const [at, name] of parts.entries()) {
		// (at its depth: a name can be at more than one — a commit opened beside the work has the workspace's)
		const row = workbench.locator(`[role='treeitem'][aria-level='${String(at + 1)}'][aria-label='${name}']`);

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

/** Quick Fix where the cursor is, and the action of it called `title`. Asked again until it's offered, as a person would: what
 *  offers it may not be up yet. By its key: the palette has no Quick Fix until something offers code actions. */
export async function quickFix(workbench, title) {
	const code = workbench.locator(".editor-instance .native-edit-context").first();
	const row = workbench.locator(".action-widget .monaco-list-row", { "hasText": title });

	await expect(code).toBeFocused({ "timeout": 30_000 });

	for (let tries = 0; ; tries += 1) {
		await code.press("ControlOrMeta+.");

		try {
			await expect(row).toBeVisible({ "timeout": 5000 });
			break;
		} catch (error) {
			if (tries === 12) {
				throw error;
			}

			await code.press("Escape");
		}
	}

	await row.click({ "timeout": 30_000 });
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

/** A new terminal, at its prompt: where its keys go, and what it shows (READABLE_TERMINAL). Asked for again if none has come
 *  in 15 s: twice on CI (1b36c848, 4e9ae421) none came in preview-profile.spec, beside preview-devtools.spec opening one of
 *  its own at the same time, in the same page, which can take the focus from the palette between `runCommand`'s look and
 *  its Enter. (Not by its keys, Ctrl+Shift+`: with a file open, in preview-session.spec, that brought none.) */
export async function openTerminal(workbench) {
	const rows = workbench.locator(".xterm-rows");
	const before = await rows.count();

	await runCommand(workbench, "Terminal: Create New Terminal");

	// More, not one more: a panel shown with none in it may come with one of its own.
	const came = await expect(rows.nth(before)).toBeAttached({ "timeout": 15_000 }).then(() => true, () => false);

	if (!came) {
		await runCommand(workbench, "Terminal: Create New Terminal");
	}

	const output = rows.last();

	await expect(output).toContainText("/workspace $", { "timeout": 30_000 });

	return { "input": workbench.locator(".xterm-helper-textarea").last(), "output": output };
}

/** `target` hovered until `shown` shows: when it doesn't, the pointer goes to `away` and back, as a person's does. One
 *  hover, once, didn't come — cosmetic.spec's on CI (ef97772b), pane-views.spec's in a full run here (2026-11-19). The
 *  pause at `away`: a hover that's open stays as the pointer moves on. */
export async function hoverUntil(page, { target, shown, away, tries = 10, each = 3000 }) {
	for (let tried = 1; ; tried += 1) {
		await away.hover();
		await page.waitForTimeout(500);
		await target.hover();

		const came = await expect(shown).toBeVisible({ "timeout": each }).then(() => true, (error) => {
			if (tried === tries) {
				throw error;
			}

			return false;
		});

		if (came) {
			return;
		}
	}
}

/** Until `read` (a locator's top, say) is past `than`: what's drawn beside the code moves once BABLR has read the edit, in its own time. */
export async function moved(page, read, than, timeout = 30_000) {
	const until = Date.now() + timeout;

	while (await read() <= than) {
		if (Date.now() > until) {
			throw new Error(`it stayed at ${String(than)}`);
		}

		await page.waitForTimeout(200);
	}
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

/** The changes panel (shell/git-panel.tsx), shown: what's changed since the last commit, a row a file. */
export async function changesPanel(page) {
	if (!await page.locator(".gp").isVisible()) {
		await page.locator("wa-button[aria-label='Toggle changes panel']").click();
	}

	// (a checkbox clicked where a person does, its box; whether it's checked, its input's)
	return { "row": (name) => page.locator(".gp-file", { "hasText": name }), "all": page.locator("wa-checkbox[aria-label='Select all changes']"), "allChecked": page.locator("wa-checkbox[aria-label='Select all changes'] input") };
}

/** Every change committed from the changes panel, with `message`: the panel empty once it's made. */
export async function commitAll(page, message) {
	const { allChecked } = await changesPanel(page);

	await expect(page.locator(".gp-file").first()).toBeVisible({ "timeout": 60_000 });
	await expect(allChecked).toBeChecked();
	await page.locator(".gp-commit wa-textarea textarea").fill(message);
	await page.locator(".gp-commit wa-button").click();
	await expect(page.locator(".gp-file")).toHaveCount(0, { "timeout": 60_000 });
}

/** The workspace's commits, newest first, one a line, as `git log --oneline` in a new terminal shows them (READABLE_TERMINAL). */
export async function gitLog(workbench) {
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("git log --oneline\n");

	return output;
}
