import type { AddressInfo } from "node:net";
import type { Watch } from "../src/tripwire.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { Breach, crossUser, watched } from "../src/tripwire.ts";
import { someone, testBrowser } from "./helpers.ts";

// The tripwire (README.md, O3): a request made through a user's sign-in that reads the canary account's data, or
// another user's row, is a breach: answered with nothing, the user's sign-ins ended, the kill switch on, the owner told.
// In workerd for the whole response; against a stand-in D1 for what the watched binding sees.

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

const outbox: { "to": string; "subject": string; "text": string }[] = [];
const stand = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		outbox.push(JSON.parse(body) as typeof outbox[number]);
		response.statusCode = 202;
		response.end();
	});
});

await new Promise<void>((resolve) => {
	stand.listen(0, "127.0.0.1", resolve);
});

const standIn = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": standIn, "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9", "CLOUDFLARE_API": "http://127.0.0.1:9" } }] });
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

const { at, browse, byEmail } = testBrowser(server, () => base, { outbox, "db": () => env.DB });

test("the hourly cron seeds the canary: a user, an email identity and a live sign-in, nobody's", async () => {
	assert.equal((await browse(`${at("/cdn-cgi/handler/scheduled")}?${new URLSearchParams({ "cron": "7 * * * *" })}`)).status, 200);

	const canary = await env.DB.prepare("SELECT u.id, i.subject, g.label FROM users u JOIN identities i ON i.user_id = u.id JOIN grants g ON g.user_id = u.id WHERE g.label = 'canary'").first<{ "id": string; "subject": string; "label": string }>();

	assert.match(canary?.subject ?? "", /^canary-[0-9a-f]{8}@unusuallygood\.dev$/u);
	assert.match(canary?.id ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("a request that reads the canary's data: nothing answered, the user's sign-ins ended, the API down, the owner told", async () => {
	const address = someone();
	const thief = await byEmail(address);
	const other = await byEmail(address);
	const me = (await (await thief.call("GET", "/account")).json() as { "user": string }).user;
	const canary = await env.DB.prepare("SELECT id FROM grants WHERE label = 'canary'").first<{ "id": string }>();

	// As if a bug let the user's own read reach the canary's data: one of their rows now holds the canary's sign-in id.
	await env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, backed_up, created_at) VALUES (?, ?, 'x', 0, 0, ?)").bind(canary?.id, me, Date.now()).run();

	const answer = await thief.call("GET", "/account");

	assert.equal(answer.status, 500);
	assert.deepEqual(await answer.json(), { "error": "internal" }, "nothing of what was read");
	assert.equal((await other.call("GET", "/sessions")).status, 503, "the API is down for maintenance");
	assert.deepEqual(await (await browse(at("/status"))).json(), { "maintenance": true, "paused": [] });

	const row = await env.DB.prepare("SELECT reason, detail FROM audit WHERE event = 'tripwire'").first<{ "reason": string; "detail": string }>();

	assert.equal(row?.reason, "canary");
	assert.match(row?.detail ?? "", /^GET \/account · SELECT id, created_at, last_used_at, backed_up FROM passkeys/u, "the route and the query's text, no values");
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(me).first<{ "n": number }>())?.n, 0, "every sign-in of the user's ended");
	assert.ok(outbox.some((message) => message.to === ALERT_EMAIL && message.subject.endsWith("Tripwire: someone read data that isn't theirs")));
});

/** A stand-in D1 whose every query answers `rows`, and the queries it was asked. */
function standInDb(rows: Record<string, unknown>[]): D1Database {
	const statement = (): D1PreparedStatement => ({
		"bind": () => statement(),
		"first": async () => rows[0] ?? null,
		"all": async () => ({ "results": rows, "success": true, "meta": {} }),
		"raw": async () => rows.map((row) => Object.values(row)),
		"run": async () => ({ "results": [], "success": true, "meta": {} })
	}) as unknown as D1PreparedStatement;

	return { "prepare": () => statement(), "batch": async (statements: D1PreparedStatement[]) => Promise.all(statements.map(async (one) => one.all())) } as unknown as D1Database;
}

const watch = (enforce: boolean): Watch => ({ "user": "me", "raw": standInDb([]), "canary": new Set(["the-canary"]), "enforce": enforce, "reports": [] });

test("the watched binding: another user's row trips (or, before enforcing, is reported); one's own rows don't; crossUser is unwatched", async () => {
	const mine = watched(standInDb([{ "user_id": "me", "id": "a" }]), watch(true));

	assert.deepEqual(await mine.prepare("SELECT id, user_id FROM grants WHERE user_id = ?").bind("me").first(), { "user_id": "me", "id": "a" });

	const theirs = standInDb([{ "user_id": "someone else", "id": "b" }]);
	const enforcing = watch(true);

	await assert.rejects(watched(theirs, enforcing).prepare("SELECT id, user_id FROM grants").all(), Breach);
	assert.equal(enforcing.breach?.kind, "another user's row");

	const reporting = watch(false);

	assert.equal((await watched(theirs, reporting).prepare("SELECT id, user_id FROM grants").all()).results.length, 1, "reported, not refused");
	assert.equal(reporting.reports[0]?.other, "someone else");
	assert.equal((await crossUser(watched(theirs, watch(true)), "a test").prepare("SELECT user_id FROM identities").first<{ "user_id": string }>())?.user_id, "someone else", "on purpose: unwatched");
});

test("the canary trips even before enforcing, in a value of any column, in a batch and in raw rows", async () => {
	const canary = standInDb([{ "subject": "the-canary" }]);

	for (const read of [
		async (db: D1Database) => db.prepare("SELECT subject FROM identities").first(),
		async (db: D1Database) => db.batch([db.prepare("SELECT subject FROM identities")]),
		async (db: D1Database) => db.prepare("SELECT subject FROM identities").raw()
	]) {
		const state = watch(false);

		await assert.rejects(read(watched(canary, state)), Breach);
		assert.equal(state.breach?.kind, "canary");
	}
});
