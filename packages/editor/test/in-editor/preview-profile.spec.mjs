/**
 * Preview CPU profiles (shell/preview-profile.ts, workbench/profile-times.ts, extensions/insights/times.ts), as a person has
 * them: the Profile button in a preview window's title bar samples its page, and each of the app's functions says on the
 * code where the time went, kept with the run: its share and its time at the end of its line, and on hover its time with
 * what it called and who called it. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, previewWindows, READABLE_TERMINAL, runCommand } from "./editor.mjs";

/** An app that spends its time in `spin`, written on line 2 (its served module has a prelude and its types gone). */
const BUSY = `const hold: number = 25;
export function spin(ms: number): number {
	const until = performance.now() + ms;
	let count = 0;

	while (performance.now() < until) {
		count += Math.sqrt(count + 1);
	}

	return count;
}

document.querySelector("#app")!.textContent = "busy";
setInterval(() => {
	spin(hold);
}, 40);
`;

test("a preview window's Profile button keeps where its page's time went with the run, on each function's line", async ({ page }) => {
	const workbench = await openEditor(page, {
		...READABLE_TERMINAL,
		"profapp/index.html": "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
		"profapp/src/main.ts": BUSY
	});
	const { input } = await openTerminal(workbench);

	await input.pressSequentially("cd profapp && vite\n");

	const shown = previewWindows(page);

	await expect(shown.frameLocator("iframe[title^='Preview']").locator("#app")).toHaveText("busy", { "timeout": 90_000 });
	await shown.locator("[aria-label='Profile its page']").click();

	// While it samples, the button says so.
	await expect(shown.locator("[aria-label='Profiling its page']")).toBeVisible();
	await expect(shown.locator("[aria-label='Profile its page']")).toBeVisible({ "timeout": 60_000 });

	// Then on the code: the hover on spin's line says its share of the time, and who called it.
	await openFile(workbench, "profapp/src/main.ts");
	await codeOf(workbench).press("Control+g");

	const go = workbench.locator(".quick-input-widget input").first();

	await go.fill(":2:17");
	await go.press("Enter");
	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 2," })).toBeVisible({ "timeout": 30_000 });

	const hover = workbench.locator(".monaco-hover:not(.hidden)", { "hasText": "of the time profiled" });

	for (let tries = 0; ; tries += 1) {
		await runCommand(workbench, "Show or Focus Hover");

		try {
			await expect(hover.first()).toBeVisible({ "timeout": 5000 });
			break;
		} catch (error) {
			if (tries === 12) {
				const shownHover = await workbench.locator(".monaco-hover:not(.hidden)").allTextContents();

				throw new Error(`the hover didn't say spin's time; it said: ${JSON.stringify(shownHover)}`, { "cause": error });
			}

			await codeOf(workbench).press("Escape");
		}
	}

	await expect(hover.first()).toContainText(/\d+% of the time profiled/u);
	await expect(hover.first()).toContainText("Called by");
});
