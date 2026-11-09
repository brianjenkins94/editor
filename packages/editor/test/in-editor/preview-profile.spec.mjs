/**
 * Preview CPU profiles (shell/preview-profile.ts, workbench/profile-files.ts, extensions/insights/profiles.ts), as a person
 * has them: the Profile button in a preview window's title bar samples its page, and lists where its time went, the app's
 * own functions at the lines they're written on, one picked opening there. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openTerminal, previewWindows, READABLE_TERMINAL } from "./editor.mjs";

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

test("a preview window's Profile button lists where its page's time went, at the lines written, and a pick opens there", async ({ page }) => {
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

	// While it samples, the button says so; then the app's functions, the busiest first, where they're written.
	await expect(shown.locator("[aria-label='Profiling its page']")).toBeVisible();

	const picker = workbench.locator(".quick-input-widget");

	await expect(picker.locator(".quick-input-title")).toHaveText("Where the preview on :5173's time went", { "timeout": 60_000 });

	const busiest = picker.locator(".quick-input-list .monaco-list-row").first();

	await expect(busiest).toContainText("spin");
	await expect(busiest).toContainText("profapp/src/main.ts:2");

	await picker.locator("input").first().press("Enter");
	await expect(workbench.locator(".tab.active")).toContainText("main.ts", { "timeout": 30_000 });
	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 2," })).toBeVisible();
});
