/**
 * What of the editor's own surfaces a person doesn't see, and so in-editor/workbench.spec.mjs can't do: the theme following
 * the system's (the system's preference emulated, which a page can't for one window of its own: a frame follows the
 * browser's), every context reporting on the architecture plane (shared/architecture.ts, the command tap, the stores'
 * reports), and signing in started from the GitHub button (shell/sign-in.tsx, session.ts), the API stood in for — routed
 * before the page loads — so no account is touched. What a person has of them is that spec's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession, URL_UNDER_TEST } from "./architecture-harness.mjs";

let session;

/** The development API (shell/session.ts `API`, off the production site). */
const API = "https://editor-api-dev.brianjenkins94.workers.dev";

/** How the API's requests are answered: as they would be, unless a test stands in for it. */
let answerApi = async (route) => route.continue();

before(async () => {
	// (routed from the start: a route added later waits on every worker the page has had, and one rolldown's slicer ends
	// with its threads parked never says it's gone — Playwright's route then waits for ever)
	session = await startSession({ "prepare": async (context) => context.route(`${API}/**`, async (route) => answerApi(route)) });
});

after(async () => {
	await session?.close("workbench");
});

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

	await inColours("dark", "Default Dark+", "#1e1e1e");
	await inColours("light", "Default Light+", "#ffffff");
});

test("every context reports on the architecture plane: the realms, the extensions by their commands, the stores", async () => {
	// (each reports when it's up and has something to say: all of them are waited for, not the first)
	let missing = [];

	await session.eventually("every context's report", async () => {
		const { nodes, channels } = session.seen();

		missing = [
			...["shell", "root", "sw", "workbench", "bridge"].filter((realm) => !nodes.some((node) => node.id === realm && node.state === "alive")),
			...["ext:bridge", "ext:source-control", "ext:history"].filter((extension) => !nodes.some((node) => node.id === extension)),
			...channels.some((channel) => channel.a.startsWith("ext:") && channel.b === "ext:vscode" && channel.count > 0) ? [] : ["an extension's commands"],
			...channels.some((channel) => channel.b.startsWith("store:") || channel.a.startsWith("store:")) ? [] : ["a store's traffic, by its files"]
		];

		return missing.length === 0 ? true : undefined;
	}, 60_000).catch((error) => {
		throw new Error(`${error.message}: no ${missing.join(", no ")}`);
	});
});

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
