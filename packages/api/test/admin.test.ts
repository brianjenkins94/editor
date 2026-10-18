import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { PERMISSIONS, permissionsOf } from "../src/rbac.ts";
import { BROWSER } from "./browser.ts";
import { keyed } from "../src/behavior.ts";
import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";

// B1 in workerd (packages/admin/README.md): the admin client, the Grant remembering its client, /admin/* for admin tokens
// only, and roles from OWNERS. Sign-ins start as the GitHub callback starts them (Grant.begin), for either client.

const OWNER = 9398474; // OWNERS in wrangler.jsonc's local vars
const VIEWER = 64174526; // VIEWERS
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
};
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9", "CLOUDFLARE_API": "http://127.0.0.1:9" } }] });
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
				const ath = accessToken === undefined ? {} : { "ath": await s256(accessToken) };
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
	const challenge = await s256(verifier);
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

// ── B2: the read endpoints ─────────────────────────────────────────────────────────────────────────────────────────

test("every read endpoint is refused without its permission: 403, recorded with what was lacking", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, someone(), "admin");

	for (const path of ["/admin/users", "/admin/users/x", "/admin/sessions", "/admin/audit", "/admin/unusual", "/admin/architecture", "/admin/mail", "/admin/inbox"]) {
		assert.equal((await holder.send("GET", path, { "accessToken": access_token })).status, 403, path);
	}

	assert.deepEqual(await refusals(grantId), ["lacks users:read", "lacks users:read", "lacks sessions:read", "lacks audit:read", "lacks behavior:read", "lacks architecture:read", "lacks mail:read", "lacks mail:read"]);
});

test("/admin/users and /admin/users/:id: who's signed up, their sign-ins with their client, and their audit rows", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");
	const other = someone();
	const { grantId: otherGrant } = await signedIn(await browser(), other, "editor");
	const { users } = await (await holder.send("GET", "/admin/users", { "accessToken": access_token })).json() as { "users": { "id": string; "githubId": number; "liveSessions": number; "lastSeenAt": number | null }[] };
	const listed = users.find((user) => user.githubId === other);

	assert.ok(listed !== undefined);
	assert.equal(listed.liveSessions, 1);
	assert.equal(typeof listed.lastSeenAt, "number");

	const one = await (await holder.send("GET", `/admin/users/${listed.id}`, { "accessToken": access_token })).json() as { "user": { "githubId": number }; "sessions": { "id": string; "client": string }[]; "audit": { "event": string }[] };

	assert.equal(one.user.githubId, other);
	assert.deepEqual(one.sessions.map((session) => [session.id, session.client]), [[otherGrant, "editor"]]);
	assert.deepEqual(one.audit.map((row) => row.event).sort((a, b) => a.localeCompare(b)), ["login", "token_issued"]);
	assert.ok(one.audit.every((row) => (row as { "userId"?: string }).userId === listed.id), "rows carry whose they are, as /admin/audit's do");
	assert.equal((await holder.send("GET", "/admin/users/nobody", { "accessToken": access_token })).status, 404);

	// Looking was itself recorded, with whose data.
	const looked = (await env.DB.prepare("SELECT detail FROM audit WHERE grant_id = ? AND event = 'admin_access'").bind(grantId).all<{ "detail": string }>()).results.map((row) => row.detail);

	assert.ok(looked.includes(`GET /admin/users/${listed.id}`));
});

test("/admin/sessions: live sign-ins, with whose they are; an ended one isn't listed", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");
	const { grantId: ended } = await signedIn(await browser(), someone(), "editor");

	await env.DB.prepare("UPDATE grants SET revoked_at = ? WHERE id = ?").bind(Date.now(), ended).run();

	const { sessions } = await (await holder.send("GET", "/admin/sessions", { "accessToken": access_token })).json() as { "sessions": { "id": string; "client": string; "githubId": number }[] };
	const mine = sessions.find((session) => session.id === grantId);

	assert.deepEqual([mine?.client, mine?.githubId], ["admin", OWNER]);
	assert.equal(sessions.some((session) => session.id === ended), false);
});

