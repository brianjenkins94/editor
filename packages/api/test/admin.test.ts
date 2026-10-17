import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { PERMISSIONS, permissionsOf } from "../src/rbac.ts";

// B1 in workerd (packages/admin/README.md): the admin client, the Grant remembering its client, /admin/* for admin tokens
// only, and roles from OWNERS. Sign-ins start as the GitHub callback starts them (Grant.begin), for either client.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
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

/** A browser with a DPoP key of its own; each request from an IP of its own, clear of the per-IP limits. */
async function browser(): Promise<{ "jkt": string; "send": (method: string, path: string, options?: { "form"?: Record<string, string>; "accessToken"?: string }) => Promise<Answer> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;
	const proof = async (method: string, url: string, claims: Record<string, unknown>): Promise<string> => new SignJWT({ "htm": method, "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...claims })
		.setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk })
		.sign(privateKey);

	return {
		"jkt": await calculateJwkThumbprint(jwk),
		"send": async (method, path, { form, accessToken } = {}) => {
			for (let attempt = 0; ; attempt += 1) {
				const ath = accessToken === undefined ? {} : { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)))) };
				const headers: Record<string, string> = { "dpop": await proof(method, at(path), ath), "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...accessToken === undefined ? {} : { "authorization": `DPoP ${accessToken}` }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };
				const response = await server.fetch(at(path), { "method": method, "headers": headers, ...form === undefined ? {} : { "body": new URLSearchParams(form).toString() } });

				nonce = response.headers.get("dpop-nonce") ?? nonce;

				if (attempt === 0 && (response.status === 400 || response.status === 401) && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
					continue;
				}

				return response;
			}
		}
	};
}

type Browser = Awaited<ReturnType<typeof browser>>;

/** A sign-in for GitHub user `githubId`, begun for `client` (undefined: as grants that predate clients were). */
async function begin(holder: Browser, githubId: number, client: string | undefined): Promise<{ "code": string; "verifier": string; "grantId": string }> {
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const id = env.GRANTS.newUniqueId();
	const { code } = await env.GRANTS.get(id).begin({ ...client === undefined ? {} : { "client": client }, "githubId": githubId, "github": { "accessToken": "ghu_test", "refreshToken": "ghr_test", "expiresAt": Date.now() + 3_600_000, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": challenge, "jkt": holder.jkt, "from": { "country": null, "ipHash": null, "traceId": null } });

	return { "code": code, "verifier": verifier, "grantId": id.toString() };
}

/** Signed in for `client`: its tokens. */
async function signedIn(holder: Browser, githubId: number, client: string): Promise<{ "access_token": string; "refresh_token": string; "grantId": string }> {
	const { code, verifier, grantId } = await begin(holder, githubId, client);
	const response = await holder.send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": client } });

	assert.equal(response.status, 200, await response.clone().text());

	return { ...await response.json() as { "access_token": string; "refresh_token": string }, "grantId": grantId };
}

const someone = (): number => 1_000_000 + Math.floor(Math.random() * 1e9);

async function refusals(grantId: string): Promise<string[]> {
	return (await env.DB.prepare("SELECT reason FROM audit WHERE grant_id = ? AND event IN ('auth_refused', 'token_rejected') ORDER BY id").bind(grantId).all<{ "reason": string }>()).results.map((row) => row.reason);
}

test("roles map to permissions: the owner holds every one, no role holds none", () => {
	assert.deepEqual(permissionsOf(["owner"]), [...PERMISSIONS]);
	assert.deepEqual(permissionsOf([]), []);
});

test("/admin/me: the owner, signed in to the admin app, is the owner with every permission", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const response = await holder.send("GET", "/admin/me", { "accessToken": access_token });
	const me = await response.json() as { "user": string; "roles": string[]; "permissions": string[] };

	assert.equal(response.status, 200);
	assert.deepEqual(me.roles, ["owner"]);
	assert.deepEqual(me.permissions, [...PERMISSIONS]);
});

test("/admin/me: anyone else signed in to the admin app has no roles and no permissions", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, someone(), "admin");
	const me = await (await holder.send("GET", "/admin/me", { "accessToken": access_token })).json() as { "roles": string[]; "permissions": string[] };

	assert.deepEqual(me, { ...me, "roles": [], "permissions": [] });
});

