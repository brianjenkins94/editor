import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { someone, testBrowser } from "./helpers.ts";

// The kill switch (OPERATIONS.md, O1) in workerd: the owner turns it on from the admin app; then the API is "Down for
// maintenance" to everyone but the owner's way back in; every flip is audited and emailed to the owner, a break-glass
// flip made straight in D1 too; off again, all is as before.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const VIEWER = 64174526; // VIEWERS
const ALERT_EMAIL = "owner@example.com";
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests",
	"GITHUB_CLIENT_SECRET": "client secret for the tests",
	"ALERT_EMAIL": ALERT_EMAIL
};

const github = { "id": 4242 };
const outbox: { "to": string; "subject": string; "text": string }[] = [];
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

const { at, browse, app, byEmail, byGitHub } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

const toOwner = (): typeof outbox => outbox.filter((message) => message.to === ALERT_EMAIL);

const flips = async (): Promise<{ "event": string; "reason": string; "detail": string }[]> => (await env.DB.prepare("SELECT event, reason, detail FROM audit WHERE event IN ('maintenance_on', 'maintenance_off') ORDER BY id").all<{ "event": string; "reason": string; "detail": string }>()).results;

test("the owner turns it on: the API is down for everyone else, the owner's way back in stays open; off, all is as before", async () => {
	const owner = await byGitHub(OWNER, "admin");
	const viewer = await byGitHub(VIEWER, "admin");
	const editor = await byEmail(someone());

	assert.equal((await editor.call("GET", "/account")).status, 200);
	assert.equal((await viewer.call("POST", "/admin/maintenance", { "turn": "on" })).status, 403, "a viewer can't flip it");

	const on = await owner.call("POST", "/admin/maintenance", { "turn": "on", "reason": "looking into something" });

	assert.equal(on.status, 200);
	assert.equal((await on.json() as { "on": boolean }).on, true);

	// Everyone else: down, saying only that, before any other work.
	const refused = await editor.call("GET", "/account");

	assert.equal(refused.status, 503);
	assert.deepEqual(await refused.json(), { "error": "maintenance", "reason": "Down for maintenance" });
	assert.equal(refused.headers.get("retry-after"), "300");
	assert.equal((await viewer.call("GET", "/admin/me")).status, 503, "the admin API is the owner's only");
	assert.equal((await browse(at("/auth/email"), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": "address=a%40example.com" })).status, 503);
	assert.deepEqual(await (await browse(at("/status"))).json(), { "maintenance": true });
	assert.equal((await browse(at("/health"))).status, 200);

	// The editor can't even start a sign-in; the admin app can, by GitHub or a passkey only.
	assert.equal((await app("editor")).cookie, "", "the editor's push refused, so no attempt");

	const adminAttempt = await app("admin");

	assert.deepEqual(await (await browse(at("/auth/attempt"), { "cookie": adminAttempt.cookie })).json(), { "client": "admin", "name": "the admin app", "methods": ["github", "passkey"] });

	// The owner signs in again and sees why; the switch goes off.
	const again = await byGitHub(OWNER, "admin");
	const me = await (await again.call("GET", "/admin/me")).json() as { "maintenance": { "on": boolean; "reason": string; "by": string } };

	assert.equal(me.maintenance.on, true);
	assert.equal(me.maintenance.reason, "looking into something");
	assert.match(me.maintenance.by, /^user:/u);
	assert.equal((await again.call("POST", "/admin/maintenance", { "turn": "off" })).status, 200);
	assert.equal((await editor.call("GET", "/account")).status, 200, "back as before");

	// Both flips audited and emailed to the owner.
	assert.deepEqual((await flips()).map((flip) => [flip.event, flip.reason]), [["maintenance_on", "looking into something"], ["maintenance_off", null]]);
	assert.deepEqual(toOwner().map((message) => message.subject), ["[unusually good local] The API is down for maintenance", "[unusually good local] The API is back up"]);
	assert.match(toOwner()[0]?.text ?? "", /Why: looking into something/u);
});

test("a break-glass flip, made straight in D1, is noticed by the next request: down, audited, the owner emailed, once", { "timeout": 30_000 }, async () => {
	const before = toOwner().length;
	const editor = await byEmail(someone());

	await env.DB.prepare("UPDATE maintenance SET switched_on = 1, reason = 'break glass test', by = 'break glass', at = ?, noticed = 0 WHERE id = 1").bind(Date.now()).run();

	// An isolate reads the switch at most every 10 seconds.
	await new Promise((resolve) => {
		setTimeout(resolve, 10_500);
	});

	assert.equal((await editor.call("GET", "/account")).status, 503);
	assert.equal((await browse(at("/status"))).status, 200);
	assert.deepEqual((await flips()).at(-1), { "event": "maintenance_on", "reason": "break glass test", "detail": "by break glass" });
	assert.equal(toOwner().length, before + 1, "noticed once, however many requests read it");

	await env.DB.prepare("UPDATE maintenance SET switched_on = 0, reason = NULL, by = 'break glass', at = ?, noticed = 0 WHERE id = 1").bind(Date.now()).run();
	await new Promise((resolve) => {
		setTimeout(resolve, 10_500);
	});
	assert.equal((await editor.call("GET", "/account")).status, 200);
	assert.equal((await flips()).at(-1)?.event, "maintenance_off");
});