test("/admin/audit: newest first, by event, suspicious only, and a page at a time", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const read = async (query: string): Promise<{ "id": number; "event": string }[]> => (await (await holder.send("GET", `/admin/audit?${query}`, { "accessToken": access_token })).json() as { "rows": { "id": number; "event": string }[] }).rows;
	const logins = await read("event=login&limit=3");

	assert.equal(logins.length, 3);
	assert.ok(logins.every((row) => row.event === "login"));
	assert.ok(logins[0]!.id > logins[1]!.id, "newest first");

	const next = await read(`event=login&limit=3&before=${logins.at(-1)!.id}`);

	assert.ok(next.every((row) => row.id < logins.at(-1)!.id), "the next page");

	const suspicious = await read("suspicious=true&limit=500");

	assert.ok(suspicious.length > 0);
	assert.ok(suspicious.every((row) => !["login", "token_issued", "refreshed", "proxy_call", "admin_access"].includes(row.event)));
});

// ── B6: the first write ────────────────────────────────────────────────────────────────────────────────────────────

test("ending a sign-in needs sessions:revoke: 403, recorded, and the sign-in carries on", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, someone(), "admin");
	const { grantId: target } = await signedIn(await browser(), someone(), "editor");

	assert.equal((await holder.send("POST", `/admin/sessions/${target}/revoke`, { "accessToken": access_token, "form": { "confirm": "revoke" } })).status, 403);
	assert.deepEqual(await refusals(grantId), ["lacks sessions:revoke"]);
	assert.equal((await env.DB.prepare("SELECT revoked_at FROM grants WHERE id = ?").bind(target).first<{ "revoked_at": number | null }>())?.revoked_at, null);
});

test("an admin ends someone's sign-in: only with confirm=revoke; its tokens stop at once; both sides recorded", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");
	const victim = await browser();
	const { "access_token": theirs, refresh_token, "grantId": target } = await signedIn(victim, someone(), "editor");
	const end = async (form: Record<string, string>): Promise<Answer> => holder.send("POST", `/admin/sessions/${target}/revoke`, { "accessToken": access_token, "form": form });

	assert.equal((await end({})).status, 400, "no confirm: nothing ended");
	assert.equal((await victim.send("GET", "/sessions", { "accessToken": theirs })).status, 200);

	assert.equal((await end({ "confirm": "revoke" })).status, 200);
	assert.notEqual((await victim.send("GET", "/sessions", { "accessToken": theirs })).status, 200, "their access token is refused");
	assert.equal((await victim.send("POST", "/token", { "form": { "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": "editor" } })).status, 400, "and their refresh token");

	const userId = (await env.DB.prepare("SELECT user_id FROM grants WHERE id = ?").bind(target).first<{ "user_id": string }>())?.user_id;
	const ended = await env.DB.prepare("SELECT user_id, reason FROM audit WHERE grant_id = ? AND event = 'grant_revoked'").bind(target).first<{ "user_id": string; "reason": string }>();
	const by = await env.DB.prepare("SELECT user_id, detail FROM audit WHERE grant_id = ? AND event = 'admin_revoked'").bind(grantId).first<{ "user_id": string; "detail": string }>();

	assert.deepEqual(ended, { "user_id": userId, "reason": "ended by an admin" });
	assert.equal(by?.detail, `sign-in ${target} of user ${userId}`);

	// Ended already, or not a sign-in at all: nothing to end.
	assert.equal((await end({ "confirm": "revoke" })).status, 404);
	assert.equal((await holder.send("POST", "/admin/sessions/nope/revoke", { "accessToken": access_token, "form": { "confirm": "revoke" } })).status, 404);
});

test("the admin's own sign-in is marked current in the lists", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, OWNER, "admin");
	const { sessions } = await (await holder.send("GET", "/admin/sessions", { "accessToken": access_token })).json() as { "sessions": { "id": string; "current": boolean }[] };

	assert.deepEqual(sessions.filter((session) => session.current).map((session) => session.id), [grantId]);
});

test("/admin/audit?repo=: the proxy's calls about one repository, found by hashing its name as the log does", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const tag = async (repository: string): Promise<string> => `repo#${await keyed({ "AUDIT_KEY": secrets.AUDIT_KEY } as Parameters<typeof keyed>[0], "values", repository)}`;
	const marker = crypto.randomUUID();

	await env.DB.batch([
		env.DB.prepare("INSERT INTO audit (at, event, reason, detail) VALUES (?, 'proxy_call', ?, ?)").bind(Date.now(), marker, `GET /repos/:owner/:repo ${await tag("octo/hello")}`),
		env.DB.prepare("INSERT INTO audit (at, event, reason, detail) VALUES (?, 'proxy_call', ?, ?)").bind(Date.now(), marker, `GET /repos/:owner/:repo ${await tag("octo/other")}`)
	]);

	const { rows } = await (await holder.send("GET", "/admin/audit?repo=Octo/Hello&event=proxy_call", { "accessToken": access_token })).json() as { "rows": { "reason": string; "detail": string }[] };

	assert.deepEqual(rows.filter((row) => row.reason === marker).map((row) => row.detail), [`GET /repos/:owner/:repo ${await tag("octo/hello")}`], "case doesn't matter: GitHub's names don't");
});

