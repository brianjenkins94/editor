/**
 * The editor with GitHub, signed in (shell/repo-load.tsx, git-clone.ts, git-push.ts, github.ts, session.ts; the
 * workbench's git-push.ts): a repository loaded from its address, the offer to fast-forward once GitHub has moved ahead,
 * caught up, and a commit pushed back. GitHub is the API harness's stand-in (packages/api/harness/github.ts) serving a
 * bare repository made here; the API is stood in for at the browser's routes — its sign-in, and its proxy, which hands
 * /github/api and /github/git to GitHub as they came, with the GitHub token it holds — so nothing real is touched.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/github.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { githubStandIn } from "../../../api/harness/github.ts";
import { sharedSession, URL_UNDER_TEST } from "../architecture-harness.mjs";

/** The development API (shell/session.ts `API`, off the production site). */
const API = "https://editor-api-dev.brianjenkins94.workers.dev";
const PORT = 8796;
const ANN = { "id": 4242, "login": "ann" };

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "github-stand-in-"));
const bare = path.join(folder, "repositories", "ann", "app.git");
const work = path.join(folder, "work");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Ann", "-c", "user.email=ann@example.com", ...args], { "cwd": cwd, "encoding": "utf-8" });

let github;
let githubToken;

/** GitHub's token for Ann, as the API comes by it: her authorize page's link, its code exchanged. */
async function tokenFor() {
	const page = await (await fetch(`${github}/login/oauth/authorize?redirect_uri=${encodeURIComponent("http://localhost/callback")}&state=s`)).text();
	const code = new URL(/href="([^"]+code=[^"]+)"/u.exec(page)[1].replaceAll("&amp;", "&")).searchParams.get("code");
	const token = await (await fetch(`${github}/login/oauth/access_token`, { "method": "POST", "body": new URLSearchParams({ "code": code }) })).json();

	return token.access_token;
}

/** What the API's sign-in was pushed: its state, handed back with the code. */
let pushedState;
const proxied = [];

