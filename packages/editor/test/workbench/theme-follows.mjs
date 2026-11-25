/**
 * The theme following the system's, the system's preference emulated, which a page can't for one window of its own
 * (a frame follows the browser's). What a person has of it is in-editor/workbench.spec.mjs's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/theme-follows.mjs
 */
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("theme-follows");

test("the theme follows the system's: VS Code's theme switches, and the shell draws in its colours", async () => {
	const { page } = session;
	const theme = async () => session.workbench().evaluate(() => globalThis.__editor.api.workspace.getConfiguration().get("workbench.colorTheme"));
	const background = async () => page.evaluate(() => document.body.style.getPropertyValue("--vscode-editor-background").trim());
	// (each theme's own colour: the setting changes before its colours reach the shell, so what the shell has just after
	// it may still be the last theme's)
	const inColours = async (scheme, name, colour) => {
		let seen;

		await page.emulateMedia({ "colorScheme": scheme });
		await session.eventually(`the ${scheme} theme`, async () => (await theme() === name ? true : undefined), 30_000);
		await session.eventually(`the shell in ${scheme} colours`, async () => {
			seen = await background();

			return seen.toLowerCase() === colour ? true : undefined;
		}, 30_000).catch((error) => {
			throw new Error(`${error.message}: it has ${JSON.stringify(seen)}, not ${colour}`);
		});
	};

	// (and Web Awesome, in VS Code's own document, on the theme's colours and in its mode)
	const inWorkbench = async (mode, colour) => session.eventually(`Web Awesome in the workbench, ${mode}`, async () => (await session.workbench().evaluate(() => {
		const workbench = document.querySelector(".monaco-workbench");

		return `${[...workbench.classList].filter((name) => name === "wa-dark" || name === "wa-light").join()} ${getComputedStyle(workbench).getPropertyValue("--wa-color-surface-default").trim().toLowerCase()}`;
	}) === `wa-${mode} ${colour}` ? true : undefined), 30_000);

	await inColours("dark", "Default Dark+", "#1e1e1e");
	await inWorkbench("dark", "#1e1e1e");
	await inColours("light", "Default Light+", "#ffffff");
	await inWorkbench("light", "#ffffff");
});
