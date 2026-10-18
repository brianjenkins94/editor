import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { deviceLabel } from "../src/account.ts";
import { BROWSER } from "./browser.ts";
import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";

// Your sessions and your account (src/account.ts), in workerd: listing and ending your own sign-ins (never anyone
// else's), signing out everywhere, and deleting the account — at GitHub too, and leaving nothing that points at you.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };

/** GitHub: what it was asked to revoke. */
const revoked: { "url": string; "authorization": string; "body": string }[] = [];
const mock = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		if (request.method === "DELETE") {
			revoked.push({ "url": request.url ?? "", "authorization": request.headers.authorization ?? "", "body": body });
			response.statusCode = 204;
			response.end();

			return;
		}

		response.end("{}");
	});
});

await new Promise<void>((resolve) => {
	mock.listen(0, "127.0.0.1", resolve);
});

const github = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": "client secret for the tests"
};
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": github, "GITHUB_API": github } }] });
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

/** A browser signed in as GitHub user `githubId`, with its own key: requests to the API as it, and what it holds. */
async function signIn(githubId: number, label: string): Promise<{ "call": (method: string, path: string, form?: Record<string, string>) => Promise<Answer>; "grantId": string; "githubToken": string; "refreshToken": string }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;
	const send = async (method: string, path: string, { form, token }: { "form"?: Record<string, string>; "token"?: string }): Promise<Answer> => {
		for (let attempt = 0; ; attempt += 1) {
			const claims = { "htm": method, "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...token === undefined ? {} : { "ath": await s256(token) } };
			const headers: Record<string, string> = { ...BROWSER, "dpop": await new SignJWT(claims).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey), "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...token === undefined ? {} : { "authorization": `DPoP ${token}` }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };
			const response = await server.fetch(at(path), { "method": method, "headers": headers, ...form === undefined ? {} : { "body": new URLSearchParams(form).toString() } });

			nonce = response.headers.get("dpop-nonce") ?? nonce;

			if (attempt === 0 && response.headers.has("dpop-nonce") && (response.status === 400 || response.status === 401) && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
				continue;
			}

			return response;
		}
	};
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const id = env.GRANTS.newUniqueId();
	const githubToken = `ghu_${crypto.randomUUID()}`;
	const { code } = await env.GRANTS.get(id).begin({ "githubId": githubId, "github": { "accessToken": githubToken, "refreshToken": `ghr_${crypto.randomUUID()}`, "expiresAt": Date.now() + 3_600_000, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": await s256(verifier), "jkt": await calculateJwkThumbprint(jwk), "from": { "country": null, "ipHash": null, "traceId": null }, "label": label });
	const tokens = await (await send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" } })).json() as { "access_token": string; "refresh_token": string };

	return { "call": async (method, path, form) => send(method, path, { "form": form, "token": tokens.access_token }), "grantId": id.toString(), "githubToken": githubToken, "refreshToken": tokens.refresh_token };
}

const user = (): number => Math.floor(Math.random() * 1e9);

interface Listed { "id": string; "current": boolean; "label": string | null; "createdAt": number; "lastUsedAt": number }

async function sessions(of: Awaited<ReturnType<typeof signIn>>): Promise<Listed[]> {
	return (await (await of.call("GET", "/sessions")).json() as { "sessions": Listed[] }).sessions;
}

test("a device label is the browser and the OS, nothing more", () => {
	assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome on macOS");
	assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge on Windows");
	assert.equal(deviceLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
	assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Firefox on Linux");
	assert.equal(deviceLabel(undefined), undefined);
});

test("sessions: your live sign-ins, this one marked, labelled — not anyone else's, not ended ones", async () => {
	const me = user();
	const laptop = await signIn(me, "Chrome on macOS");
	const phone = await signIn(me, "Safari on iOS");
	const ended = await signIn(me, "Firefox on Linux");

	await signIn(user(), "Someone else's");
	await ended.call("POST", "/revoke", { "token": ended.refreshToken });

	const listed = await sessions(laptop);

	assert.deepEqual(listed.map((session) => [session.id, session.current, session.label]).toSorted((a, b) => String(a[2]).localeCompare(String(b[2]))), [[laptop.grantId, true, "Chrome on macOS"], [phone.grantId, false, "Safari on iOS"]]);
	assert.equal(listed.every((session) => session.createdAt > 0 && session.lastUsedAt >= session.createdAt), true);
});

test("ending one of your other sessions: it's over (GitHub's token too), and this one isn't", async () => {
	const me = user();
	const laptop = await signIn(me, "Chrome on macOS");
	const phone = await signIn(me, "Safari on iOS");
	const before = revoked.length;

	assert.equal((await laptop.call("POST", `/sessions/${phone.grantId}/revoke`)).status, 200);
	assert.equal((await phone.call("GET", "/me")).status, 401);
	assert.equal((await laptop.call("GET", "/me")).status, 200);
	assert.deepEqual(revoked.slice(before).map((call) => [call.url, JSON.parse(call.body)]), [["/applications/Iv23ligdisoL7OPTVtXm/token", { "access_token": phone.githubToken }]]);

	const reason = await env.DB.prepare("SELECT reason FROM audit WHERE grant_id = ? AND event = 'grant_revoked'").bind(phone.grantId).first<{ "reason": string }>();

	assert.equal(reason?.reason, "signed out from another session");
});

test("someone else's session can't be ended — a 404, recorded — and theirs lives on", async () => {
	const mine = await signIn(user(), "Chrome on macOS");
	const theirs = await signIn(user(), "Chrome on Windows");

	assert.equal((await mine.call("POST", `/sessions/${theirs.grantId}/revoke`)).status, 404);
	assert.equal((await mine.call("POST", "/sessions/not-a-grant/revoke")).status, 404);
	assert.equal((await theirs.call("GET", "/me")).status, 200);

	const refused = (await env.DB.prepare("SELECT reason FROM audit WHERE grant_id = ? AND event = 'auth_refused'").bind(mine.grantId).all<{ "reason": string }>()).results.map((row) => row.reason);

	assert.deepEqual(refused, ["not one of your sessions", "not one of your sessions"]);
});

test("signing out everywhere ends every one of your sessions, this one included — and nobody else's", async () => {
	const me = user();
	const laptop = await signIn(me, "Chrome on macOS");
	const phone = await signIn(me, "Safari on iOS");
	const someoneElse = await signIn(user(), "Chrome on Windows");

	assert.deepEqual(await (await laptop.call("POST", "/sessions/revoke-all")).json(), { "revoked": 2 });
	assert.equal((await laptop.call("GET", "/me")).status, 401);
	assert.equal((await phone.call("GET", "/me")).status, 401);
	assert.equal((await someoneElse.call("GET", "/me")).status, 200);
});

const userOf = async (grantId: string): Promise<string> => (await env.DB.prepare("SELECT user_id FROM grants WHERE id = ?").bind(grantId).first<{ "user_id": string }>())?.user_id as string;

test("deleting the account is soft: GitHub's authorization revoked and every session ended at once, the account kept for 30 days", async () => {
	const me = user();
	const laptop = await signIn(me, "Chrome on macOS");
	const phone = await signIn(me, "Safari on iOS");
	const someoneElse = await signIn(user(), "Chrome on Windows");
	const userId = await userOf(laptop.grantId);

	assert.equal((await laptop.call("POST", "/account/delete", {})).status, 400, "not without confirm=delete");

	const before = revoked.length;
	const deleted = await laptop.call("POST", "/account/delete", { "confirm": "delete" });
	const answer = await deleted.json() as { "deleted": boolean; "githubAuthorizationRevoked": boolean; "purgeAfter": number };

	assert.deepEqual([answer.deleted, answer.githubAuthorizationRevoked], [true, true]);
	assert.ok(Math.abs(answer.purgeAfter - (Date.now() + 30 * 86_400_000)) < 60_000, "purged in 30 days");
	assert.deepEqual(revoked.slice(before)[0], { "url": "/applications/Iv23ligdisoL7OPTVtXm/grant", "authorization": `Basic ${btoa(`Iv23ligdisoL7OPTVtXm:${secrets.GITHUB_CLIENT_SECRET}`)}`, "body": JSON.stringify({ "access_token": laptop.githubToken }) });

	// Marked, not gone: the user and their sign-ins (each ended), and the audit log still says whose rows are whose.
	assert.equal(typeof (await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?").bind(userId).first<{ "deleted_at": number | null }>())?.deleted_at, "number");
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND revoked_at IS NOT NULL").bind(userId).first<{ "n": number }>())?.n, 2);
	assert.ok(((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE user_id = ?").bind(userId).first<{ "n": number }>())?.n ?? 0) > 0);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'account_deleted' AND user_id = ?").bind(userId).first<{ "reason": string }>())?.reason, "GitHub authorization revoked");

	// Every session is over at once, its Grant's state kept (revoked) until the purge.
	for (const session of [laptop, phone]) {
		const storage = await worker.getDurableObjectStorage("GRANTS", { "id": session.grantId });

		assert.equal((await storage.exec("SELECT revoked_at FROM state") as { "revoked_at": number | null }[])[0]?.revoked_at !== null, true);
		assert.equal((await session.call("GET", "/me")).status, 401);
	}

	assert.equal((await someoneElse.call("GET", "/me")).status, 200);
});

test("signing in again within the 30 days restores the account: the same user, recorded", async () => {
	const me = user();
	const first = await signIn(me, "Chrome on macOS");
	const userId = await userOf(first.grantId);

	await first.call("POST", "/account/delete", { "confirm": "delete" });

	const again = await signIn(me, "Chrome on macOS");

	assert.equal(await userOf(again.grantId), userId, "the same account, not a new one");
	assert.equal((await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?").bind(userId).first<{ "deleted_at": number | null }>())?.deleted_at, null);
	assert.equal((await env.DB.prepare("SELECT reason FROM audit WHERE event = 'account_restored' AND user_id = ?").bind(userId).first<{ "reason": string }>())?.reason, "signed in within the grace period");
	assert.equal((await again.call("GET", "/me")).status, 200);
});

test("after 30 days the daily cron purges it: storage erased, rows deleted, nothing left pointing at the user", async () => {
	const me = user();
	const laptop = await signIn(me, "Chrome on macOS");
	const kept = await signIn(user(), "Chrome on Windows");
	const userId = await userOf(laptop.grantId);

	await laptop.call("POST", "/account/delete", { "confirm": "delete" });
	await worker.scheduled({ "cron": "17 3 * * *" });
	assert.ok(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first() !== null, "not before its 30 days");

	await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(Date.now() - 31 * 86_400_000, userId).run();
	await worker.scheduled({ "cron": "17 3 * * *" });

	assert.equal(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first(), null);
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ?").bind(userId).first<{ "n": number }>())?.n, 0);
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE user_id = ?").bind(userId).first<{ "n": number }>())?.n, 0);
	assert.ok(((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE grant_id = ?").bind(laptop.grantId).first<{ "n": number }>())?.n ?? 0) > 0, "what happened is still recorded");
	assert.deepEqual(await (await worker.getDurableObjectStorage("GRANTS", { "id": laptop.grantId })).exec("SELECT * FROM state"), []);
	assert.equal((await laptop.call("GET", "/me")).status, 401, "a token still held meets a sign-in that's over");
	assert.ok((await env.DB.prepare("SELECT 1 FROM audit WHERE event = 'account_purged' AND detail = '1 sign-in(s) erased'").first()) !== null);
	assert.equal((await kept.call("GET", "/me")).status, 200, "nobody else's");
});