const cors = (origin) => ({ "access-control-allow-origin": origin ?? "*", "access-control-allow-headers": "authorization, dpop, content-type, accept, git-protocol", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-expose-headers": "*" });

async function answerApi(route) {
	const request = route.request();
	const url = new URL(request.url());
	const origin = request.headers()["origin"];
	const json = async (value, status = 200) => route.fulfill({ "status": status, "headers": { ...cors(origin), "content-type": "application/json" }, "body": JSON.stringify(value) });

	if (request.method() === "OPTIONS") {
		return route.fulfill({ "status": 204, "headers": cors(origin) });
	}

	if (url.pathname === "/auth/par") {
		pushedState = new URLSearchParams(request.postData() ?? "").get("state");

		return json({ "request_uri": "urn:ietf:params:oauth:request_uri:test", "expires_in": 60 }, 201);
	}

	if (url.pathname === "/auth/start") {
		return route.fulfill({ "status": 302, "headers": { "location": `${new URL("/", URL_UNDER_TEST).href}?${new URLSearchParams({ "code": "signed-in", "state": pushedState, "iss": API })}` } });
	}

	if (url.pathname === "/token") {
		return json({ "access_token": "editor-token", "token_type": "DPoP", "refresh_token": "editor-refresh", "expires_in": 3600 });
	}

	if (url.pathname === "/account") {
		return json({ "user": "u-ann", "githubId": ANN.id, "email": null });
	}

	// The proxy: GitHub's API and git over HTTP, as they came, with GitHub's token for Ann in place of the editor's.
	const proxy = /^\/github\/(?:api|git)(\/.*)$/u.exec(url.pathname);

	if (proxy !== null) {
		const git = url.pathname.startsWith("/github/git/");

		proxied.push(`${request.method()} ${url.pathname}`);

		const answered = await route.fetch({
			"url": `${github}${proxy[1]}${url.search}`,
			"headers": { ...Object.fromEntries(Object.entries(request.headers()).filter(([name]) => !["authorization", "dpop", "origin", "host"].includes(name))), "authorization": git ? `Basic ${btoa(`x-access-token:${githubToken}`)}` : `Bearer ${githubToken}` }
		});

		return route.fulfill({ "status": answered.status(), "headers": { ...answered.headers(), ...cors(origin) }, "body": await answered.body() });
	}

	return json({});
}

// (routed from the start, as sign-in.mjs is)
const session = sharedSession("github", { "prepare": async (context) => context.route(`${API}/**`, answerApi) });

before(async () => {
	fs.mkdirSync(path.dirname(bare), { "recursive": true });
	git(folder, "init", "-q", "-b", "main", work);
	fs.writeFileSync(path.join(work, "README.md"), "# app\n");
	fs.mkdirSync(path.join(work, "src"));
	fs.writeFileSync(path.join(work, "src", "index.ts"), "export const answer = 42;\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "First");
	git(folder, "clone", "-q", "--bare", work, bare);
	git(work, "remote", "add", "github", bare);
	github = await githubStandIn(PORT, ANN, path.join(folder, "repositories"));
	githubToken = await tokenFor();
});

after(() => {
	fs.rmSync(folder, { "recursive": true, "force": true });
});

/** The workbench's frame, once it's up again after a load. */
const workbench = async () => session.eventually("the workbench's frame", async () => session.page.frames().find((frame) => frame.url().includes("/__vscode__/host.html")), 60_000);

test("signed in, a repository loads from its address: cloned from GitHub through the API, and its files in the workspace", async () => {
	const { page } = session;

	await page.locator("wa-button[aria-label='GitHub']").click({ "timeout": 30_000 });
	await page.locator("[aria-label='GitHub connection'] wa-button", { "hasText": "Sign in" }).click({ "timeout": 30_000 });
	await page.locator("[aria-label='GitHub connection']", { "hasText": "ann" }).waitFor({ "timeout": 60_000 }).catch(async () => {
		await page.locator("wa-button[aria-label='GitHub']").click();
		await page.locator("[aria-label='GitHub connection']", { "hasText": "ann" }).waitFor({ "timeout": 30_000 });
	});

	await page.goto(new URL("/env/ann/app", URL_UNDER_TEST).href);
	await (await workbench()).locator("[role=treeitem]", { "hasText": "README.md" }).waitFor({ "timeout": 120_000 });

	assert.deepEqual(await session.ask("git.origin"), { "owner": "ann", "repo": "app", "branch": "main" });
	assert.ok(proxied.some((call) => call.startsWith("POST /github/git/ann/app.git/git-upload-pack")), `cloned through the API's git proxy: ${proxied.join(", ")}`);
});

test("GitHub moves ahead: the next load offers to fast-forward, and catching up brings its commit in", async () => {
	const { page } = session;

	fs.writeFileSync(path.join(work, "CHANGELOG.md"), "- Second\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "Second");
	git(work, "push", "-q", "github", "main");

	await page.reload();
	await page.locator("text=GitHub's main has 1 commit this workspace doesn't.").waitFor({ "timeout": 120_000 });
	await page.locator("wa-button[aria-label='Fast-forward']").click();
	await page.locator("text=Caught up with GitHub (1 files).").waitFor({ "timeout": 120_000 });
	await (await workbench()).locator("[role=treeitem]", { "hasText": "CHANGELOG.md" }).waitFor({ "timeout": 60_000 });
});

test("a commit here is pushed to GitHub, by who's signed in", async () => {
	await session.ask("files.write", { "path": "src/index.ts", "content": "export const answer = 43;\n" });
	await session.ask("git.commit", { "message": "Ask again", "files": [{ "path": "src/index.ts" }] });

	const pushed = await session.request("git.push", {}, 120_000);

	assert.equal(pushed.ok, true, JSON.stringify(pushed));
	assert.equal(execFileSync("git", ["log", "-1", "--format=%s|%ae", "main"], { "cwd": bare, "encoding": "utf-8" }).trim(), `Ask again|${String(ANN.id)}+ann@users.noreply.github.com`);
	assert.equal(execFileSync("git", ["show", "main:src/index.ts"], { "cwd": bare, "encoding": "utf-8" }), "export const answer = 43;\n");
});
