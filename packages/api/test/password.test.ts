import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { hashPassword, passwordProblem, verifyPassword } from "../src/password-hash.ts";
import { hotp, stepAt, unbase32 } from "../src/totp.ts";

// C3 in workerd (SIGN-IN.md, "Passwords"): someone who signed in by email sets a password from their account (a code to
// their email first, then the password, checked against known breaches by a stand-in of Have I Been Pwned), then signs
// in with it, as the admin app and a browser would.

const APP = "http://localhost:5174/";
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests",
	"TOTP_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
};

/** A password the breach stand-in knows: in 42 breaches. */
const BREACHED = "password1234";
let pwnedDown = false;
const outbox: { "to": string; "subject": string }[] = [];
const stand = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		// Have I Been Pwned's range API: suffixes of the SHA-1s that start with the prefix asked for, with counts.
		if (request.url?.startsWith("/range/") === true) {
			if (pwnedDown) {
				response.statusCode = 503;
				response.end();

				return;
			}

			const digest = nodeCrypto.createHash("sha1").update(BREACHED).digest("hex").toUpperCase();

			response.end(request.url.slice("/range/".length) === digest.slice(0, 5) ? `${digest.slice(5)}:42\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0` : "0018A45C4D1DEF81644B54AB7F969B88D65:0");

			return;
		}

		outbox.push(JSON.parse(body) as typeof outbox[number]);
		response.statusCode = 202;
		response.end();
	});
});

await new Promise<void>((resolve) => {
	stand.listen(0, "127.0.0.1", resolve);
});

const standIn = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "EMAIL_OUTBOX": `${standIn}/outbox`, "PWNED_API": standIn, "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9", "CLOUDFLARE_API": "http://127.0.0.1:9" } }] });
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

const at = (path: string): string => new URL(path, base).href;

type Answer = Awaited<ReturnType<typeof server.fetch>>;

const browse = async (url: string, { cookie, ...init }: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "cookie"?: string } = {}): Promise<Answer> => server.fetch(url, { ...init, "redirect": "manual", "headers": { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...cookie === undefined ? {} : { "cookie": cookie }, ...init.headers } });

const form = async (path: string, cookie: string, fields: Record<string, string>): Promise<Answer> => browse(at(path), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(fields).toString(), "cookie": cookie });

/** The admin app: a DPoP key, a PKCE verifier; it pushes its request, a browser opens it (the cookie); `call` sends a
 *  request with the key's proof (and the access token, when it has one). */
async function app(): Promise<{ "cookie": string; "redeem": (code: string) => Promise<string>; "call": (method: string, path: string, fields?: Record<string, string>) => Promise<Answer> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	let nonce: string | undefined;
	let token: string | undefined;
	const call = async (method: string, path: string, fields?: Record<string, string>): Promise<Answer> => {
		for (let attempt = 0; ; attempt += 1) {
			const ath = token === undefined ? {} : { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))) };
			const proof = await new SignJWT({ "htm": method, "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...ath }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
			const response = await browse(at(path), { "method": method, "headers": { "dpop": proof, ...token === undefined ? {} : { "authorization": `DPoP ${token}` }, ...fields === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } }, ...fields === undefined ? {} : { "body": new URLSearchParams(fields).toString() } });

			nonce = response.headers.get("dpop-nonce") ?? nonce;

			if (attempt === 0 && (response.status === 400 || response.status === 401) && (await response.clone().json().catch(() => ({})) as { "error"?: string }).error === "use_dpop_nonce") {
				continue;
			}

			return response;
		}
	};
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const { request_uri } = await (await call("POST", "/auth/par", { "client_id": "admin", "response_type": "code", "redirect_uri": APP, "state": "s", "code_challenge": challenge, "code_challenge_method": "S256" })).json() as { "request_uri": string };
	const opened = await browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": "admin", "request_uri": request_uri })}`);

	return {
		"cookie": (opened.headers.get("set-cookie") ?? "").split(";")[0] as string,
		"redeem": async (code) => {
			const tokens = await (await call("POST", "/token", { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "admin" })).json() as { "access_token": string };

			token = tokens.access_token;

			return token;
		},
		"call": call
	};
}

