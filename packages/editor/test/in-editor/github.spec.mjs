/**
 * The editor with GitHub, signed in, as a person has it (shell/sign-in.tsx, session.ts, repo-load.tsx, git-clone.ts,
 * git-push.ts; the workbench's git-push.ts and the terminal's git): signing in from the GitHub button — the request pushed
 * to the API, its start page, back signed in — a repository loaded, cloned through the API, the offer to fast-forward once
 * GitHub has moved ahead, caught up, and a commit pushed back by who's signed in. The API and its GitHub are the test's own
 * (api-stand-in.mjs), routed (page.route) for an editor whose API is its origin's /__test-api: nothing real is touched.
 * Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { apiStandIn, TEST_API } from "./api-stand-in.mjs";
import { openEditor, openFile, openTerminal, READABLE_TERMINAL, retype } from "./editor.mjs";

test("signed in from the GitHub button, a repository loads, catches up with GitHub, and takes a push", async ({ page }) => {
	const api = apiStandIn({ "repositories": { "ann/app": { "files": { "README.md": "# app\n", "src/index.ts": "export const answer = 42;\n" }, "message": "First" } } });

	await page.route(`**${TEST_API}/**`, api.handle);

	const workbench = await openEditor(page, READABLE_TERMINAL, { "api": TEST_API });
	const connection = page.locator("[aria-label='GitHub connection']");
	const github = page.locator("wa-button[aria-label='GitHub']");

	// Signing in: the request pushed to the API with a proof of the key, its start page, and back, signed in.
	await github.click({ "timeout": 30_000 });
	await connection.locator("wa-button", { "hasText": "Sign in" }).click({ "timeout": 30_000 });
	await expect(connection).toContainText("Signed in as ann", { "timeout": 60_000 });

	const origin = new URL(await page.url()).origin;

	expect([api.seen.pushed.get("client_id"), api.seen.pushed.get("redirect_uri"), api.seen.pushed.get("code_challenge_method")]).toEqual(["editor", `${origin}/`, "S256"]);
	expect(api.seen.proof.split(".").length).toBe(3);
	expect([api.seen.started.get("client_id"), api.seen.started.get("request_uri")]).toEqual(["editor", "urn:ietf:params:oauth:request_uri:stand-in"]);

	// A repository, loaded: cloned through the API's git.
	// (the panel again: back from signing in, the page is a new one; its one input, owner/repo)
	if (!await connection.isVisible()) {
		await github.click();
	}

	await connection.locator("wa-input input").fill("ann/app", { "timeout": 30_000 });
	await connection.locator("wa-button", { "hasText": "Load" }).click();
	await expect(workbench.getByRole("treeitem", { "name": "README.md", "exact": true })).toBeVisible({ "timeout": 120_000 });
	expect(api.asked.some((call) => call.startsWith("POST /github/git/ann/app.git/git-upload-pack"))).toBe(true);

	// GitHub moves ahead: the next load offers to fast-forward, and catching up brings its commit in.
	api.repository("ann/app").commit({ "CHANGELOG.md": "- Second\n" }, "Second");
	await page.goto(await page.url());
	await expect(connection).toContainText("GitHub's main has 1 commit this workspace doesn't.", { "timeout": 120_000 });
	await connection.locator("wa-button[aria-label='Fast-forward']").click();
	await expect(connection).toContainText("Caught up with GitHub (1 files).", { "timeout": 120_000 });
	await expect(workbench.getByRole("treeitem", { "name": "CHANGELOG.md", "exact": true })).toBeVisible({ "timeout": 60_000 });

	// A change, committed and pushed from the terminal: GitHub has it, by who's signed in.
	await openFile(workbench, "src/index.ts");
	await retype(workbench, "export const answer = 43;\n");

	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially("git commit -a -m \"Ask again\"\n");
	await expect(terminal.output).toContainText("1 file changed", { "timeout": 60_000 });
	await terminal.input.pressSequentially("git push\n");
	await expect(terminal.output).toContainText("main -> main", { "timeout": 120_000 });

	const tip = api.repository("ann/app").tip();

	expect([tip.message, tip.author.split(" ").slice(0, 2).join(" "), tip.files["src/index.ts"]]).toEqual(["Ask again", "ann <4242+ann@users.noreply.github.com>", "export const answer = 43;\n"]);
});
