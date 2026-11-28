import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { someone, testBrowser } from "./helpers.ts";
import { apiWorker } from "./worker.ts";

// The queue (src/queue.ts, README.md *The queue*) in workerd: a new error group is an item, once; the daily cron adds
// the week's review of agents' tool use, once a week; a viewer reads them, the owner closes one with what was done.

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
const server = apiWorker({ secrets, "vars": { "EMAIL_OUTBOX": `${standIn}/outbox`, "GITHUB_ORIGIN": standIn, "GITHUB_API": standIn, "CLOUDFLARE_API": "http://127.0.0.1:9", "RELEASE": "abc1234" } });
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

const { byEmail, byGitHub } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });


interface Items { "items": { "id": number; "kind": string; "ref": string | null; "title": string; "detail": string | null; "closedAt": number | null; "outcome": string | null }[] }

test("a new error group is an item, once; the week's review comes from the daily cron, once a week; the owner closes one with what was done", async () => {
	const editor = await byEmail(someone());

	// A table the account page reads, gone: the request fails as a bug would, twice — one group.
	await env.DB.prepare("ALTER TABLE passkeys RENAME TO passkeys_away").run();

	try {
		await editor.call("GET", "/account");
		await editor.call("GET", "/account");
	} finally {
		await env.DB.prepare("ALTER TABLE passkeys_away RENAME TO passkeys").run();
	}

	const viewer = await byGitHub(VIEWER, "admin");
	const open = async (): Promise<Items["items"]> => (await (await viewer.call("GET", "/admin/queue")).json() as Items).items;
	const fingerprint = (await env.DB.prepare("SELECT fingerprint FROM errors").first<{ "fingerprint": string }>())?.fingerprint;

	assert.deepEqual((await open()).map(({ kind, ref, title }) => [kind, ref, title]), [["error", fingerprint, "New error: Error"]], "one item for the group, however often it happened");

	// The daily cron: the week's review, once; not again the next day; again a week on.
	await worker.scheduled({ "cron": "17 3 * * *" });
	await worker.scheduled({ "cron": "17 3 * * *" });
	assert.deepEqual((await open()).map(({ kind }) => kind), ["error", "agent-use"]);
	assert.match((await open())[1]?.detail ?? "", /agent_usage/u);
	await env.DB.prepare("UPDATE queue SET at = at - ? WHERE kind = 'agent-use'").bind(8 * 86_400_000).run();
	await worker.scheduled({ "cron": "17 3 * * *" });
	assert.equal((await open()).filter(({ kind }) => kind === "agent-use").length, 1, "not while one is open");

	// A viewer reads; only the owner closes, and says what was done.
	const item = (await open()).find(({ kind }) => kind === "error");

	assert.equal((await viewer.call("POST", `/admin/queue/${String(item?.id)}/close`, { "outcome": "looked" })).status, 403);

	const owner = await byGitHub(OWNER, "admin");

	assert.equal((await owner.call("POST", `/admin/queue/${String(item?.id)}/close`, { "outcome": " " })).status, 400, "an outcome, said");
	assert.equal((await owner.call("POST", `/admin/queue/${String(item?.id)}/close`, { "outcome": "The passkeys table was renamed by a test: nothing to fix." })).status, 200);
	assert.equal((await owner.call("POST", `/admin/queue/${String(item?.id)}/close`, { "outcome": "again" })).status, 404, "closed already");
	assert.deepEqual((await open()).map(({ kind }) => kind), ["agent-use"]);

	// The same error again, after its item was closed: queued again, once.
	await env.DB.prepare("ALTER TABLE passkeys RENAME TO passkeys_away").run();

	try {
		await editor.call("GET", "/account");
		await editor.call("GET", "/account");
	} finally {
		await env.DB.prepare("ALTER TABLE passkeys_away RENAME TO passkeys").run();
	}

	assert.deepEqual((await open()).filter(({ kind }) => kind === "error").map(({ ref, title }) => [ref, title]), [[fingerprint, "Error again: Error"]]);
	await owner.call("POST", `/admin/queue/${String((await open()).find(({ kind }) => kind === "error")?.id)}/close`, { "outcome": "Still the test's renamed table." });

	const closed = (await (await viewer.call("GET", "/admin/queue?closed=1")).json() as Items).items;

	assert.deepEqual(closed.map(({ outcome }) => outcome), ["Still the test's renamed table.", "The passkeys table was renamed by a test: nothing to fix."]);

	// Closed and the week gone by: the next review.
	await owner.call("POST", `/admin/queue/${String((await open())[0]?.id)}/close`, { "outcome": "Reviewed: no findings." });
	await env.DB.prepare("UPDATE queue SET at = at - ? WHERE kind = 'agent-use'").bind(8 * 86_400_000).run();
	await worker.scheduled({ "cron": "17 3 * * *" });
	assert.deepEqual((await open()).map(({ kind }) => kind), ["agent-use"]);
	assert.equal((await editor.call("GET", "/admin/queue")).status, 403, "an editor token can't reach it");
});
