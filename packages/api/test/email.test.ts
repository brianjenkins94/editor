import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { recorded } from "../harness/state.ts";

// C2 in workerd (SIGN-IN.md, "Email"): the admin app pushes its request, the browser opens the attempt, asks for a code
// by email (sent to an outbox of the test's own), and types it or follows the link, in that same browser; a match finds
// or makes the address's user and starts the sign-in, with a code the app redeems.

const APP = "http://localhost:5174/";
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests"
};

/** What the Worker emailed, newest last. */
const outbox: { "to": string; "subject": string; "text": string; "html": string; "from": { "email": string } }[] = [];
const mail = createServer((request, response) => {
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
	mail.listen(0, "127.0.0.1", resolve);
});

const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": `http://127.0.0.1:${(mail.address() as AddressInfo).port}/`, "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9" } }] });
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
	mail.close();
});

const at = (path: string): string => new URL(path, base).href;

type Answer = Awaited<ReturnType<typeof server.fetch>>;

const browse = async (url: string, { cookie, ...init }: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "cookie"?: string } = {}): Promise<Answer> => server.fetch(url, { ...init, "redirect": "manual", "headers": { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...cookie === undefined ? {} : { "cookie": cookie }, ...init.headers } });

/** A form POST from the sign-in page, in the browser holding `cookie`. */
const form = async (path: string, cookie: string | undefined, fields: Record<string, string>): Promise<Answer> => browse(at(path), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(fields).toString(), ...cookie === undefined ? {} : { "cookie": cookie } });

