import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import { fingerprintOf, scrub, SURGE } from "../src/errors.ts";
import { someone, testBrowser } from "./helpers.ts";

// Errors (OPERATIONS.md, O4) in workerd: a request that fails answers with an id the person can quote; the error is
// recorded under it, grouped, redacted, with its route, release and sign-in; the owner hears of a new group and of a
// surge; the admin app finds it by group or by the quoted id.

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
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": `${standIn}/outbox`, "GITHUB_ORIGIN": standIn, "GITHUB_API": standIn, "CLOUDFLARE_API": "http://127.0.0.1:9", "RELEASE": "abc1234" } }] });
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

const toOwner = (): string[] => outbox.filter((message) => message.to === ALERT_EMAIL).map((message) => message.subject.replace(/^\[unusually good local\] /u, ""));

test("scrubbing keeps secrets and addresses out; a fingerprint ignores line numbers but not functions", async () => {
	assert.equal(scrub("no account for someone@example.com, token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", 500), "no account for «email», token «redacted»");

	const stack = (line: number): string => `TypeError: x\n    at accountEndpoint (worker.js:${line}:10)\n    at async dispatch (worker.js:${line + 5}:3)`;

	assert.equal(await fingerprintOf("api", "TypeError", stack(100), "GET /account"), await fingerprintOf("api", "TypeError", stack(900), "GET /account"));
	assert.notEqual(await fingerprintOf("api", "TypeError", stack(100), "GET /account"), await fingerprintOf("api", "TypeError", "TypeError: x\n    at otherEndpoint (worker.js:1:1)", "GET /account"));
});

test("a failing request answers with an id; the error is recorded under it, grouped; the owner hears of it once; the admin app finds it", async () => {
	const editor = await byEmail(someone());
	const me = (await (await editor.call("GET", "/account")).json() as { "user": string }).user;

	// A table the account page reads, gone: the request fails as a bug would.
	await env.DB.prepare("ALTER TABLE passkeys RENAME TO passkeys_away").run();

	try {
		const failed = await editor.call("GET", "/account");
		const answer = await failed.json() as { "error": string; "id": string };

		assert.equal(failed.status, 500);
		assert.equal(answer.error, "internal");
		assert.match(answer.id, /^E-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);

		const again = await (await editor.call("GET", "/account")).json() as { "id": string };

		assert.notEqual(again.id, answer.id, "an id per occurrence");

		const occurrence = await env.DB.prepare("SELECT o.route, o.release, o.user_id, o.grant_id, o.message, e.count, e.source FROM error_occurrences o JOIN errors e ON e.fingerprint = o.fingerprint WHERE o.id = ?").bind(answer.id).first<{ "route": string; "release": string; "user_id": string; "grant_id": string | null; "message": string; "count": number; "source": string }>();

		assert.deepEqual([occurrence?.route, occurrence?.release, occurrence?.user_id, occurrence?.source, occurrence?.count], ["GET /account", "abc1234", me, "api", 2], "both in one group");
		assert.ok(occurrence?.grant_id !== null);
		assert.match(occurrence?.message ?? "", /passkeys/u);
		assert.deepEqual(toOwner().filter((subject) => subject.startsWith("New error")), ["New error: Error"], "a new group, once");

		// The admin app: by group, by the quoted id (however it's typed); a viewer reads too.
		const viewer = await byGitHub(VIEWER, "admin");
		const groups = await (await viewer.call("GET", "/admin/errors")).json() as { "errors": { "fingerprint": string; "count": number; "recent": number }[] };

		assert.equal(groups.errors.length, 1);
		assert.equal(groups.errors[0]?.recent, 2);

		const group = await (await viewer.call("GET", `/admin/errors/${groups.errors[0]?.fingerprint}`)).json() as { "occurrences": { "id": string }[] };

		assert.deepEqual(group.occurrences.map((one) => one.id).toSorted(), [answer.id, again.id].toSorted());

		const found = await viewer.call("GET", `/admin/errors/occurrence/${answer.id.toLowerCase().replaceAll("-", " ")}`);

		assert.equal(found.status, 200);
		assert.equal((await found.json() as { "occurrence": { "id": string; "stack": string | null } }).occurrence.id, answer.id);
		assert.equal((await editor.call("GET", "/admin/errors")).status, 403, "an editor token can't reach it");

		// A surge: the group reaching SURGE in an hour emails once more.
		for (let count = 2; count < SURGE; count += 1) {
			await editor.call("GET", "/account");
		}

		assert.ok(toOwner().includes(`Error surging: Error, ${SURGE} in an hour`));
		await editor.call("GET", "/account");
		assert.equal(toOwner().filter((subject) => subject.startsWith("Error surging")).length, 1, "once, as it's reached");
	} finally {
		await env.DB.prepare("ALTER TABLE passkeys_away RENAME TO passkeys").run();
	}

	const owner = await byGitHub(OWNER, "admin");

	assert.equal((await owner.call("GET", "/admin/errors/occurrence/E-AAAA-AAAA")).status, 404);
});
