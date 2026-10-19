import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { testBrowser } from "./helpers.ts";

// The cost guard (OPERATIONS.md, O2) in workerd, against a stand-in for Cloudflare's GraphQL Analytics that reports
// whatever usage the test says: the hourly check prices it, emails the owner past half the budget (once a day), turns
// the kill switch on at the budget, doesn't fight a person who turned it off (until double), and says when it's blind.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const ALERT_EMAIL = "owner@example.com";
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": "client secret for the tests",
	"ANALYTICS_TOKEN": "analytics token for the tests",
	"ALERT_EMAIL": ALERT_EMAIL
};

/** What the analytics stand-in reports for the last 24 hours: D1 rows written (a dollar a million beyond the plan), or
 *  that it can't be read. */
const analytics = { "rowsWritten": 0, "down": false };
const github = { "id": 4242 };
const outbox: { "to": string; "subject": string; "text": string }[] = [];
const stand = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		response.setHeader("content-type", "application/json");

		if (request.url === "/client/v4/graphql") {
			if (analytics.down) {
				response.statusCode = 503;
				response.end("{}");

				return;
			}

			const today = new Date().toISOString().slice(0, 10);

			response.end(JSON.stringify({ "data": { "viewer": { "accounts": [{
				"workers": [{ "sum": { "requests": 1000, "cpuTimeUs": 2_000_000 }, "dimensions": { "date": today } }],
				"d1": [{ "sum": { "rowsRead": 5000, "rowsWritten": analytics.rowsWritten }, "dimensions": { "date": today } }],
				"objects": [], "periodic": [], "r2": [{ "sum": { "requests": 10 }, "dimensions": { "date": today, "actionType": "PutObject" } }, { "sum": { "requests": 3 }, "dimensions": { "date": today, "actionType": "DeleteObject" } }], "email": []
			}] } }, "errors": null }));
		} else if (request.url === "/login/oauth/access_token") {
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
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": `${standIn}/outbox`, "GITHUB_ORIGIN": standIn, "GITHUB_API": standIn, "CLOUDFLARE_API": standIn } }] });
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

const { at, browse, byGitHub } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

/** The hourly cron, now. */
async function hourly(): Promise<void> {
	assert.equal((await browse(`${at("/cdn-cgi/handler/scheduled")}?${new URLSearchParams({ "cron": "7 * * * *" })}`)).status, 200);
}

const toOwner = (): string[] => outbox.filter((message) => message.to === ALERT_EMAIL).map((message) => message.subject.replace(/^\[unusually good local\] /u, ""));

const events = async (): Promise<string[]> => (await env.DB.prepare("SELECT event FROM audit WHERE event LIKE 'spend_%' OR event LIKE 'maintenance_%' ORDER BY id").all<{ "event": string }>()).results.map((row) => row.event);

const switchedOn = async (): Promise<boolean> => (await (await browse(at("/status"))).json() as { "maintenance": boolean }).maintenance;

beforeEach(async () => {
	analytics.down = false;
	outbox.length = 0;
	await env.DB.batch([env.DB.prepare("DELETE FROM audit WHERE event LIKE 'spend_%' OR event LIKE 'maintenance_%'"), env.DB.prepare("UPDATE maintenance SET switched_on = 0, reason = NULL, by = NULL, at = NULL, noticed = 1 WHERE id = 1")]);
});

test("under half the budget, nothing; past half, the owner emailed once a day; the admin app sees it priced by meter", async () => {
	analytics.rowsWritten = 2_000_000;
	await hourly();
	assert.deepEqual(toOwner(), []);

	analytics.rowsWritten = 12_000_000;
	await hourly();
	await hourly();
	assert.deepEqual(toOwner(), ["Spend at $12.00 in 24 hours"], "once a day, however many checks");
	assert.deepEqual(await events(), ["spend_warning"]);
	assert.equal(await switchedOn(), false);

	const owner = await byGitHub(OWNER, "admin");
	const spend = await (await owner.call("GET", "/admin/spend")).json() as { "budget": number; "last24Hours": { "total": number; "meters": { "meter": string; "dollars": number }[] } };

	assert.equal(spend.budget, 20);
	assert.equal(spend.last24Hours.meters[0]?.meter, "D1 rows written", "the most expensive first");
	assert.ok(Math.abs(spend.last24Hours.total - (12 + 1000 * 0.3e-6 + 2000 * 0.02e-6 + 5000 * 0.001e-6 + 10 * 4.5e-6)) < 1e-9, "every meter priced; deletes are free");
});

test("at the budget, the kill switch on, by the cost guard, the owner told why; turned off by a person, it warns until double", async () => {
	analytics.rowsWritten = 25_000_000;
	await hourly();
	assert.equal(await switchedOn(), true);
	assert.deepEqual(await events(), ["spend_tripped", "maintenance_on"]);
	assert.ok(toOwner().includes("Spend past the budget: $25.00 in 24 hours"));
	assert.ok(toOwner().includes("The API is down for maintenance"));

	const owner = await byGitHub(OWNER, "admin");

	assert.equal((await owner.call("POST", "/admin/maintenance", { "turn": "off" })).status, 200);
	await hourly();
	assert.equal(await switchedOn(), false, "a person overruled it: no trip again at $25");

	analytics.rowsWritten = 45_000_000;
	await hourly();
	assert.equal(await switchedOn(), true, "but at double the budget, yes");
});

test("when it can't read the analytics three hours running, the owner is told the guard is blind, once", async () => {
	analytics.down = true;
	await hourly();
	await hourly();
	assert.deepEqual(toOwner(), []);
	await hourly();
	await hourly();
	assert.deepEqual(toOwner(), ["The cost guard can't read Cloudflare's analytics"]);
	// The row itself: the previous test's "on" may still be cached in this isolate for up to 10 seconds.
	assert.equal((await env.DB.prepare("SELECT switched_on FROM maintenance").first<{ "switched_on": number }>())?.switched_on, 0, "blind isn't a trip");
});
