/**
 * The admin app (packages/admin) as the owner has it, against the API's local harness (packages/api/harness), GitHub stood
 * in for: signing in, each page's own content, a user's page, the account page (packages/account), and the brand's colours
 * (theme/chrome), which the editor's own pages take from VS Code's theme instead.
 *
 *   node --test test/workbench/admin.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";

const packages = url.fileURLToPath(new URL("../../../", import.meta.url));
const started = [];
let browser;
let page;
const errors = [];

/** A server of the repository's, once it says it's up. */
async function serve(command, args, folder, ready, env = {}) {
	// (a group of its own, so what it starts ends with it)
	const child = spawn(command, args, { "cwd": path.join(packages, folder), "env": { ...process.env, ...env }, "detached": true });
	let said = "";

	started.push(child);
	await new Promise((resolve, reject) => {
		const heard = (chunk) => {
			said += stripVTControlCharacters(String(chunk));

			if (said.includes(ready)) {
				resolve();
			}
		};

		child.stdout.on("data", heard);
		child.stderr.on("data", heard);
		child.on("exit", (code) => { reject(new Error(`${folder}'s server ended (${String(code)}): ${said.slice(-600)}`)); });
		setTimeout(() => { reject(new Error(`${folder}'s server isn't up in 60 s: ${said.slice(-600)}`)); }, 60_000).unref();
	});
}

before(async () => {
	await Promise.all([
		serve("node", ["harness/harness.ts"], "api", "harness at", { "HARNESS_STAND_IN": "1" }),
		serve("npx", ["vite", "--port", "5174", "--strictPort"], "admin", "Local:")
	]);
	browser = await launchChromium();
	page = await (await browser.newContext({ "viewport": { "width": 1300, "height": 900 }, "colorScheme": "light" })).newPage();
	page.on("pageerror", (error) => errors.push(error.message));
}, { "timeout": 120_000 });

after(async () => {
	await browser?.close();

	for (const child of started) {
		child.removeAllListeners("exit");

		try {
			process.kill(-child.pid, "SIGTERM");
		} catch { /* ended already */ }
	}
});

const shown = (text) => page.getByText(text).first().waitFor({ "timeout": 30_000 });
const go = async (address) => page.goto(`http://localhost:5174/${address}`);

test("the owner signs in through the API's own page, with GitHub", async () => {
	await go("");
	await page.locator("wa-button", { "hasText": /^\s*Sign in\s*$/u }).click();
	await page.getByText("Continue with GitHub").click();
	await page.locator("button, a, input[type=submit]").filter({ "hasText": "brianjenkins94" }).first().click();
	await shown("Worth a look, last 24 hours");
});

test("the overview and the users: who's signed up, and one user's sign-ins and audit rows", async () => {
	await go("#/users");
	await page.locator("a[href^='#/users/']").first().click();
	await shown("GitHub user 9398474");
	await shown("Latest audit rows");
	assert.deepEqual(errors, []);
});

test("the architecture: drawn from the code and the API itself", async () => {
	await go("#/architecture");
	await shown("drawn from its code");
	await page.locator("svg, canvas, [class*=arch]").first().waitFor({ "timeout": 30_000 });
	await shown("/auth/par");
	assert.deepEqual(errors, []);
});

test("your account: each way to sign in, and what's off", async () => {
	await go("#/account");

	for (const each of ["GitHub", "Email", "Password", "Passkeys", "Two-factor"]) {
		await shown(each);
	}

	await shown("Ways to sign in");
	assert.deepEqual(errors, []);
});

test("the brand's colours, which Web Awesome's components take", async () => {
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--wa-color-brand-50").trim()), "#3794ff");
});
