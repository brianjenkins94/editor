/**
 * Signing in started from the GitHub button (shell/sign-in.tsx, session.ts), the API stood in for — routed before the
 * page loads — so no account is touched.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/sign-in.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession, URL_UNDER_TEST } from "../architecture-harness.mjs";

/** The development API (shell/session.ts `API`, off the production site). */
const API = "https://editor-api-dev.brianjenkins94.workers.dev";

/** How the API's requests are answered: as they would be, unless a test stands in for it. */
let answerApi = async (route) => route.continue();

// (routed from the start: a route added later waits on every worker the page has had, and one rolldown's slicer ends with
// its threads parked never says it's gone — Playwright's route then waits for ever)
const session = sharedSession("sign-in", { "prepare": async (context) => context.route(`${API}/**`, async (route) => answerApi(route)) });

test("signing in starts from the GitHub button: pushed to the API, then off to its sign-in page as the editor", async () => {
	const { page } = session;
	const pushed = [];

	answerApi = async (route) => {
		const { pathname } = new URL(route.request().url());

		if (pathname === "/auth/par") {
			pushed.push({ "body": new URLSearchParams(route.request().postData() ?? ""), "proof": route.request().headers()["dpop"] });
			await route.fulfill({ "status": 201, "contentType": "application/json", "body": JSON.stringify({ "request_uri": "urn:ietf:params:oauth:request_uri:test", "expires_in": 60 }) });
		} else if (pathname === "/auth/start") {
			await route.fulfill({ "status": 200, "contentType": "text/html", "body": "<!doctype html><title>The API's sign-in</title>" });
		} else {
			await route.fulfill({ "status": 200, "contentType": "application/json", "body": "{}" });
		}
	};

	await page.locator("wa-button[aria-label='GitHub']").click({ "timeout": 30_000 });
	await page.locator("[aria-label='GitHub connection'] wa-button", { "hasText": "Sign in" }).click({ "timeout": 30_000 });
	await page.waitForURL(`${API}/auth/start**`, { "timeout": 30_000 });

	const started = new URL(page.url());

	assert.deepEqual([started.searchParams.get("client_id"), started.searchParams.get("request_uri")], ["editor", "urn:ietf:params:oauth:request_uri:test"]);
	assert.equal(pushed.length, 1);
	// (back to the site's root: the API knows one page per site, and the sign-in brings a deep link back itself)
	assert.deepEqual([pushed[0].body.get("client_id"), pushed[0].body.get("redirect_uri"), pushed[0].body.get("code_challenge_method")], ["editor", new URL("/", URL_UNDER_TEST).href, "S256"]);
	assert.ok(typeof pushed[0].proof === "string" && pushed[0].proof.split(".").length === 3, "a DPoP proof with the request");
});
