import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { differences, proxied } from "../src/behavior.ts";
import { BROWSER } from "./browser.ts";

// B7 (BEHAVIOR.md): actions as templates, probes, and a sign-in's client fingerprint, in workerd. Sign-ins start as the
// GitHub callback starts them (Grant.begin).

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
};
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9" } }] });
const worker = server.getWorker();
let base: URL;
let env: { "GRANTS": { "newUniqueId": () => DurableObjectId; "get": (id: DurableObjectId) => { "begin": (options: unknown) => Promise<{ "code": string }> } }; "DB": D1Database };

before(async () => {
	({ "url": base } = await server.listen());
	await worker.applyD1Migrations("DB");
	env = await worker.getEnv() as typeof env;
});

after(async () => {
	await server.close();
});

const at = (path: string): string => new URL(path, base).href;

type Answer = Awaited<ReturnType<typeof server.fetch>>;

interface Options { "form"?: Record<string, string>; "accessToken"?: string; "headers"?: Record<string, string>; "without"?: string[] }

/** A client with a DPoP key of its own, sending `client` headers (a browser's by default) unless a request says otherwise. */
async function client(headers: Record<string, string> = BROWSER): Promise<{ "jkt": string; "send": (method: string, path: string, options?: Options) => Promise<Answer> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;

	return {
		"jkt": await calculateJwkThumbprint(jwk),
		"send": async (method, path, { form, accessToken, "headers": extra = {}, without = [] } = {}) => {
			for (let attempt = 0; ; attempt += 1) {
				const ath = accessToken === undefined ? {} : { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)))) };
				const proof = await new SignJWT({ "htm": method, "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...ath }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
				const sent: Record<string, string> = { ...headers, ...extra, "dpop": proof, "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...accessToken === undefined ? {} : { "authorization": `DPoP ${accessToken}` }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };

				for (const name of without) {
					delete sent[name];
				}

				const response = await server.fetch(at(path), { "method": method, "headers": sent, ...form === undefined ? {} : { "body": new URLSearchParams(form).toString() } });

				nonce = response.headers.get("dpop-nonce") ?? nonce;

				if (attempt === 0 && (response.status === 400 || response.status === 401) && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
					continue;
				}

				return response;
			}
		}
	};
}

type Client = Awaited<ReturnType<typeof client>>;

