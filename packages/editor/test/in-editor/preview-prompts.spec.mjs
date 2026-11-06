/**
 * Capability prompts for previews, as a person has them: an app reaching outside that the policy hasn't decided is asked about in
 * its window; the answer holds until the server stops, or always as a rule; a socket is asked about too. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows } from "./editor.mjs";

const OUTSIDE = "https://unpkg.com/lodash@4.17.21/package.json";

const reaches = `const app = document.querySelector("#app")!;

fetch(${JSON.stringify(OUTSIDE)}).then(async (response) => response.json()).then(({ name }) => {
	app.textContent = "got " + name;
}, () => {
	app.textContent = "refused";
});
`;

const opensSocket = `const app = document.querySelector("#app")!;
const socket = new WebSocket("wss://socket.example.invalid/");

socket.onerror = () => {
	app.textContent = "socket refused";
};
`;

async function serve(page, workbench, folder) {
	await openFile(workbench, `${folder}/src/main.ts`);

	const { input } = await openTerminal(workbench);

	await input.pressSequentially(`cd ${folder} && vite\n`);

	const shown = previewWindows(page);

	return {
		"shown": shown,
		"app": shown.first().frameLocator("iframe").locator("#app"),
		"question": shown.first().locator("wa-callout"),
		"answer": (label) => shown.first().locator("wa-callout wa-button", { "hasText": new RegExp(`^\\s*${label}\\s*$`, "u") }).click({ "timeout": 30_000 })
	};
}

test("an outside fetch is asked about in the window: denied it's refused, and the answer holds until the server stops", async ({ page }) => {
	const workbench = await openEditor(page, { ...devApp("gated", "not yet"), "gated/src/main.ts": reaches });
	const { shown, app, question, answer } = await serve(page, workbench, "gated");

	await expect(question).toContainText(`reach ${OUTSIDE}`, { "timeout": 90_000 });
	await answer("Deny");
	await expect(app).toHaveText("refused", { "timeout": 30_000 });
	await expect(question).toHaveCount(0);

	// Another window onto it, asked nothing again.
	await shown.locator("[title='Another window onto this server']").first().click();
	await expect(shown.nth(1).frameLocator("iframe").locator("#app")).toHaveText("refused", { "timeout": 60_000 });
	await expect(shown.locator("wa-callout")).toHaveCount(0);
});

test("always allow is a rule: made, and said in the policy file", async ({ page }) => {
	const workbench = await openEditor(page, { ...devApp("kept", "not yet"), "kept/src/main.ts": reaches });
	const { app, question, answer } = await serve(page, workbench, "kept");

	await expect(question).toContainText("reach", { "timeout": 90_000 });
	await answer("Always allow");
	await expect(app).toHaveText("got lodash", { "timeout": 60_000 });
	await expect(workbench.getByRole("treeitem", { "name": ".silo", "exact": true })).toBeVisible({ "timeout": 30_000 });
});

test("a WebSocket is asked about before it opens", async ({ page }) => {
	const workbench = await openEditor(page, { ...devApp("socket", "not yet"), "socket/src/main.ts": opensSocket });
	const { app, question, answer } = await serve(page, workbench, "socket");

	await expect(question).toContainText("open a WebSocket to wss://socket.example.invalid/", { "timeout": 90_000 });
	await answer("Deny");
	await expect(app).toHaveText("socket refused", { "timeout": 30_000 });
});