function codeFor(address: string): string {
	const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/u.exec(outbox.findLast((message) => message.to === address)?.subject ?? "")?.[1];

	assert.ok(code !== undefined, `a code was sent to ${address}`);

	return code;
}

/** As the throttle on emailed codes can tell, a minute later. */
const aMinuteLater = async (): Promise<void> => {
	await env.DB.prepare("UPDATE audit SET at = at - 61000 WHERE event = 'email_code_sent'").run();
};

/** Signed in to the admin app by an emailed code: a new account for `address`, and the app holding its tokens. */
async function signedInByEmail(address: string): Promise<Awaited<ReturnType<typeof app>>> {
	const signedIn = await app();

	await form("/auth/email", signedIn.cookie, { "address": address });

	const { location } = await (await form("/auth/email/verify", signedIn.cookie, { "code": codeFor(address) })).json() as { "location": string };

	await signedIn.redeem(new URL(location).searchParams.get("code") as string);
	await aMinuteLater();

	return signedIn;
}

const someone = (): string => `someone-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function refusals(): Promise<string[]> {
	return (await env.DB.prepare("SELECT reason FROM audit WHERE event IN ('sign_in_refused', 'auth_refused') ORDER BY id").all<{ "reason": string }>()).results.map((row) => row.reason);
}

/** Set `password` on the signed-in account: a code to its email, then the code and the password. */
async function setPassword(signedIn: Awaited<ReturnType<typeof app>>, address: string, password: string): Promise<Answer> {
	assert.equal((await signedIn.call("POST", "/admin/account/password/code", {})).status, 200);
	await aMinuteLater();

	return signedIn.call("POST", "/admin/account/password", { "code": codeFor(address), "password": password });
}

// ── The hash ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("a password's hash is Argon2id at OWASP's baseline, the same as Node's own, and verifies only the right password", async () => {
	const phc = await hashPassword("correct horse battery staple");
	const [, kind, version, costs, salt = "", hash = ""] = phc.split("$");
	const node = (nodeCrypto as unknown as { "argon2Sync": (algorithm: string, parameters: Record<string, unknown>) => Uint8Array }).argon2Sync("argon2id", { "message": "correct horse battery staple", "nonce": Buffer.from(salt, "base64"), "parallelism": 1, "tagLength": 32, "memory": 19_456, "passes": 2 });

	assert.deepEqual([kind, version, costs], ["argon2id", "v=19", "m=19456,t=2,p=1"]);
	assert.equal(Buffer.from(hash, "base64").toString("hex"), Buffer.from(node).toString("hex"));
	assert.equal(await verifyPassword("correct horse battery staple", phc), true);
	assert.equal(await verifyPassword("correct horse battery stapl", phc), false);
});

test("the rules: 10 to 100 printable ASCII characters, no space at either end, said plainly", () => {
	assert.equal(passwordProblem("short"), "shorter than 10 characters");
	assert.equal(passwordProblem("x".repeat(101)), "longer than 100 characters");
	assert.equal(passwordProblem("pässwörter-lang"), "only letters, digits, spaces and the symbols on a US keyboard");
	assert.equal(passwordProblem(" leading space ok?"), "starts or ends with a space");
	assert.equal(passwordProblem("a perfectly fine passphrase"), undefined);
});

// ── Setting one, and signing in with it ────────────────────────────────────────────────────────────────────────────

test("an email account sets a password (a code to its email first), then signs in with it; the app's page offers it", async () => {
	const address = someone();
	const signedIn = await signedInByEmail(address);

	assert.deepEqual((await (await signedIn.call("GET", "/admin/account")).json() as { "password": unknown }).password, null);
	assert.equal((await setPassword(signedIn, address, "plum orchard at dusk 42")).status, 200);
	assert.match(outbox.at(-1)?.subject ?? "", /^Your code to set a password: /u);
	assert.equal(typeof (await (await signedIn.call("GET", "/admin/account")).json() as { "password": { "setAt": number } }).password.setAt, "number");
	assert.ok(await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'password_set'").first());

	const browser = await app();

	assert.deepEqual(await (await browse(at("/auth/attempt"), { "cookie": browser.cookie })).json(), { "client": "admin", "methods": ["github", "email", "password"] });

	const signIn = await form("/auth/password", browser.cookie, { "address": address.toUpperCase(), "password": "plum orchard at dusk 42" });
	const { location } = await signIn.json() as { "location": string };

	assert.equal(signIn.status, 200);
	assert.match(await browser.redeem(new URL(location).searchParams.get("code") as string), /^ey/u);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'login' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "password");

	const stored = JSON.stringify(await env.DB.prepare("SELECT * FROM passwords").all());

	assert.equal(stored.includes("plum orchard"), false, "only its hash");
});

test("a password in a known breach is refused, as is one that breaks a rule, without spending the code; the check failing refuses too", async () => {
	const address = someone();
	const signedIn = await signedInByEmail(address);

	assert.equal((await signedIn.call("POST", "/admin/account/password/code", {})).status, 200);

	const code = codeFor(address);
	const attempt = async (password: string): Promise<{ "status": number; "reason": string }> => {
		const response = await signedIn.call("POST", "/admin/account/password", { "code": code, "password": password });

		return { "status": response.status, "reason": (await response.json() as { "reason"?: string }).reason ?? "" };
	};

	assert.deepEqual(await attempt(BREACHED), { "status": 400, "reason": "found in 42 known breaches: choose another" });
	assert.deepEqual(await attempt("short"), { "status": 400, "reason": "shorter than 10 characters" });

	pwnedDown = true;
	assert.deepEqual(await attempt("an unbreached passphrase"), { "status": 503, "reason": "couldn't check it against known breaches: try again" });
	pwnedDown = false;

	assert.equal((await attempt("an unbreached passphrase")).status, 200, "the same code, still good");
});

test("signing in with a password: what's wrong is said; five tries, one back a minute, then even the right one waits", async () => {
	const address = someone();
	const signedIn = await signedInByEmail(address);

	await setPassword(signedIn, address, "harbor lights in fog 9");

	const browser = await app();
	const signIn = async (fields: Record<string, string>): Promise<{ "status": number; "reason": string }> => {
		const response = await form("/auth/password", browser.cookie, fields);

		return { "status": response.status, "reason": (await response.json() as { "reason"?: string }).reason ?? "" };
	};

	assert.deepEqual(await signIn({ "address": someone(), "password": "harbor lights in fog 9" }), { "status": 400, "reason": "no account with that email" });

	for (let attempt = 0; attempt < 5; attempt += 1) {
		assert.deepEqual(await signIn({ "address": address, "password": "harbor lights in fog 8" }), { "status": 400, "reason": "wrong password" });
	}

	assert.deepEqual(await signIn({ "address": address, "password": "harbor lights in fog 9" }), { "status": 429, "reason": "too many tries" });
	assert.ok((await refusals()).includes("password: wrong password"));
});

test("an email account without a password is told to use a code; setting one needs an email on the account", async () => {
	const address = someone();

	await signedInByEmail(address);

	const browser = await app();
	const response = await form("/auth/password", browser.cookie, { "address": address, "password": "whatever it might be" });

	assert.deepEqual([response.status, (await response.json() as { "reason": string }).reason], [400, "that account has no password: sign in with a code"]);
});

// ── Resetting it (C4) ──────────────────────────────────────────────────────────────────────────────────────────────

/** A reset in a fresh browser: the code asked for, then `fields` with it. */
async function reset(address: string, password: string, end: boolean): Promise<{ "browser": Awaited<ReturnType<typeof app>>; "response": Answer }> {
	const browser = await app();

	assert.equal((await form("/auth/reset", browser.cookie, { "address": address })).status, 200);
	await aMinuteLater();

	return { "browser": browser, "response": await form("/auth/reset/password", browser.cookie, { "address": address, "code": codeFor(address), "password": password, "end": end ? "true" : "" }) };
}

test("a forgotten password is reset from the sign-in page: a code to the email, a new password, every sign-in ended if asked; then signing in again", async () => {
	const address = someone();
	const signedIn = await signedInByEmail(address);

	await setPassword(signedIn, address, "first passphrase of many");

	const { browser, response } = await reset(address, "second passphrase of many", true);

	assert.match(outbox.at(-1)?.subject ?? "", /^Your code to reset your password: /u);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { "reset": true, "ended": 1 });
	assert.equal((await signedIn.call("GET", "/admin/account")).status, 401, "the sign-in that was open is over");
	assert.equal((await form("/auth/password", browser.cookie, { "address": address, "password": "second passphrase of many" })).status, 401, "the reset's attempt is spent: no session from it");
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'password_reset' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "every sign-in ended (1)");

	const again = await app();

	assert.equal((await form("/auth/password", again.cookie, { "address": address, "password": "first passphrase of many" })).status, 400, "the old password is gone");
	assert.equal((await form("/auth/password", again.cookie, { "address": address, "password": "second passphrase of many" })).status, 200);
});

test("a reset keeps other sign-ins when not asked to end them; a reset code works only in the browser that asked for it", async () => {
	const address = someone();
	const signedIn = await signedInByEmail(address);

	await setPassword(signedIn, address, "orchard gate at noon 3");

	const asker = await app();
	const other = await app();

	await form("/auth/reset", asker.cookie, { "address": address });
	await aMinuteLater();

	assert.equal((await form("/auth/reset/password", other.cookie, { "address": address, "code": codeFor(address), "password": "orchard gate at dusk 4" })).status, 400, "another browser: the code is bound to the one that asked");

	const kept = await form("/auth/reset/password", asker.cookie, { "address": address, "code": codeFor(address), "password": "orchard gate at dusk 4" });

	assert.deepEqual(await kept.json(), { "reset": true, "ended": 0 });
	assert.equal((await signedIn.call("GET", "/admin/account")).status, 200, "kept");
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'password_reset' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "other sign-ins kept");
});

test("there's nothing to reset for an account without a password, or no account", async () => {
	const address = someone();

	await signedInByEmail(address);

	const browser = await app();
	const ask = async (to: string): Promise<string> => (await (await form("/auth/reset", browser.cookie, { "address": to })).json() as { "reason": string }).reason;

	assert.equal(await ask(address), "that account has no password: sign in with a code");
	assert.equal(await ask(someone()), "no account with that email");
});

// ── Authenticator-app MFA (C5) ─────────────────────────────────────────────────────────────────────────────────────

test("TOTP is RFC 6238's: its SHA-1 test vectors", async () => {
	const secret = new TextEncoder().encode("12345678901234567890");

	for (const [time, code] of [[59, "94287082"], [1_111_111_109, "07081804"], [1_234_567_890, "89005924"], [20_000_000_000, "65353130"]] as const) {
		assert.equal(await hotp(secret, Math.floor(time / 30), 8), code, String(time));
	}
});

/** An authenticator app: the code for the step now, or `ahead` steps on (within the one-step window either side). */
const authenticator = (secret: string) => async (ahead = 0): Promise<string> => hotp(unbase32(secret), stepAt(Date.now()) + ahead);

/** An email account with MFA on: the app, and its recovery codes. */
async function withMfa(address: string): Promise<{ "signedIn": Awaited<ReturnType<typeof app>>; "app": (ahead?: number) => Promise<string>; "recovery": string[] }> {
	const signedIn = await signedInByEmail(address);
	const started = await (await signedIn.call("POST", "/admin/account/mfa/start", {})).json() as { "secret": string; "uri": string };
	const codeNow = authenticator(started.secret);

	assert.match(started.uri, /^otpauth:\/\/totp\/unusually%20good%3A.*\?secret=[A-Z2-7]+&issuer=unusually\+good&algorithm=SHA1&digits=6&period=30$/u);
	assert.equal((await signedIn.call("POST", "/admin/account/mfa/confirm", { "code": "000000" === await codeNow() ? "111111" : "000000" })).status, 400, "a wrong code doesn't turn it on");

	const confirmed = await (await signedIn.call("POST", "/admin/account/mfa/confirm", { "code": await codeNow() })).json() as { "recoveryCodes": string[] };

	assert.equal(confirmed.recoveryCodes.length, 10);

	return { "signedIn": signedIn, "app": codeNow, "recovery": confirmed.recoveryCodes };
}

/** An email sign-in up to its second step: the browser, and what verifying the code answered. */
async function firstFactorByEmail(address: string): Promise<{ "browser": Awaited<ReturnType<typeof app>>; "answer": Record<string, unknown> }> {
	const browser = await app();

	await aMinuteLater();
	await form("/auth/email", browser.cookie, { "address": address });

	return { "browser": browser, "answer": await (await form("/auth/email/verify", browser.cookie, { "code": codeFor(address) })).json() as Record<string, unknown> };
}

test("setting up two-factor: the app's QR code, a code to confirm, ten recovery codes shown once; the account says so", async () => {
	const address = someone();
	const { signedIn } = await withMfa(address);
	const account = await (await signedIn.call("GET", "/admin/account")).json() as { "mfa": { "recoveryLeft": number } };

	assert.equal(account.mfa.recoveryLeft, 10);
	assert.ok(await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'mfa_enrolled'").first());

	const stored = JSON.stringify((await env.DB.prepare("SELECT * FROM totp").all()).results);

	assert.equal(/"secret":"[A-Z2-7]{32}"/u.test(stored), false, "the secret is sealed");
});

test("signing in with two-factor on: the emailed code, then the app's code (each step once), and the sign-in says both", async () => {
	const address = someone();
	const { app: codeNow } = await withMfa(address);
	const { browser, answer } = await firstFactorByEmail(address);

	assert.deepEqual(answer, { "second_factor": true }, "no session yet");
	assert.equal((await form("/auth/second", browser.cookie, { "code": await codeNow() })).status, 400, "the step the setup used, used once already");

	const second = await form("/auth/second", browser.cookie, { "code": await codeNow(1) });
	const { location } = await second.json() as { "location": string };

	assert.equal(second.status, 200);
	assert.match(await browser.redeem(new URL(location).searchParams.get("code") as string), /^ey/u);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'login' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "email+totp");
});

test("a recovery code signs in once; the second step needs a first; a password sign-in asks for it too", async () => {
	const address = someone();
	const { signedIn, recovery } = await withMfa(address);
	const first = await firstFactorByEmail(address);

	assert.equal((await form("/auth/second", (await app()).cookie, { "code": recovery[0] as string })).status, 401, "no first factor in this browser");
	assert.equal((await form("/auth/second", first.browser.cookie, { "code": (recovery[0] as string).toLowerCase() })).status, 200);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'login' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "email+recovery");

	const again = await firstFactorByEmail(address);

	assert.equal((await form("/auth/second", again.browser.cookie, { "code": recovery[0] as string })).status, 400, "used");
	assert.equal((await (await signedIn.call("GET", "/admin/account")).json() as { "mfa": { "recoveryLeft": number } }).mfa.recoveryLeft, 9);

	await aMinuteLater();
	await setPassword(signedIn, address, "two factors are better 1");

	const byPassword = await app();

	assert.deepEqual(await (await form("/auth/password", byPassword.cookie, { "address": address, "password": "two factors are better 1" })).json(), { "second_factor": true });
});

test("with two-factor on, a reset needs it too; turning it off needs it, and a recent sign-in", async () => {
	const address = someone();
	const { signedIn, app: codeNow, recovery } = await withMfa(address);

	await setPassword(signedIn, address, "a password to forget 9");

	const browser = await app();

	await aMinuteLater();
	await form("/auth/reset", browser.cookie, { "address": address });

	const without = await form("/auth/reset/password", browser.cookie, { "address": address, "code": codeFor(address), "password": "a password remembered 9" });

	assert.equal((await without.json() as { "reason": string }).reason, "two-factor code needed: from your authenticator app, or a recovery code");
	assert.equal((await form("/auth/reset/password", browser.cookie, { "address": address, "code": codeFor(address), "password": "a password remembered 9", "second": recovery[1] as string })).status, 200);

	await env.DB.prepare("UPDATE grants SET created_at = created_at - 3600000").run();
	assert.equal((await signedIn.call("POST", "/admin/account/mfa/off", { "code": await codeNow(1) })).status, 403, "a sign-in more than 10 minutes old");
});

test("turning two-factor off, with a code from the app: sign-ins don't ask for it any more", async () => {
	const address = someone();
	const { signedIn, app: codeNow } = await withMfa(address);

	assert.equal((await signedIn.call("POST", "/admin/account/mfa/off", { "code": "123" })).status, 400);
	assert.equal((await signedIn.call("POST", "/admin/account/mfa/off", { "code": await codeNow(1) })).status, 200);
	assert.ok(await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'mfa_removed'").first());
	assert.ok("location" in (await firstFactorByEmail(address)).answer, "straight in");
});