/** Signed in as someone new, for `as`: its tokens and grant. */
async function signedIn(holder: Client, as = "editor"): Promise<{ "access_token": string; "refresh_token": string; "grantId": string }> {
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const id = env.GRANTS.newUniqueId();
	const { code } = await env.GRANTS.get(id).begin({ "client": as, "githubId": 1_000_000 + Math.floor(Math.random() * 1e9), "github": { "accessToken": "ghu_test", "refreshToken": "ghr_test", "expiresAt": Date.now() + 3_600_000, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": challenge, "jkt": holder.jkt, "from": { "country": null, "ipHash": null, "traceId": null } });
	const response = await holder.send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": as } });

	assert.equal(response.status, 200, await response.clone().text());

	return { ...await response.json() as { "access_token": string; "refresh_token": string }, "grantId": id.toString() };
}

async function rows(grantId: string, event: string): Promise<{ "reason": string | null; "detail": string | null }[]> {
	return (await env.DB.prepare("SELECT reason, detail FROM audit WHERE grant_id = ? AND event = ? ORDER BY id").bind(grantId, event).all<{ "reason": string | null; "detail": string | null }>()).results;
}

const CHROME_142 = BROWSER["user-agent"]?.replace("Chrome/141", "Chrome/142") as string;

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("a proxied call is its template: the query's names kept, every value left for the hash", () => {
	assert.deepEqual(proxied("api", "GET", "/repos/octo/hello/git/trees/main", "?recursive=1"), { "template": "GET /repos/:owner/:repo/git/trees/:ref?recursive", "repository": "octo/hello", "rest": "main\n?recursive=1" });
	assert.deepEqual(proxied("api", "GET", "/user", ""), { "template": "GET /user", "rest": "" });
	assert.equal(proxied("api", "DELETE", "/repos/octo/hello", ""), undefined, "a method the editor doesn't use");
	assert.equal(proxied("api", "GET", "/repos/octo/hello/git/ref/heads/../../secret", ""), undefined, "a ref can't climb");
	assert.equal(proxied("git", "GET", "/octo/hello.git/info/refs", "?service=git-receive-pack"), undefined, "never a push");
});

test("a route that doesn't exist, asked for while signed in, is a probe: 404, recorded with its path hashed", async () => {
	const holder = await client();
	const { access_token, grantId } = await signedIn(holder);

	assert.equal((await holder.send("GET", "/wp-admin/secret-thing", { "accessToken": access_token })).status, 404);
	assert.equal((await holder.send("DELETE", "/sessions", { "accessToken": access_token })).status, 404, "a method the route doesn't have");

	const probes = await rows(grantId, "probe");

	assert.deepEqual(probes.map((row) => row.detail?.split(" #")[0]), ["GET", "DELETE"]);
	assert.equal(JSON.stringify(probes).includes("wp-admin"), false, "what was guessed is only hashed");
});

test("a route the router has is never a probe, even when it answers 404; nor is a request with no credentials", async () => {
	const holder = await client();
	const { access_token, grantId } = await signedIn(holder);

	assert.equal((await holder.send("POST", `/sessions/${"0".repeat(64)}/revoke`, { "accessToken": access_token })).status, 404, "the route's own 404: not one of yours");
	assert.equal((await server.fetch(at("/wp-login.php"))).status, 404, "the web's background noise");
	assert.deepEqual(await rows(grantId, "probe"), []);
	assert.equal(await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'probe' AND grant_id IS NULL").first(), null);
});

test("probes count with the proxy's refusals: a few end the sign-in", async () => {
	const holder = await client();
	const { access_token, grantId } = await signedIn(holder);

	for (let attempt = 1; attempt <= 5; attempt += 1) {
		await holder.send("GET", `/guess/${attempt}`, { "accessToken": access_token });
	}

	assert.equal((await holder.send("GET", "/sessions", { "accessToken": access_token })).status, 401, "ended");
	assert.deepEqual((await rows(grantId, "proxy_abuse")).map((row) => row.reason), ["5 refused calls in 10 minutes"]);
});

test("an admin sign-in probing under /admin is a probe too", async () => {
	const holder = await client();
	const { access_token, grantId } = await signedIn(holder, "admin");

	assert.equal((await holder.send("GET", "/admin/export-everything", { "accessToken": access_token })).status, 404);
	assert.equal((await rows(grantId, "probe")).length, 1);
});

// ── A sign-in's client ─────────────────────────────────────────────────────────────────────────────────────────────

test("weighing a difference: what a browser update or a new release does is tolerated; a browser becoming something else is strong", () => {
	const known = { "origin": "o", "sec-fetch-mode": "m", "user-agent": "u141", "accept-language": "en", "browser": "Chrome", "major": "141", "os": "macOS" };
	const weigh = (now: Record<string, string | null>): string[] => differences(known, { ...known, ...now }).map((difference) => `${difference.strength}: ${difference.name} ${difference.kind}`);

	assert.deepEqual(weigh({ "sec-ch-ua": "new" }), ["tolerated: sec-ch-ua added"]);
	assert.deepEqual(weigh({ "user-agent": "u142", "major": "142" }), ["tolerated: user-agent changed", "tolerated: major changed"]);
	assert.deepEqual(weigh({ "origin": null }), ["strong: origin omitted"]);
	assert.deepEqual(weigh({ "user-agent": "u140", "major": "140" }), ["medium: user-agent changed", "strong: major changed"]);
	assert.deepEqual(weigh({ "browser": "Firefox" }), ["strong: browser changed"]);
	assert.deepEqual(weigh({ "accept-language": "de" }), ["medium: accept-language changed"]);
});

test("a sign-in that isn't a browser's from the start is recorded once, by what it didn't send", async () => {
	const script = await client({ "user-agent": "my-mcp-server/1.0" });
	const { access_token, grantId } = await signedIn(script);

	assert.equal((await script.send("GET", "/sessions", { "accessToken": access_token })).status, 200, "flagged, not refused");
	// Node's own fetch sends `sec-fetch-mode: cors` by itself: a missing Origin is what gives a script away.
	assert.deepEqual((await rows(grantId, "client_unusual")).map((row) => row.reason), ["not a browser: no origin"]);
	assert.deepEqual(await rows(await signedIn(await client()).then((browser) => browser.grantId), "client_unusual"), [], "a browser's isn't");
});

test("a sign-in's client changing: what matters is recorded the first time, by name and how; what's tolerated isn't", async () => {
	const holder = await client();
	const { access_token, grantId } = await signedIn(holder);
	const get = async (options: Options): Promise<number> => (await holder.send("GET", "/sessions", { "accessToken": access_token, ...options })).status;

	assert.equal(await get({ "headers": { "sec-ch-ua": "\"Chromium\";v=\"141\"" } }), 200);
	assert.equal(await get({ "headers": { "user-agent": CHROME_142 } }), 200);
	assert.deepEqual(await rows(grantId, "client_changed"), [], "a header added, the browser updated");

	assert.equal(await get({ "without": ["origin"] }), 200);
	assert.equal(await get({ "without": ["origin"] }), 200);
	assert.equal(await get({ "headers": { "sec-fetch-site": "cross-site" } }), 200);

	const changed = await rows(grantId, "client_changed");

	assert.deepEqual(changed.map((row) => row.reason), ["strong: origin omitted", "medium: sec-fetch-site changed"]);
	assert.equal(changed[0]?.detail, "GET /sessions");
	assert.equal(JSON.stringify(changed).includes("cross-site"), false, "never a value");
});

test("a refresh takes what's tolerated into how the client is known: the browser updated, going back is a downgrade", async () => {
	const holder = await client();
	const { refresh_token, grantId } = await signedIn(holder);

	const refreshed = await holder.send("POST", "/token", { "form": { "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": "editor" }, "headers": { "user-agent": CHROME_142 } });

	assert.equal(refreshed.status, 200);
	assert.equal((await holder.send("GET", "/sessions", { "accessToken": (await refreshed.json() as { "access_token": string }).access_token })).status, 200, "Chrome 141 again");
	assert.deepEqual((await rows(grantId, "client_changed")).map((row) => row.reason), ["medium: user-agent changed", "strong: major changed"]);
});
