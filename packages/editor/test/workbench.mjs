/**
 * The editor's own surfaces, in a real editor: the theme following the system's (workbench/theme-follow.ts, the shell's
 * colours from VS Code's), the starter workspace it opens on (build/snapshot.ts), the service worker it runs with on a
 * static host (coi-serviceworker.js), every context reporting on the architecture plane (shared/architecture.ts,
 * the command tap, the stores' reports), an extension loaded by URL (workbench/extensions.ts, `?extension=`), and
 * signing in started from the GitHub button (shell/sign-in.tsx, session.ts) — the API stood in for, so no account is
 * touched. The extension's load is the page's second, the service worker's first to control.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession, URL_UNDER_TEST } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("workbench");
});

/** The development API (shell/session.ts `API`, off the production site). */
const API = "https://editor-api-dev.brianjenkins94.workers.dev";

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

test("a fresh editor opens on the starter workspace, with the editor's settings as its defaults", async () => {
	const { files } = await session.request("files.glob", { "pattern": "**/*.{ts,tsx,json,html}" }, 30_000);

	for (const file of ["package.json", "tsconfig.json", "index.html", "src/App.tsx", "src/main.tsx", "apps/second/src/App.tsx"]) {
		assert.ok(files.includes(file), `${file} in ${JSON.stringify(files)}`);
	}

	const settings = await session.workbench().evaluate(() => {
		const { api } = globalThis.__editor;

		return { "plain": api.workspace.getConfiguration("editor").get("formatOnSave"), "typescript": api.workspace.getConfiguration("editor", { "languageId": "typescript" }).get("formatOnSave") };
	});

	assert.deepEqual(settings, { "plain": false, "typescript": true });
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

test("an extension loaded by URL (`?extension=`) runs in the editor", async () => {
	const { page } = session;
	const url = new URL(page.url());

	url.searchParams.append("extension", new URL("/test/fixtures/url-extension/", url).href);
	await page.goto(url.href);

	const said = await session.eventually("its command", async () => session.workbench().evaluate(async () => globalThis.__editor?.api.commands.executeCommand("urlExtension.hello")).catch(() => undefined), 120_000);

	assert.equal(said, "hello from a URL");
});

test("the service worker serves a package's file from the CDN, same-origin, stamped for isolation", async () => {
	const { page } = session;
	// (controlled from the load after it registered: a dev server isolates the first itself, so it isn't reloaded for it)
	const answer = await page.evaluate(async () => {
		const response = await fetch("/workspace/node_modules/react/package.json?v=18.3.1");

		return { "controlled": navigator.serviceWorker.controller !== null, "status": response.status, "name": (await response.json()).name, "coop": response.headers.get("cross-origin-opener-policy") };
	});

	assert.deepEqual(answer, { "controlled": true, "status": 200, "name": "react", "coop": "same-origin" });
	await session.eventually("the worker's CDN span", async () => (session.printed().some((line) => line.startsWith("[sw]") && line.includes("react@18.3.1/package.json")) ? true : undefined), 30_000);
});

test("signing in starts from the GitHub button: pushed to the API, then off to its sign-in page as the editor", async () => {
	const { page } = session;
	const pushed = [];

	await page.context().route(`${API}/**`, async (route) => {
		const { pathname } = new URL(route.request().url());

		if (pathname === "/auth/par") {
			pushed.push({ "body": new URLSearchParams(route.request().postData() ?? ""), "proof": route.request().headers()["dpop"] });
			await route.fulfill({ "status": 201, "contentType": "application/json", "body": JSON.stringify({ "request_uri": "urn:ietf:params:oauth:request_uri:test", "expires_in": 60 }) });
		} else if (pathname === "/auth/start") {
			await route.fulfill({ "status": 200, "contentType": "text/html", "body": "<!doctype html><title>The API's sign-in</title>" });
		} else {
			await route.fulfill({ "status": 200, "contentType": "application/json", "body": "{}" });
		}
	});

	await page.locator("wa-button[aria-label='GitHub']").click();
	await page.locator("[aria-label='GitHub connection'] wa-button", { "hasText": "Sign in" }).click();
	await page.waitForURL(`${API}/auth/start**`, { "timeout": 30_000 });

	const started = new URL(page.url());

	assert.deepEqual([started.searchParams.get("client_id"), started.searchParams.get("request_uri")], ["editor", "urn:ietf:params:oauth:request_uri:test"]);
	assert.equal(pushed.length, 1);
	// (back to the site's root: the API knows one page per site, and the sign-in brings a deep link back itself)
	assert.deepEqual([pushed[0].body.get("client_id"), pushed[0].body.get("redirect_uri"), pushed[0].body.get("code_challenge_method")], ["editor", new URL("/", URL_UNDER_TEST).href, "S256"]);
	assert.ok(typeof pushed[0].proof === "string" && pushed[0].proof.split(".").length === 3, "a DPoP proof with the request");
});