test("an editor token is refused at /admin/*, even the owner's: 403, recorded", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "editor");
	const response = await holder.send("GET", "/admin/me", { "accessToken": access_token });

	assert.equal(response.status, 403);
	assert.deepEqual(await refusals(grantId), ["a token for another client"]);
});

test("an admin token is refused on the editor's routes: its account endpoints and the GitHub proxy", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");

	assert.equal((await holder.send("GET", "/me", { "accessToken": access_token })).status, 403);
	assert.equal((await holder.send("GET", "/github/api/user", { "accessToken": access_token })).status, 403);
	assert.deepEqual(await refusals(grantId), ["a token for another client", "a token for another client"]);
});

test("the Grant remembers its client: a code begun for one can't be redeemed by the other, and is spent trying", async () => {
	const holder = await browser();
	const { code, verifier, grantId } = await begin(holder, OWNER, "admin");
	const redeem = async (client: string): Promise<number> => (await holder.send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": client } })).status;

	assert.equal(await redeem("editor"), 400);
	assert.equal(await redeem("admin"), 400, "the code was spent");
	assert.deepEqual(await refusals(grantId), ["another client", "code already used"]);
});

test("a refresh token is for its client only: the other is refused, and the right one still refreshes, still an admin token", async () => {
	const holder = await browser();
	const { refresh_token, grantId } = await signedIn(holder, OWNER, "admin");
	const refresh = async (client: string): Promise<Answer> => holder.send("POST", "/token", { "form": { "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client } });

	assert.equal((await refresh("editor")).status, 400);

	const renewed = await refresh("admin");
	const { access_token } = await renewed.json() as { "access_token": string };

	assert.equal(renewed.status, 200);
	assert.equal((await holder.send("GET", "/admin/me", { "accessToken": access_token })).status, 200);
	assert.deepEqual(await refusals(grantId), ["another client"]);
});

test("a grant from before clients is the editor's", async () => {
	const holder = await browser();
	const { code, verifier } = await begin(holder, someone(), undefined);
	const response = await holder.send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" } });
	const { access_token } = await response.json() as { "access_token": string };

	assert.equal(response.status, 200);
	assert.equal((await holder.send("GET", "/me", { "accessToken": access_token })).status, 200);
});

test("signing in: each client returns only to its own pages; a client that isn't ours is refused", async () => {
	const holder = await browser();
	const start = async (client: string, page: string): Promise<number> => (await server.fetch(`${at("/auth/github/start")}?${new URLSearchParams({ "client_id": client, "response_type": "code", "redirect_uri": page, "state": "s", "code_challenge": "a".repeat(43), "code_challenge_method": "S256", "dpop_jkt": holder.jkt })}`, { "redirect": "manual", "headers": { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}` } })).status;

	assert.equal(await start("admin", "http://localhost:5174/"), 302);
	assert.equal(await start("admin", "http://localhost:5173/"), 400, "the editor's page");
	assert.equal(await start("editor", "http://localhost:5174/"), 400, "the admin app's page");
	assert.equal(await start("someone-else", "http://localhost:5174/"), 400);
});

test("every admin request that's answered is recorded: admin_access, with what it was", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");

	await holder.send("GET", "/admin/me", { "accessToken": access_token });

	const rows = (await env.DB.prepare("SELECT detail FROM audit WHERE grant_id = ? AND event = 'admin_access'").bind(grantId).all<{ "detail": string }>()).results;

	assert.deepEqual(rows, [{ "detail": "GET /admin/me" }]);
});
