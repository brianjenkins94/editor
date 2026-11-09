/**
 * A breakpoint in a page's code (workbench/recorded-stops.ts, previews/page-evidence.ts; RUNNING.md, *Apps: recorded stops,
 * not live ones*), as a person has it: the page can't stop, so each time the line runs, what was in scope is recorded and
 * shown in the Margin, a column per time; and the lightbulb on the line steps a recorded call again in the debugger, its
 * toolbar in the preview window's title bar too (extensions/bridge/debug-toolbar.ts). Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, previewWindows, quickFix, READABLE_TERMINAL } from "./editor.mjs";

const HANDLER = `const button = document.querySelector("button")!;
let clicks = 0;

function onClick(event: MouseEvent): void {
	clicks += 1;
	button.textContent = \`clicked \${String(clicks)}\`;
}

button.textContent = "ready";
button.addEventListener("click", onClick);
`;

/** The cursor to `line`, by Go to Line. */
async function goToLine(workbench, line) {
	await codeOf(workbench).press("Control+g");

	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill(`:${String(line)}`);
	await input.press("Enter");
	await expect(workbench.locator(".statusbar-item", { "hasText": `Ln ${String(line)},` })).toBeVisible({ "timeout": 30_000 });
}

test("a breakpoint in a page's code records what's in scope each time its line runs, and a recorded call steps again", async ({ page }) => {
	const workbench = await openEditor(page, {
		...READABLE_TERMINAL,
		"stopsapp/index.html": "<!doctype html><html><body><button type=\"button\">not yet</button><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
		"stopsapp/src/main.ts": HANDLER
	});

	await openFile(workbench, "stopsapp/src/main.ts");
	await goToLine(workbench, 5);
	await codeOf(workbench).press("F9");

	const { input } = await openTerminal(workbench);

	await input.pressSequentially("cd stopsapp && vite\n");

	const app = previewWindows(page).frameLocator("iframe[title^='Preview']").locator("button");

	await expect(app).toHaveText("ready", { "timeout": 90_000 });

	// The dev server's own session drives the window: its Restart is in the window's title bar, and nothing to step.
	const titleBar = (label) => previewWindows(page).locator(`[aria-label='${label}']`);

	await expect(titleBar("Restart")).toBeVisible({ "timeout": 30_000 });
	await expect(titleBar("Step Over")).toHaveCount(0);
	await app.click();
	await expect(app).toHaveText("clicked 1");
	await app.click();
	await expect(app).toHaveText("clicked 2");

	// A column each time the line ran: what it was handling, and what was in scope as it was then.
	const cells = workbench.locator(".live-values-row", { "hasText": "clicks =" }).locator(".live-values-cell.turn");

	await expect(cells).toHaveCount(2, { "timeout": 30_000 });
	await expect(cells.nth(0)).toContainText("clicks = 0");
	await expect(cells.nth(1)).toContainText("clicks = 1");
	await expect(cells.nth(1)).toContainText("during = click");

	// The second click's call, again, in the debugger: stopped at the stop, on what it read then.
	await openFile(workbench, "stopsapp/src/main.ts");
	await goToLine(workbench, 5);
	await quickFix(workbench, "Step the call this stop recorded");
	await expect(workbench.getByText("Paused On Breakpoint")).toBeVisible({ "timeout": 60_000 });
	await expect(workbench.getByText(/onClick · click #2 \(recorded\)/u).first()).toBeVisible();

	// Its toolbar in the page's window too, stepping the same session: from the stop's line to the next.
	const frame = workbench.locator(".debug-call-stack .monaco-list-row[aria-label^='Stack Frame onClick']").first();

	// (a session's frames show once it's opened in Call Stack: it may come closed)
	await workbench.locator(".debug-call-stack .monaco-list-row[aria-label*='(recorded)'][aria-expanded='false'] .monaco-tl-twistie").click({ "timeout": 5000 }).catch(() => undefined);

	try {
		await expect(frame).toContainText(/5:\d/u, { "timeout": 30_000 });
	} catch (error) {
		// (what Call Stack showed instead)
		const rows = workbench.locator(".debug-call-stack .monaco-list-row");
		const shown = [];

		for (let index = 0; index < Math.min(await rows.count(), 8); index += 1) {
			shown.push(`${String(await rows.nth(index).getAttribute("aria-label"))} (expanded: ${String(await rows.nth(index).getAttribute("aria-expanded"))})`);
		}

		throw new Error(`${String(error)}; Call Stack showed ${JSON.stringify(shown)}`, { "cause": error });
	}
	await expect(titleBar("Step Over")).toBeEnabled();
	await titleBar("Step Over").click();
	await expect(frame).toContainText(/6:\d/u, { "timeout": 30_000 });
});
