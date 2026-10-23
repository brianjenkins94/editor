import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import type { Answer } from "./helpers.ts";
import { someone, testBrowser } from "./helpers.ts";

// The narrower switches (README.md, O8) in workerd: the owner pauses one part of the API from the admin app (new
// accounts, emailed codes, the GitHub proxy); that part refuses, saying so, while the rest carries on; every flip is
// audited and emailed to the owner, and /status says what's paused.

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

const { at, browse, app, form, byEmail, byGitHub, codeFor } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

const toOwner = (): typeof outbox => outbox.filter((message) => message.to === ALERT_EMAIL);

const flips = async (): Promise<string[][]> => (await env.DB.prepare("SELECT event, reason FROM audit WHERE event IN ('switch_paused', 'switch_resumed') ORDER BY id").all<{ "event": string; "reason": string }>()).results.map((row) => [row.event, row.reason]);

const flip = async (owner: Awaited<ReturnType<typeof byGitHub>>, name: string, turn: "pause" | "resume", reason?: string): Promise<Answer> => owner.call("POST", "/admin/switches", { "name": name, "turn": turn, ...reason === undefined ? {} : { "reason": reason } });

const status = async (): Promise<unknown> => (await browse(at("/status"))).json();

test("emailed codes paused: no code goes out, the sign-in page stops offering email; GitHub carries on; resumed, as before", async () => {
	const owner = await byGitHub(OWNER, "admin");
	const viewer = await byGitHub(VIEWER, "admin");

	assert.equal((await flip(viewer, "email-codes", "pause")).status, 403, "the owner's only");
	assert.equal((await flip(owner, "everything", "pause")).status, 400, "only the switches there are");
	assert.equal((await flip(owner, "email-codes", "pause", "codes flooding")).status, 200);
	assert.deepEqual(await status(), { "maintenance": false, "paused": ["email-codes"] });

	const signingIn = await app("editor");

	assert.deepEqual((await (await browse(at("/auth/attempt"), { "cookie": signingIn.cookie })).json() as { "methods": string[] }).methods.includes("email"), false, "not offered");

	const refused = await form("/auth/email", signingIn.cookie, { "address": someone() });

	assert.equal(refused.status, 503);
	assert.equal((await refused.json() as { "reason": string }).reason, "Emailed codes are paused for now. Sign in another way, or try again later.");
	assert.equal((await byGitHub(4242)).cookie !== "", true, "GitHub sign-in carries on");

	assert.equal((await flip(owner, "email-codes", "resume")).status, 200);
	assert.deepEqual(await status(), { "maintenance": false, "paused": [] });
	await byEmail(someone());
	assert.deepEqual(await flips(), [["switch_paused", "email-codes"], ["switch_resumed", "email-codes"]]);
	assert.deepEqual(toOwner().map((message) => message.subject), ["[unusually good local] Paused: Emailed codes", "[unusually good local] Resumed: Emailed codes"]);
	assert.match(toOwner()[0]?.text ?? "", /Why: codes flooding/u);
});

test("new accounts paused: a first sign-in by email or GitHub is refused, after the code; an existing account signs in as usual", async () => {
	const owner = await byGitHub(OWNER, "admin");
	const known = someone();

	await byEmail(known);
	assert.equal((await flip(owner, "sign-ups", "pause")).status, 200);

	// A new address: the code goes out (whether an account exists isn't said), and the account isn't made.
	const stranger = someone();
	const signingIn = await app("editor");

	await form("/auth/email", signingIn.cookie, { "address": stranger });

	const verified = await form("/auth/email/verify", signingIn.cookie, { "code": codeFor(stranger) });

	assert.equal(verified.status, 503);
	assert.equal((await verified.json() as { "reason": string }).reason, "New accounts are paused for now. If you already have one, sign in with it.");
	assert.equal(await env.DB.prepare("SELECT 1 FROM identities WHERE subject = ?").bind(stranger).first(), null, "no account made");

	// A new GitHub user: back to the app with temporarily_unavailable.
	const byNewGitHub = await app("editor");
	const toGitHub = new URL((await browse(at("/auth/github"), { "cookie": byNewGitHub.cookie })).headers.get("location") as string);

	github.id = 777_001;

	const landing = new URL((await browse(`${at("/auth/github/callback")}?${new URLSearchParams({ "code": "github-code", "state": toGitHub.searchParams.get("state") as string })}`, { "cookie": byNewGitHub.cookie })).headers.get("location") as string);

	assert.equal(landing.searchParams.get("error"), "temporarily_unavailable");
	assert.equal(await env.DB.prepare("SELECT 1 FROM identities WHERE provider = 'github' AND subject = '777001'").first(), null);

	// Known people: as usual.
	await byEmail(known);
	await byGitHub(4242);
	assert.equal((await flip(owner, "sign-ups", "resume")).status, 200);
	await byEmail(stranger);
});

test("the GitHub proxy paused: its calls and cloning refused, saying so; the rest of the API carries on", async () => {
	const owner = await byGitHub(OWNER, "admin");
	const editor = await byGitHub(4242);

	assert.equal((await flip(owner, "github-proxy", "pause")).status, 200);

	const call = await editor.call("GET", "/github/api/user");

	assert.equal(call.status, 503);
	assert.deepEqual(await call.json(), { "error": "paused", "switch": "github-proxy", "reason": "Reaching GitHub through the API is paused for now." });
	assert.equal((await editor.call("GET", "/github/git/octocat/hello.git/info/refs?service=git-upload-pack")).status, 503);
	assert.equal((await editor.call("GET", "/account")).status, 200, "the rest carries on");
	const me = await (await owner.call("GET", "/admin/me")).json() as { "switches": { "name": string; "what": string; "paused": { "by": string } | null }[] };

	assert.deepEqual(me.switches.map((each) => [each.name, each.what, each.paused !== null]), [["sign-ups", "New accounts", false], ["email-codes", "Emailed codes", false], ["github-proxy", "The GitHub proxy", true]], "the admin app sees them all");
	assert.match(me.switches[2]?.paused?.by ?? "", /^user:/u);

	assert.equal((await flip(owner, "github-proxy", "resume")).status, 200);
	assert.notEqual((await editor.call("GET", "/github/api/user")).status, 503);
});
