import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";
import type { Answer, App, Client } from "./helpers.ts";
import { testBrowser, PAGES, someone } from "./helpers.ts";

// Passkeys (README.md, "Passkeys") in workerd, with a software authenticator of the test's own (a P-256 key, and the
// bytes a device would send): added from the account through our passkey page, then signing in with one; bound to our
// host and origin, to the sign-in that asked, each challenge once; and a passkey sign-in holding the owner's role.

const EDITOR = PAGES.editor;
const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"CODE_KEY": "code key for the tests",
	"TOTP_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
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

const { at, form, app, byEmail, byGitHub } = testBrowser(server, () => base, { outbox, github, "db": () => env.DB });

// ── A software authenticator ───────────────────────────────────────────────────────────────────────────────────────

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const joined = new Uint8Array(new ArrayBuffer(parts.reduce((total, part) => total + part.length, 0)));
	let offset = 0;

	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}

	return joined;
};

/** An ECDSA signature as WebAuthn sends it: ASN.1 DER, not WebCrypto's r‖s. */
function der(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (value: Uint8Array): Uint8Array => {
		let start = 0;

		while (start < value.length - 1 && value[start] === 0) {
			start += 1;
		}

		const trimmed = value.slice(start);
		const padded = (trimmed[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;

		return concat(new Uint8Array([0x02, padded.length]), padded);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));

	return concat(new Uint8Array([0x30, body.length]), body);
}

/** A device holding one passkey: it makes it (`create`) and signs in with it (`get`), for `origin` and its host. */
async function device(origin = new URL(at("/")).origin): Promise<{ "create": (options: { "challenge": string; "rp": { "id": string } }) => Promise<string>; "get": (options: { "challenge": string; "rpId": string }) => Promise<string>; "id": string }> {
	const keys = await crypto.subtle.generateKey({ "name": "ECDSA", "namedCurve": "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
	const id = crypto.getRandomValues(new Uint8Array(16));
	const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]));
	let count = 0;
	const clientData = (type: string, challenge: string): Uint8Array<ArrayBuffer> => concat(new TextEncoder().encode(JSON.stringify({ "type": type, "challenge": challenge, "origin": origin, "crossOrigin": false })));
	const flags = 0x01 | 0x04; // user present, user verified

	return {
		"id": isoBase64URL.fromBuffer(id),
		"create": async (options) => {
			const authData = concat(await sha256(new TextEncoder().encode(options.rp.id)), new Uint8Array([flags | 0x40, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
			const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as Parameters<typeof isoCBOR.encode>[0]);

			return JSON.stringify({ "id": isoBase64URL.fromBuffer(id), "rawId": isoBase64URL.fromBuffer(id), "type": "public-key", "clientExtensionResults": {}, "response": { "clientDataJSON": isoBase64URL.fromBuffer(clientData("webauthn.create", options.challenge)), "attestationObject": isoBase64URL.fromBuffer(attestation), "transports": ["internal"] } });
		},
		"get": async (options) => {
			count += 1;

			const authData = concat(await sha256(new TextEncoder().encode(options.rpId)), new Uint8Array([flags, 0, 0, 0, count]));
			const data = clientData("webauthn.get", options.challenge);
			const signature = der(new Uint8Array(await crypto.subtle.sign({ "name": "ECDSA", "hash": "SHA-256" }, keys.privateKey, concat(authData, await sha256(data)))));

			return JSON.stringify({ "id": isoBase64URL.fromBuffer(id), "rawId": isoBase64URL.fromBuffer(id), "type": "public-key", "clientExtensionResults": {}, "response": { "clientDataJSON": isoBase64URL.fromBuffer(data), "authenticatorData": isoBase64URL.fromBuffer(authData), "signature": isoBase64URL.fromBuffer(signature) } });
		}
	};
}

type Device = Awaited<ReturnType<typeof device>>;

/** Adding `key` to `signedIn`'s account: the app asks, our page makes it and registers it, the app finishes. */
async function addPasskey(signedIn: App, key: Device): Promise<{ "status": number; "code": string }> {
	const asked = await signedIn.call("POST", `${signedIn.prefix}/account/passkey`, { "return": `${signedIn.page}#/account` });

	assert.equal(asked.status, 200);

	const page = new URL((await asked.json() as { "location": string }).location);

	assert.equal(`${page.origin}${page.pathname}`, at("/passkey"), "made on our own page");

	const fragment = new URLSearchParams(page.hash.slice(1));
	const registered = await form("/passkey/register", undefined, { "ticket": fragment.get("ticket") as string, "credential": await key.create(JSON.parse(fragment.get("options") as string) as { "challenge": string; "rp": { "id": string } }) });

	assert.equal(registered.status, 200);

	const back = new URL((await registered.json() as { "location": string }).location);

	assert.equal(back.hash, "#/account", "back to the app's page");

	const code = back.searchParams.get("passkey") as string;

	return { "status": (await signedIn.call("POST", `${signedIn.prefix}/account/passkey/finish`, { "passkey": code })).status, "code": code };
}

/** Signing in with `key` through the sign-in page, for `client`: the app holding the tokens, or the refusal. */
async function withPasskey(key: Device, client: Client = "editor"): Promise<{ "app": App; "answer": Answer }> {
	const signingIn = await app(client);
	const options = await (await form("/auth/passkey/options", signingIn.cookie, {})).json() as { "challenge": string; "rpId": string };
	const answer = await form("/auth/passkey", signingIn.cookie, { "credential": await key.get(options) });

	if (answer.status === 200) {
		await signingIn.redeem(new URL((await answer.clone().json() as { "location": string }).location).searchParams.get("code") as string);
	}

	return { "app": signingIn, "answer": answer };
}

const userOf = async (signedIn: App): Promise<string> => (await (await signedIn.call("GET", `${signedIn.prefix}/account`)).json() as { "user": string }).user;

test("a passkey is added from the account, made on our own page, finished by the sign-in that asked; then it signs in on its own", async () => {
	const editor = await byEmail(someone());
	const key = await device();
	const added = await addPasskey(editor, key);

	assert.equal(added.status, 200);

	const account = await (await editor.call("GET", "/account")).json() as { "passkeys": { "id": string; "synced": boolean }[] };

	assert.deepEqual(account.passkeys.map((passkey) => passkey.id), [key.id]);

	const { "app": again, answer } = await withPasskey(key);

	assert.equal(answer.status, 200);
	assert.equal(await userOf(again), await userOf(editor));
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'login' ORDER BY id DESC LIMIT 1").first<{ "reason": string }>())?.reason, "passkey");
	assert.equal(typeof (await env.DB.prepare("SELECT last_used_at FROM passkeys WHERE id = ?").bind(key.id).first<{ "last_used_at": number | null }>())?.last_used_at, "number");
});

test("adding one: only the sign-in that asked finishes it, once; the page's ticket works once; a passkey for another origin is refused", async () => {
	const editor = await byEmail(someone());
	const asked = await editor.call("POST", "/account/passkey", { "return": `${EDITOR}#/account` });
	const fragment = new URLSearchParams(new URL((await asked.json() as { "location": string }).location).hash.slice(1));
	const options = JSON.parse(fragment.get("options") as string) as { "challenge": string; "rp": { "id": string } };
	const ticket = fragment.get("ticket") as string;

	assert.equal((await form("/passkey/register", undefined, { "ticket": ticket, "credential": await (await device("https://evil.example")).create(options) })).status, 400, "made for another origin");

	const registered = await form("/passkey/register", undefined, { "ticket": ticket, "credential": await (await device()).create(options) });
	const code = new URL((await registered.json() as { "location": string }).location).searchParams.get("passkey") as string;

	assert.equal((await form("/passkey/register", undefined, { "ticket": ticket, "credential": await (await device()).create(options) })).status, 400, "the ticket once");

	const stranger = await byEmail(someone());

	assert.equal((await stranger.call("POST", "/account/passkey/finish", { "passkey": code })).status, 400, "another sign-in can't finish it");
	assert.equal((await editor.call("POST", "/account/passkey/finish", { "passkey": code })).status, 200);
	assert.equal((await editor.call("POST", "/account/passkey/finish", { "passkey": code })).status, 400, "once");
	assert.equal((await editor.call("POST", "/account/passkey", { "return": "https://evil.example/" })).status, 400, "back only to the app's pages");
});

test("signing in: each challenge once, the passkey's signature checked, an unknown or removed passkey refused", async () => {
	const editor = await byEmail(someone());
	const key = await device();

	await addPasskey(editor, key);

	// The same answer twice: the challenge was spent the first time.
	const signingIn = await app("editor");
	const options = await (await form("/auth/passkey/options", signingIn.cookie, {})).json() as { "challenge": string; "rpId": string };
	const credential = await key.get(options);

	assert.equal((await form("/auth/passkey", signingIn.cookie, { "credential": credential })).status, 200);

	const replay = await app("editor");

	await form("/auth/passkey/options", replay.cookie, {});
	assert.equal((await form("/auth/passkey", replay.cookie, { "credential": credential })).status, 400, "another challenge: the old answer doesn't match it");

	// A passkey that isn't ours; a tampered signature.
	assert.equal((await withPasskey(await device())).answer.status, 400);

	const tampered = await app("editor");
	const asked = await (await form("/auth/passkey/options", tampered.cookie, {})).json() as { "challenge": string; "rpId": string };
	const answer = JSON.parse(await key.get(asked)) as { "response": { "signature": string } };

	answer.response.signature = isoBase64URL.fromBuffer(der(crypto.getRandomValues(new Uint8Array(64))));
	assert.equal((await form("/auth/passkey", tampered.cookie, { "credential": JSON.stringify(answer) })).status, 400);

	// Removed (a recent sign-in, which this is): it signs in no more.
	assert.equal((await editor.call("POST", "/account/passkey/remove", { "id": key.id })).status, 200);
	assert.equal((await withPasskey(key)).answer.status, 400);
});

test("a passkey sign-in holds the owner's role, as GitHub's does", async () => {
	const admin = await byGitHub(OWNER, "admin");
	const key = await device();

	assert.equal((await addPasskey(admin, key)).status, 200);

	const { "app": byPasskey, answer } = await withPasskey(key, "admin");

	assert.equal(answer.status, 200);
	assert.deepEqual((await (await byPasskey.call("GET", "/admin/me")).json() as { "roles": string[] }).roles, ["owner"]);
});
