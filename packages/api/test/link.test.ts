import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import type { App } from "./helpers.ts";
import { testBrowser, PAGES, someone } from "./helpers.ts";

// Linking (README.md, "Linking accounts, and roles") in workerd, against stand-ins for GitHub and the outbox: an email account
// connects GitHub, a GitHub account adds an email, an empty duplicate is merged in, anything more is refused; and roles
// go by how a sign-in was made.

const EDITOR = PAGES.editor;
const ADMIN = PAGES.admin;
const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests",
	"TOTP_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": "client secret for the tests"
};

/** GitHub's next answer: whose account the user said yes as. */
const github = { "id": 4242 };
const outbox: { "to": string; "subject": string }[] = [];
const stand = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		response.setHeader("content-type", "application/json");

		if (request.url === "/login/oauth/access_token") {
			response.end(JSON.stringify({ "access_token": `ghu_${crypto.randomUUID()}`, "refresh_token": `ghr_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600 }));
		} else if (request.url === "/user") {
			response.end(JSON.stringify({ "id": github.id, "login": "octocat" }));
		} else if (request.url === "/outbox") {
			outbox.push(JSON.parse(body) as typeof outbox[number]);
			response.statusCode = 202;
			response.end();
		} else {
			response.statusCode = 404;
			response.end("{}");
		}
	});
});

await new Promise<void>((resolve) => {
	stand.listen(0, "127.0.0.1", resolve);
});

const standIn = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": `${standIn}/outbox`, "GITHUB_ORIGIN": standIn, "GITHUB_API": standIn, "CLOUDFLARE_API": "http://127.0.0.1:9" } }] });
const worker = server.getWorker();
let base: URL;
let env: { "DB": D1Database };

before(async () => {
	({ "url": base } = await server.listen());
	await worker.applyD1Migrations("DB");
	env = await worker.getEnv() as typeof env;
});

after(async () => {
	await server.close();
	stand.close();
});

const { at, browse, app, byEmail, byGitHub, codeFor, aMinuteLater } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

/** Connecting GitHub (as `id`) from `signedIn`: its authorize page, GitHub's way back to `returnTo`, and the link code. */
async function connect(signedIn: App, id: number, returnTo = `${signedIn.page}env/octo/hello`): Promise<URL> {
	const asked = await signedIn.call("POST", `${signedIn.prefix}/account/github`, { "return": returnTo });

	assert.equal(asked.status, 200);

	const authorize = new URL((await asked.json() as { "location": string }).location);

	github.id = id;

	return new URL((await browse(`${at("/auth/github/callback")}?${new URLSearchParams({ "code": "github-code", "state": authorize.searchParams.get("state") as string })}`)).headers.get("location") as string);
}

const account = async (signedIn: App): Promise<{ "user": string; "githubId": number | null; "email": { "address": string } | null }> => (await signedIn.call("GET", `${signedIn.prefix}/account`)).json() as Promise<{ "user": string; "githubId": number | null; "email": { "address": string } | null }>;

const userOf = async (signedIn: App): Promise<string> => (await account(signedIn)).user;

const newGithubId = (): number => 100_000 + Math.floor(Math.random() * 1_000_000);

test("an email account connects GitHub: GitHub's way back to the app's page, finished by this sign-in; then GitHub's sign-in is the same account, and the proxy reaches GitHub at once", async () => {
	const address = someone();
	const editor = await byEmail(address);
	const id = newGithubId();

	assert.equal((await editor.call("GET", "/github/api/user")).status, 403, "no GitHub yet");

	const back = await connect(editor, id);

	assert.equal(`${back.origin}${back.pathname}`, `${EDITOR}env/octo/hello`, "back to the page it asked from");

	const finished = await editor.call("POST", "/account/github/finish", { "link": back.searchParams.get("link") as string });

	assert.equal(finished.status, 200);
	assert.equal((await account(editor)).githubId, id);
	assert.equal((await editor.call("GET", "/github/api/user")).status, 200, "GitHub's tokens are this sign-in's now");

	const again = await byGitHub(id);

	assert.equal(await userOf(again), await userOf(editor), "one account, two ways in");
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'identity_linked' AND user_id = ? ORDER BY id DESC").bind(await userOf(editor)).first<{ "reason": string }>())?.reason, "github");
});

test("a link goes only to the app's own pages, finishes only in the sign-in that started it, once, and needs a sign-in in the last 10 minutes", async () => {
	const editor = await byEmail(someone());

	assert.equal((await editor.call("POST", "/account/github", { "return": "https://evil.example/" })).status, 400);
	assert.equal((await editor.call("POST", "/account/github", { "return": ADMIN })).status, 400, "not another client's page");

	const back = await connect(editor, newGithubId());
	const link = back.searchParams.get("link") as string;
	const stranger = await byEmail(someone());

	assert.equal((await stranger.call("POST", "/account/github/finish", { "link": link })).status, 400, "another sign-in can't finish it");
	assert.equal((await stranger.call("GET", "/account")).status, 200);
	assert.equal((await account(stranger)).githubId, null);
	assert.equal((await editor.call("POST", "/account/github/finish", { "link": link })).status, 200);
	assert.equal((await editor.call("POST", "/account/github/finish", { "link": link })).status, 400, "once");

	const late = await byEmail(someone());

	await env.DB.prepare("UPDATE grants SET created_at = created_at - 11 * 60000 WHERE user_id = ?").bind(await userOf(late)).run();

	const refused = await late.call("POST", "/account/github", { "return": EDITOR });

	assert.equal(refused.status, 403);
	assert.equal((await refused.json() as { "error": string }).error, "sign_in_again");
});

test("a GitHub account adds an email: a code to it, then the code; an email sign-in is the same account after", async () => {
	const editor = await byGitHub(newGithubId());
	const address = someone();

	assert.equal((await editor.call("POST", "/account/email/code", { "address": "not an address" })).status, 400);
	assert.equal((await editor.call("POST", "/account/email/code", { "address": address })).status, 200);
	assert.equal((await editor.call("POST", "/account/email", { "address": someone(), "code": codeFor(address) })).status, 400, "the code is for its address only");
	assert.equal((await editor.call("POST", "/account/email", { "address": address, "code": codeFor(address) })).status, 200);
	assert.equal((await account(editor)).email?.address, address);
	await aMinuteLater();
	assert.equal(await userOf(await byEmail(address)), await userOf(editor));
});

test("a way in that's another account's: merged in when that account holds nothing else and the person says so; refused when it holds more", async () => {
	const address = someone();
	const duplicate = await byEmail(address);
	const duplicateId = await userOf(duplicate);
	const editor = await byGitHub(newGithubId());

	await editor.call("POST", "/account/email/code", { "address": address });

	const code = codeFor(address);
	const asked = await editor.call("POST", "/account/email", { "address": address, "code": code });

	assert.equal(asked.status, 409);
	assert.deepEqual(await asked.json(), { "error": "taken", "reason": "that email is another account's", "account": duplicateId, "mergeable": true });

	const merged = await editor.call("POST", "/account/email", { "address": address, "code": code, "merge": "1" });

	assert.equal(merged.status, 200, "the same code, now saying merge");
	assert.equal((await account(editor)).email?.address, address);
	assert.equal(typeof (await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?").bind(duplicateId).first<{ "deleted_at": number | null }>())?.deleted_at, "number", "the duplicate is deleted, as an account deletion is");
	assert.equal((await duplicate.call("GET", "/account")).status, 401, "its sign-ins ended");
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'account_merged' AND user_id = ?").bind(duplicateId).first<{ "n": number }>())?.n, 1);

	// One with a password is someone's to keep: refused, merge or not.
	const kept = someone();
	const keeper = await byEmail(kept);

	await keeper.call("POST", "/account/password/code", {});
	await aMinuteLater();
	assert.equal((await keeper.call("POST", "/account/password", { "code": codeFor(kept), "password": "a long and unusual password" })).status, 200);

	const other = await byGitHub(newGithubId());

	await other.call("POST", "/account/email/code", { "address": kept });

	const refused = await other.call("POST", "/account/email", { "address": kept, "code": codeFor(kept), "merge": "1" });

	assert.equal(refused.status, 409);
	assert.equal((await refused.json() as { "mergeable": boolean }).mergeable, false);
});

test("connecting a GitHub account that has its own empty account merges it, from the same link, once asked", async () => {
	const id = newGithubId();
	const githubOnly = await userOf(await byGitHub(id));
	const editor = await byEmail(someone());
	const link = (await connect(editor, id)).searchParams.get("link") as string;
	const asked = await editor.call("POST", "/account/github/finish", { "link": link });

	assert.equal(asked.status, 409);
	assert.deepEqual(await asked.json(), { "error": "taken", "reason": "that GitHub account is another account's", "account": githubOnly, "mergeable": true });
	assert.equal((await editor.call("POST", "/account/github/finish", { "link": link, "merge": "1" })).status, 200);
	assert.equal((await account(editor)).githubId, id);
	assert.equal(await userOf(await byGitHub(id)), await userOf(editor));
});

test("roles go by how a sign-in was made: the owner's GitHub sign-in is the owner; the same account by an emailed code holds no role", async () => {
	const admin = await byGitHub(OWNER, "admin");

	assert.deepEqual((await (await admin.call("GET", "/admin/me")).json() as { "roles": string[] }).roles, ["owner"]);

	const address = someone();

	await admin.call("POST", "/admin/account/email/code", { "address": address });
	assert.equal((await admin.call("POST", "/admin/account/email", { "address": address, "code": codeFor(address) })).status, 200);
	await aMinuteLater();

	const byInbox = await byEmail(address, "admin");
	const me = await (await byInbox.call("GET", "/admin/me")).json() as { "user": string; "roles": string[] };

	assert.equal(me.user, await userOf(admin), "the owner's account");
	assert.deepEqual(me.roles, [], "but an emailed code carries no role");
});
