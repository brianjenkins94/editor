import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { BROWSER } from "./browser.ts";

// B4 in workerd: /admin/traffic asks Cloudflare's GraphQL API (here, a stand-in) with the API's own read-only token, and
// answers the admin app in its own shape. Only `traffic:read` may ask; without a token it says so.

const OWNER = 9398474;
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"ANALYTICS_TOKEN": "analytics-token-for-the-tests"
};

// Cloudflare's GraphQL endpoint: what it was asked, and an answer as `cloudflare.next` says.
const cloudflare = { "asked": [] as { "authorization": string; "body": { "query": string; "variables": Record<string, string> } }[], "next": "ok" as "ok" | "refused" };
const group = (count: number, dimensions: Record<string, unknown>): Record<string, unknown> => ({ "count": count, "dimensions": dimensions });
const mock = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		cloudflare.asked.push({ "authorization": request.headers.authorization ?? "", "body": JSON.parse(body) });
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(cloudflare.next === "refused" ? { "data": null, "errors": [{ "message": "not authorized for that account" }] } : { "data": { "viewer": {
			"zones": [{
				"byHost": [group(120, { "clientRequestHTTPHost": "editor.unusuallygood.dev", "edgeResponseStatus": 200 }), group(7, { "clientRequestHTTPHost": "api.unusuallygood.dev", "edgeResponseStatus": 404 })],
				"paths": [group(50, { "clientRequestHTTPHost": "editor.unusuallygood.dev", "clientRequestPath": "/", "edgeResponseStatus": 200 })],
				"agents": [group(30, { "userAgent": "Mozilla/5.0" })],
				"countries": [group(90, { "clientCountryName": "US" })],
				"hours": [group(12, { "datetimeHour": "2026-10-17T15:00:00Z", "clientRequestHTTPHost": "editor.unusuallygood.dev" })]
			}],
			"accounts": [{ "workers": [{ "sum": { "requests": 504, "errors": 0, "subrequests": 33 }, "quantiles": { "cpuTimeP50": 1602, "cpuTimeP99": 12948 }, "dimensions": { "scriptName": "editor-api" } }] }]
		} } }));
	});
});

await new Promise<void>((resolve) => {
	mock.listen(0, "127.0.0.1", resolve);
});

const cloudflareOrigin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9", "CLOUDFLARE_API": cloudflareOrigin } }] });
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
	mock.close();
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
				const headers: Record<string, string> = { ...BROWSER, "dpop": await proof(method, at(path), ath), "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...accessToken === undefined ? {} : { "authorization": `DPoP ${accessToken}` }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };
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

test("only traffic:read may ask: anyone else gets a 403, and Cloudflare isn't asked", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, someone(), "admin");
	const asked = cloudflare.asked.length;

	assert.equal((await holder.send("GET", "/admin/traffic", { "accessToken": access_token })).status, 403);
	assert.equal(cloudflare.asked.length, asked);
});

test("the owner gets Cloudflare's analytics in the app's shape, asked with the API's token for the zone and account", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");

	cloudflare.next = "ok";

	const response = await holder.send("GET", "/admin/traffic", { "accessToken": access_token });
	const traffic = await response.json() as Record<string, unknown> & { "window": { "name": string; "since": string; "until": string } };
	const asked = cloudflare.asked.at(-1)!;

	assert.equal(response.status, 200);
	assert.equal(asked.authorization, "Bearer analytics-token-for-the-tests");
	assert.deepEqual([asked.body.variables["zone"], asked.body.variables["account"]], ["54d20cd60d5353f2080a1c8aec6def0d", "3ade13ae64e29b20e6b7c61f9ae7b714"]);
	assert.equal(traffic.window.name, "24h");
	assert.ok(Date.parse(traffic.window.until) - Date.parse(traffic.window.since) > 23 * 3_600_000);
	assert.deepEqual(traffic["byHost"], [{ "host": "editor.unusuallygood.dev", "status": 200, "requests": 120 }, { "host": "api.unusuallygood.dev", "status": 404, "requests": 7 }]);
	assert.deepEqual(traffic["workers"], [{ "script": "editor-api", "requests": 504, "errors": 0, "subrequests": 33, "cpuP50": 1602, "cpuP99": 12948 }]);
	assert.equal(JSON.stringify(traffic).includes("analytics-token"), false, "the token never reaches the browser");
});

test("?window=1h asks about the last hour", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const traffic = await (await holder.send("GET", "/admin/traffic?window=1h", { "accessToken": access_token })).json() as { "window": { "name": string; "since": string; "until": string } };

	assert.equal(traffic.window.name, "1h");
	assert.equal(Date.parse(traffic.window.until) - Date.parse(traffic.window.since), 3_600_000);
});

test("a refusal from Cloudflare is a 502 with Cloudflare's own message", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");

	cloudflare.next = "refused";

	const response = await holder.send("GET", "/admin/traffic", { "accessToken": access_token });

	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { "error": "analytics", "message": "not authorized for that account" });
	cloudflare.next = "ok";
});
