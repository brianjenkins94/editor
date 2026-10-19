import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { someone, testBrowser } from "./helpers.ts";

// Session timelines (OPERATIONS.md, O5) in workerd: each request through a sign-in is held by its Grant, and the admin
// app reads the sign-in's requests, audit rows and errors in order; a viewer may, an editor token may not; RETAIN after
// the sign-in ends, its requests go.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const VIEWER = 64174526; // VIEWERS
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
let env: { "DB": D1Database; "GRANTS": DurableObjectNamespace<import("../src/grant.ts").Grant> };

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

type Item = { "kind": string; "at": number; "route"?: string; "status"?: number; "event"?: string; "id"?: string };

test("a sign-in's requests, audit rows and errors, in order, for the admin app; a viewer may read it, an editor token can't", async () => {
	const editor = await byEmail(someone());
	const me = (await (await editor.call("GET", "/account")).json() as { "user": string }).user;
	const grant = (await env.DB.prepare("SELECT id FROM grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(me).first<{ "id": string }>())?.id as string;

	await editor.call("GET", "/sessions");
	await editor.call("POST", "/sessions/0000000000000000000000000000000000000000000000000000000000000000/revoke", {});

	// And an error, as a bug would make one.
	await env.DB.prepare("ALTER TABLE passkeys RENAME TO passkeys_away").run();

	const failed = await (await editor.call("GET", "/account")).json() as { "id": string };

	await env.DB.prepare("ALTER TABLE passkeys_away RENAME TO passkeys").run();

	const viewer = await byGitHub(VIEWER, "admin");
	const read = await viewer.call("GET", `/admin/sessions/${grant}/timeline`);

	assert.equal(read.status, 200);

	const { session, items } = await read.json() as { "session": { "user_id": string; "client": string; "method": string }; "items": Item[] };

	assert.deepEqual([session.user_id, session.client, session.method], [me, "editor", "email"]);
	assert.deepEqual(items.filter((item) => item.kind === "request").map((item) => [item.route, item.status]), [
		["GET /account", 200],
		["GET /sessions", 200],
		["POST /sessions/:id/revoke", 404],
		["GET /account", 500]
	], "each request, as the behavior model names it, and how it went");
	assert.ok(items.some((item) => item.kind === "audit" && item.event === "login"), "its audit rows");
	assert.ok(items.some((item) => item.kind === "audit" && item.event === "auth_refused"), "the refused revoke");
	assert.ok(items.some((item) => item.kind === "error" && item.id === failed.id), "its error, by the id the person saw");
	assert.deepEqual(items.map((item) => item.at), items.map((item) => item.at).toSorted((a, b) => a - b), "in order");
	assert.equal((await editor.call("GET", `/admin/sessions/${grant}/timeline`)).status, 403, "an editor token can't");
	assert.equal((await (await byGitHub(OWNER, "admin")).call("GET", "/admin/sessions/nope/timeline")).status, 404);
});

test("RETAIN after a sign-in ends, its requests go; before then, and while it's live, they stay", async () => {
	const editor = await byEmail(someone());
	const me = (await (await editor.call("GET", "/account")).json() as { "user": string }).user;
	const id = (await env.DB.prepare("SELECT id FROM grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(me).first<{ "id": string }>())?.id as string;
	const grant = env.GRANTS.get(env.GRANTS.idFromString(id));
	const day = 86_400_000;

	await grant.expireTimeline(Date.now() + 60 * day);
	assert.equal((await grant.timeline()).length, 1, "live: kept");

	await grant.revoke({ "from": { "country": null, "ipHash": null, "traceId": null } });
	await grant.expireTimeline(Date.now() + 29 * day);
	assert.equal((await grant.timeline()).length, 1, "ended, but not 30 days ago");
	await grant.expireTimeline(Date.now() + 31 * day);
	assert.equal((await grant.timeline()).length, 0, "30 days after it ended: gone");
});

test("the tripwire's canary: its timeline is its audit rows and errors (it has no Grant), and it can't be ended", async () => {
	assert.equal((await browse(`${at("/cdn-cgi/handler/scheduled")}?${new URLSearchParams({ "cron": "7 * * * *" })}`)).status, 200);

	const canary = (await env.DB.prepare("SELECT id FROM grants WHERE label = 'canary'").first<{ "id": string }>())?.id as string;
	const owner = await byGitHub(OWNER, "admin");
	const read = await owner.call("GET", `/admin/sessions/${canary}/timeline`);

	assert.equal(read.status, 200, "not the namespace's id, but no error");

	const { items } = await read.json() as { "items": Item[] };

	assert.equal(items.filter((item) => item.kind === "request" || item.kind === "editor").length, 0);

	const ended = await owner.call("POST", `/admin/sessions/${canary}/revoke`, { "confirm": "revoke" });

	assert.equal(ended.status, 409);
	assert.equal((await env.DB.prepare("SELECT revoked_at FROM grants WHERE id = ?").bind(canary).first<{ "revoked_at": number | null }>())?.revoked_at, null, "still live: the tripwire keeps its bait");
});