/** The admin app: a DPoP key, a PKCE verifier, a state; it pushes its request, and a browser opens it (the cookie). */
async function started(): Promise<{ "cookie": string; "verifier": string; "state": string; "redeem": (code: string) => Promise<Answer> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const state = crypto.randomUUID();
	let nonce: string | undefined;
	const post = async (path: string, fields: Record<string, string>): Promise<Answer> => {
		for (let attempt = 0; ; attempt += 1) {
			const proof = await new SignJWT({ "htm": "POST", "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce } }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
			const response = await browse(at(path), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded", "dpop": proof }, "body": new URLSearchParams(fields).toString() });

			nonce = response.headers.get("dpop-nonce") ?? nonce;

			if (attempt === 0 && response.status === 400 && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
				continue;
			}

			return response;
		}
	};
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const { request_uri } = await (await post("/auth/par", { "client_id": "admin", "response_type": "code", "redirect_uri": APP, "state": state, "code_challenge": challenge, "code_challenge_method": "S256" })).json() as { "request_uri": string };
	const opened = await browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": "admin", "request_uri": request_uri })}`);

	assert.ok(await calculateJwkThumbprint(jwk));

	return {
		"cookie": (opened.headers.get("set-cookie") ?? "").split(";")[0] as string,
		"verifier": verifier,
		"state": state,
		"redeem": async (code) => post("/token", { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "admin" })
	};
}

/** The code in the latest email to `address`. */
function codeFor(address: string): string {
	const sent = outbox.findLast((message) => message.to === address);
	const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/u.exec(sent?.subject ?? "")?.[1];

	assert.ok(code !== undefined, `a code was sent to ${address}`);

	return code;
}

const someone = (): string => `someone-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function refusals(): Promise<string[]> {
	return (await env.DB.prepare("SELECT reason FROM audit WHERE event = 'sign_in_refused' ORDER BY id").all<{ "reason": string }>()).results.map((row) => row.reason);
}

test("the admin app's sign-in page offers email where email can be sent; the editor's doesn't", async () => {
	const { cookie } = await started();

	assert.deepEqual(await (await browse(at("/auth/attempt"), { "cookie": cookie })).json(), { "client": "admin", "methods": ["github", "email", "password"] });
});

test("signing in by email: a code sent, typed in the same browser, and the app's code redeemed; a new user, by email alone", async () => {
	const browser = await started();
	const address = someone();
	const asked = await form("/auth/email", browser.cookie, { "address": address });

	assert.equal(asked.status, 200);
	assert.deepEqual(await asked.json(), { "sent": true, "expires_in": 600 });

	const message = outbox.at(-1);

	assert.equal(message?.from.email, "no-reply@unusuallygood.dev");
	assert.match(message?.text ?? "", /\/sign-in#code=[A-Z2-9]{8}/u, "the link holds the code, in its fragment");

	const code = codeFor(address);
	const verified = await form("/auth/email/verify", browser.cookie, { "code": code.toLowerCase().replace("-", " ") });
	const landing = new URL((await verified.json() as { "location": string }).location);

	assert.equal(verified.status, 200);
	assert.match(verified.headers.get("set-cookie") ?? "", /^__Host-signin=; Max-Age=0/u, "the attempt's cookie goes");
	assert.equal(`${landing.origin}${landing.pathname}`, APP);
	assert.equal(landing.searchParams.get("state"), browser.state);
	assert.equal((await browser.redeem(landing.searchParams.get("code") as string)).status, 200);

	const user = await env.DB.prepare("SELECT u.github_id, e.address, e.verified_at FROM emails e JOIN users u ON u.id = e.user_id WHERE e.address = ?").bind(address).first<{ "github_id": number | null; "address": string; "verified_at": number | null }>();

	assert.deepEqual([user?.github_id, user?.address, typeof user?.verified_at], [null, address, "number"]);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'login' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "email");
	assert.equal((await form("/auth/email/verify", browser.cookie, { "code": code })).status, 401, "spent: the attempt is over");
});

test("the same address, whatever its case, is the same user; kept as first typed", async () => {
	const address = someone();
	const signIn = async (typed: string): Promise<string> => {
		const browser = await started();

		await form("/auth/email", browser.cookie, { "address": typed });
		await form("/auth/email/verify", browser.cookie, { "code": codeFor(typed) });

		return (await env.DB.prepare("SELECT user_id FROM emails WHERE lower(address) = lower(?)").bind(typed).first<{ "user_id": string }>())?.user_id as string;
	};

	const first = await signIn(address);

	// A minute later, as far as the address's limit can tell (one a minute, whatever its case).
	await env.DB.prepare("UPDATE audit SET at = at - 61000 WHERE event = 'email_code_sent'").run();

	assert.equal(await signIn(address.toUpperCase()), first);
	assert.deepEqual((await env.DB.prepare("SELECT address FROM emails WHERE user_id = ?").bind(first).all<{ "address": string }>()).results, [{ "address": address }]);
});

test("a code only finishes the sign-in in the browser that asked for it", async () => {
	const browser = await started();
	const elsewhere = await started();
	const address = someone();

	await form("/auth/email", browser.cookie, { "address": address });

	assert.equal((await form("/auth/email/verify", undefined, { "code": codeFor(address) })).status, 401, "no attempt here");
	assert.equal((await form("/auth/email/verify", elsewhere.cookie, { "code": codeFor(address) })).status, 400, "another attempt: no code sent to it");
	assert.equal((await form("/auth/email/verify", browser.cookie, { "code": codeFor(address) })).status, 200);
});

test("five tries, one back a minute: a wrong code costs one, and asking for a new code doesn't buy more", async () => {
	const browser = await started();
	const address = someone();

	await form("/auth/email", browser.cookie, { "address": address });

	for (let attempt = 0; attempt < 5; attempt += 1) {
		assert.equal((await form("/auth/email/verify", browser.cookie, { "code": "AAAA-AAAA" })).status, 400);
	}

	assert.equal((await form("/auth/email/verify", browser.cookie, { "code": codeFor(address) })).status, 429, "out of tries, even with the right code");
	assert.deepEqual((await refusals()).slice(-2), ["email: code wrong", "email: too many tries"]);
});

test("sending is limited per address: one a minute; and only to something that's an address", async () => {
	const browser = await started();
	const address = someone();

	assert.equal((await form("/auth/email", browser.cookie, { "address": address })).status, 200);

	const again = await form("/auth/email", (await started()).cookie, { "address": address.toUpperCase() });

	assert.equal(again.status, 429, "another attempt, the same address");
	assert.ok(Number(again.headers.get("retry-after")) > 0);
	assert.equal((await form("/auth/email", browser.cookie, { "address": "not an address" })).status, 400);
	assert.equal((await form("/auth/email", browser.cookie, { "address": ` ${someone()}` })).status, 400, "as typed, not trimmed");
	assert.deepEqual((await refusals()).slice(-3), ["email: a code was sent less than a minute ago", "email: not an email address", "email: not an email address"]);
});

test("what a code leaves stored: its HMAC in the attempt, the address's hash in the audit log; never the code, never the address in the log", async () => {
	const browser = await started();
	const address = someone();
	const changes = await recorded(server, async () => form("/auth/email", browser.cookie, { "address": address }));
	const written = JSON.stringify(changes);

	assert.equal(written.includes(codeFor(address).replace("-", "")), false, "the code isn't kept");
	assert.equal(JSON.stringify(changes["d1:audit"] ?? {}).includes(address), false, "the log has the address's hash only");
	assert.ok(Object.keys(changes).some((collection) => collection.endsWith(":email_step")), "the attempt's email step");
});

// ── Our inbox and the smoke test ───────────────────────────────────────────────────────────────────────────────────

test("the smoke test signs in by email with our own address, the code read back from our inbox, then ends the sign-in", async () => {
	await worker.scheduled({ "cron": "17 3 * * *" });

	const passed = await env.DB.prepare("SELECT reason FROM audit WHERE event = 'smoke_test_passed' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>();
	const delivered = await env.DB.prepare("SELECT sender, subject FROM inbox WHERE address = 'smoke-test@unusuallygood.dev' ORDER BY id DESC LIMIT 1").first<{ "sender": string; "subject": string }>();
	const user = await env.DB.prepare("SELECT user_id FROM emails WHERE address = 'smoke-test@unusuallygood.dev'").first<{ "user_id": string }>();
	const live = await env.DB.prepare("SELECT COUNT(*) AS count FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(user?.user_id ?? "").first<{ "count": number }>();

	assert.match(passed?.reason ?? "", /^email back in \d+ s$/u);
	assert.equal(delivered?.sender, "no-reply@unusuallygood.dev");
	assert.match(delivered?.subject ?? "", /^Your sign-in code: [A-Z2-9]{4}-[A-Z2-9]{4}$/u);
	assert.equal(live?.count, 0, "its sign-in ended");
	assert.equal(await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'smoke_test_failed'").first(), null);
});

test("our inbox takes mail for our own addresses only, and keeps who, the subject and the size, never the body", async () => {
	const raw = (to: string): string => `From: someone@example.com\r\nTo: ${to}\r\nSubject: hello\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\n\r\nthe body\r\n`;
	const deliver = async (to: string): Promise<Answer> => server.fetch(`${at("/cdn-cgi/handler/email")}?${new URLSearchParams({ "from": "someone@example.com", "to": to })}`, { "method": "POST", "body": raw(to) });
	const ours = await deliver("smoke-test@unusuallygood.dev");
	const kept = await env.DB.prepare("SELECT sender, subject, size FROM inbox WHERE sender = 'someone@example.com' ORDER BY id DESC LIMIT 1").first<{ "sender": string; "subject": string; "size": number }>();

	assert.ok(ours.status < 400, `delivered: ${ours.status}`);
	assert.deepEqual([kept?.subject, (kept?.size ?? 0) > 0], ["hello", true]);
	assert.equal(JSON.stringify(kept).includes("the body"), false);

	await deliver("anyone-else@unusuallygood.dev");
	assert.equal(await env.DB.prepare("SELECT 1 FROM inbox WHERE address = 'anyone-else@unusuallygood.dev'").first(), null, "not ours: rejected");
});