// ── B9: unusual sign-ins ───────────────────────────────────────────────────────────────────────────────────────────

test("/admin/unusual: sign-ins by their mean surprise, most first, with their most surprising steps and what they did that the editor doesn't", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const [calm, odd, brief] = [await signedIn(await browser(), someone(), "editor"), await signedIn(await browser(), someone(), "editor"), await signedIn(await browser(), someone(), "editor")];
	const step = { "from": "GET /sessions", "to": "POST /account/delete", "gap": 0, "bits": 9.5 };

	// Means of 100 and 101 bits a step: above anything real, so these two lead whatever else the tests have scored.
	await env.DB.batch([
		env.DB.prepare("INSERT INTO scores (grant_id, steps, bits, top, updated_at) VALUES (?, 10, 1000, '[]', ?)").bind(calm.grantId, Date.now()),
		env.DB.prepare("INSERT INTO scores (grant_id, steps, bits, top, updated_at) VALUES (?, 10, 1010, ?, ?)").bind(odd.grantId, JSON.stringify([step]), Date.now()),
		env.DB.prepare("INSERT INTO scores (grant_id, steps, bits, top, updated_at) VALUES (?, 2, 9000, '[]', ?)").bind(brief.grantId, Date.now()),
		env.DB.prepare("INSERT INTO audit (at, event, grant_id, detail) VALUES (?, 'probe', ?, 'GET #x')").bind(Date.now(), odd.grantId),
		env.DB.prepare("INSERT INTO audit (at, event, grant_id, detail) VALUES (?, 'probe', ?, 'GET #y')").bind(Date.now(), odd.grantId)
	]);

	const read = async (query: string): Promise<{ "id": string; "score": { "mean": number; "steps": number; "top": unknown[] }; "flags": Record<string, number>; "githubId": number; "client": string }[]> => (await (await holder.send("GET", `/admin/unusual${query}`, { "accessToken": access_token })).json() as { "sessions": { "id": string; "score": { "mean": number; "steps": number; "top": unknown[] }; "flags": Record<string, number>; "githubId": number; "client": string }[] }).sessions;
	const [first, second] = await read("");

	assert.deepEqual([first?.id, second?.id], [odd.grantId, calm.grantId]);
	assert.deepEqual([first?.score.mean, first?.score.steps, first?.score.top, first?.flags, first?.client], [101, 10, [step], { "probe": 2 }, "editor"]);
	assert.deepEqual(second?.flags, {});
	assert.equal((await read("")).some((row) => row.id === brief.grantId), false, "two steps: too few to say");
	assert.equal((await read("?min=1"))[0]?.id, brief.grantId);
});

// ── The architecture page ──────────────────────────────────────────────────────────────────────────────────────────

test("/admin/architecture: the API describes itself from its code: its routes, its stores' tables with counts, what it relays and who calls it", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const described = await (await holder.send("GET", "/admin/architecture", { "accessToken": access_token })).json() as { "environment": string; "routes": { "method": string; "path": string }[]; "database": { "table": string; "rows": number }[]; "objects": { "class": string; "tables": string[]; "live"?: number }[]; "proxied": { "base": string; "call": string }[]; "clients": string[] };
	const routes = described.routes.map((route) => `${route.method} ${route.path}`);

	assert.equal(described.environment, "local");

	for (const route of ["POST /token", "GET /sessions", "GET /admin/architecture", "GET /admin/users/:id", "GET /github/api/*"]) {
		assert.ok(routes.includes(route), route);
	}

	assert.equal(routes.some((route) => route.startsWith("ALL ")), false, "middleware isn't a route");
	assert.ok((described.database.find((table) => table.table === "users")?.rows ?? 0) >= 1, "counts, from D1's own schema");
	assert.equal(described.database.some((table) => table.table === "d1_migrations"), false);
	assert.ok(described.objects.find((object) => object.class === "Grant")?.tables.includes("fingerprint"), "a Durable Object's tables, from the SQL that makes them");
	assert.ok((described.objects.find((object) => object.class === "Grant")?.live ?? 0) >= 1);
	assert.ok(described.proxied.some((call) => call.call === "GET /repos/:owner/:repo/git/trees/:ref"));
	assert.ok(described.clients.includes("http://localhost:5174"));
	assert.equal(JSON.stringify(described).includes(String(OWNER)), false, "no one's data");
});

