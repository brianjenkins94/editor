import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { someone, testBrowser } from "./helpers.ts";

// What the editor reports (OPERATIONS.md, O6) in workerd: a signed-in session's events onto its timeline, in the fixed
// vocabulary only, a repository by its keyed tag; its uncaught errors, signed in (on the timeline, with the user) or
// not (nothing of who but a daily IP hash), each under the id the editor shows.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests",
	"GITHUB_CLIENT_SECRET": "client secret for the tests"
};

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

const { at, browse, byEmail, byGitHub } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

const grantOf = async (user: string): Promise<string> => (await env.DB.prepare("SELECT id FROM grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(user).first<{ "id": string }>())?.id as string;

type Item = { "kind": string; "name"?: string; "detail"?: string | null };

test("a signed-in session's events go onto its timeline: the vocabulary only, a repository by its tag; signed out, none are taken", async () => {
	const editor = await byEmail(someone());
	const me = (await (await editor.call("GET", "/account")).json() as { "user": string }).user;
	const sent = await editor.call("POST", "/session/events", undefined, { "events": [
		{ "name": "page.shown" },
		{ "name": "repo.loaded", "detail": "octo/private-thing" },
		{ "name": "command.run", "detail": "workbench.action.files.save" },
		{ "name": "pane.opened", "detail": "workbench.view.explorer" },
		{ "name": "keystroke", "detail": "a" },
		{ "name": "command.run", "detail": "not a command id; drop table" }
	] });

	assert.deepEqual(await sent.json(), { "kept": 5 }, "the keystroke dropped; the bad detail dropped, the event kept");
	assert.equal((await browse(at("/session/events"), { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "events": [{ "name": "page.shown" }] }) })).status, 401, "signed out: nothing");

	const owner = await byGitHub(OWNER, "admin");
	const { items } = await (await owner.call("GET", `/admin/sessions/${await grantOf(me)}/timeline`)).json() as { "items": Item[] };
	const editorItems = items.filter((item) => item.kind === "editor");

	assert.deepEqual(editorItems.map((item) => item.name), ["page.shown", "repo.loaded", "command.run", "pane.opened", "command.run"]);
	assert.match(editorItems[1]?.detail ?? "", /^repo#/u, "a repository's keyed tag, never its name");
	assert.equal(JSON.stringify(items).includes("private-thing"), false);
	assert.equal(editorItems[4]?.detail, null);
});

test("an editor error, signed out: recorded with an id, nothing of who but a daily IP hash; signed in: the user, and the timeline has it", async () => {
	const anonymous = await browse(at("/errors"), { "method": "POST", "headers": { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" }, "body": JSON.stringify({ "name": "TypeError", "message": "x is undefined for someone@example.com", "stack": "TypeError: x\n    at render (shell.js:1:2)", "source": "shell", "release": "abc1234", "breadcrumbs": ["page.shown", "keystroke", "repo.loaded"] }) });
	const { id } = await anonymous.json() as { "id": string };

	assert.match(id, /^E-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);

	const row = await env.DB.prepare("SELECT o.user_id, o.grant_id, o.ip_hash, o.message, o.route, o.release, o.breadcrumbs, e.source FROM error_occurrences o JOIN errors e ON e.fingerprint = o.fingerprint WHERE o.id = ?").bind(id).first<Record<string, string | null>>();

	assert.deepEqual([row?.user_id, row?.grant_id, row?.route, row?.release, row?.source, row?.breadcrumbs], [null, null, "editor shell", "abc1234", "editor", "page.shown,repo.loaded"]);
	assert.match(row?.ip_hash ?? "", /^[\w-]{22}$/u, "the IP only as its keyed hash");
	assert.equal(row?.message, "x is undefined for «email»");

	const editor = await byEmail(someone());
	const me = (await (await editor.call("GET", "/account")).json() as { "user": string }).user;
	const { "id": signedInId } = await (await editor.call("POST", "/errors", undefined, { "name": "Error", "message": "boom", "source": "workbench" })).json() as { "id": string };
	const signed = await env.DB.prepare("SELECT user_id, ip_hash FROM error_occurrences WHERE id = ?").bind(signedInId).first<{ "user_id": string; "ip_hash": string | null }>();

	assert.deepEqual([signed?.user_id, signed?.ip_hash], [me, null]);

	const owner = await byGitHub(OWNER, "admin");
	const { items } = await (await owner.call("GET", `/admin/sessions/${await grantOf(me)}/timeline`)).json() as { "items": (Item & { "id"?: string })[] };

	assert.ok(items.some((item) => item.kind === "editor" && item.name === "error" && item.detail === signedInId), "its event, by id");
	assert.ok(items.some((item) => item.kind === "error" && item.id === signedInId), "and the error itself");
});