// ── The Mail page ──────────────────────────────────────────────────────────────────────────────────────────────────

test("/admin/mail: by day, codes sent, sign-ins by email and refusals, and the refusals by reason; Cloudflare's side says why it's missing", async () => {
	const holder = await browser();
	const { access_token } = await signedIn(holder, OWNER, "admin");
	const now = Date.now();

	await env.DB.batch([
		env.DB.prepare("INSERT INTO audit (at, event, detail) VALUES (?, 'email_code_sent', 'hash'), (?, 'email_code_sent', 'hash')").bind(now, now),
		env.DB.prepare("INSERT INTO audit (at, event, reason) VALUES (?, 'login', 'email'), (?, 'login', 'github')").bind(now, now),
		env.DB.prepare("INSERT INTO audit (at, event, reason) VALUES (?, 'sign_in_refused', 'email: code wrong'), (?, 'sign_in_refused', 'email: code wrong'), (?, 'sign_in_refused', 'email: not sent: E_RECIPIENT_SUPPRESSED'), (?, 'sign_in_refused', 'request_uri expired')").bind(now, now, now, now)
	]);

	const mail = await (await holder.send("GET", "/admin/mail?days=3", { "accessToken": access_token })).json() as { "window": { "days": number }; "days": { "day": string; "sent": number; "signedIn": number; "refused": number }[]; "refusals": { "reason": string; "count": number }[]; "cloudflare": { "error"?: string } };
	const today = mail.days.at(-1);

	assert.equal(mail.window.days, 3);
	assert.equal(mail.days.length, 3);
	assert.equal(today?.day, new Date(now).toISOString().slice(0, 10));
	assert.ok((today?.sent ?? 0) >= 2 && (today?.signedIn ?? 0) >= 1 && (today?.refused ?? 0) >= 3);
	assert.ok(mail.refusals.some((row) => row.reason === "code wrong" && row.count >= 2));
	assert.ok(mail.refusals.some((row) => row.reason === "not sent: E_RECIPIENT_SUPPRESSED"));
	assert.equal(mail.refusals.some((row) => row.reason.includes("request_uri")), false, "email's refusals only");
	assert.match(mail.cloudflare.error ?? "", /local API/u, "a local API's mail isn't Cloudflare's: why its side is missing");
});

// ── The viewer role ────────────────────────────────────────────────────────────────────────────────────────────────

test("a viewer reads everything an owner can, and changes or sends nothing", async () => {
	const holder = await browser();
	const { access_token, grantId } = await signedIn(holder, VIEWER, "admin");
	const { grantId: someoneElse } = await signedIn(await browser(), someone(), "editor");
	const me = await (await holder.send("GET", "/admin/me", { "accessToken": access_token })).json() as { "roles": string[]; "permissions": string[] };

	assert.deepEqual(me.roles, ["viewer"]);
	assert.ok(me.permissions.every((permission) => permission.endsWith(":read") || permission === "audit:verify"), "reads only");

	for (const path of ["/admin/users", "/admin/sessions", "/admin/audit", "/admin/unusual", "/admin/architecture", "/admin/mail", "/admin/inbox"]) {
		assert.equal((await holder.send("GET", path, { "accessToken": access_token })).status, 200, path);
	}

	assert.equal((await holder.send("POST", `/admin/sessions/${someoneElse}/revoke`, { "accessToken": access_token, "form": { "confirm": "revoke" } })).status, 403);
	assert.equal((await holder.send("POST", "/admin/mail/smoke", { "accessToken": access_token, "form": {} })).status, 403);
	assert.deepEqual((await refusals(grantId)).slice(-2), ["lacks sessions:revoke", "lacks mail:test"]);
	assert.equal((await env.DB.prepare("SELECT revoked_at FROM grants WHERE id = ?").bind(someoneElse).first<{ "revoked_at": number | null }>())?.revoked_at, null, "nothing ended");
});
