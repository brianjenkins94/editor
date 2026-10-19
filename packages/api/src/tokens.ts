import type { Context } from "hono";
import type { JWK } from "jose";
import type { Grant } from "./grant.ts";
import { nonces, publicKey, signAccessToken, verifyAccessToken, verifyProof } from "@brianjenkins94/util/auth/dpop";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { Subject } from "./audit.ts";
import { audit, origin } from "./audit.ts";
import type { Difference } from "./behavior.ts";
import { actionOf, described, fingerprint } from "./behavior.ts";
import type { AppEnv, Bindings } from "./env.ts";
import { isClient } from "./clients.ts";
import { watch } from "./tripwire.ts";

/**
 * Our tokens (README.md, "Tokens and the flow"): /token redeems a code or rotates a refresh token for a DPoP-bound access
 * token, /revoke ends a sign-in, and `session` puts DPoP in front of a route. Every request carries a proof of the
 * sign-in's key, with a server nonce (a `use_dpop_nonce` answer hands out a fresh one).
 */

const ACCESS_TTL = 300;

/** The issuer, and the audience: this Worker, by the origin it was reached at. */
const issuer = (context: Context<AppEnv>): string => new URL(context.req.url).origin;

const signingKey = (env: Bindings): JWK => JSON.parse(env.SIGNING_JWK) as JWK;

export const nonce = (env: Bindings): ReturnType<typeof nonces> => nonces(env.NONCE_KEY);

/** How a sign-in's client differs from how it's known, the first time each way that matters is seen (Grant.use):
 *  recorded by name and how, never the values (BEHAVIOR.md). */
async function recordChanged(context: Context<AppEnv>, subject: Subject, changed: Difference[]): Promise<void> {
	for (const difference of changed) {
		await audit(context.env, "client_changed", subject, await origin(context), { "reason": `${difference.strength}: ${difference.name} ${difference.kind}`, "detail": await described(context.env, context.req.method, new URL(context.req.url)) });
	}
}

/**
 * The Grant a `<grant id>.<secret>` code or refresh token belongs to — if that grant exists and is live. A token for a
 * revoked one is still audited: someone holds it after the sign-in ended.
 */
async function grantOf(context: Context<AppEnv>, value: string | undefined): Promise<{ "id": string; "stub": DurableObjectStub<Grant> } | "revoked" | undefined> {
	const id = value?.split(".")[0];
	// D1 first: addressing a Durable Object creates it, and the id here is the caller's to choose.
	const row = id === undefined ? null : await context.env.DB.prepare("SELECT user_id, revoked_at FROM grants WHERE id = ?").bind(id).first<{ "user_id": string; "revoked_at": number | null }>();

	if (row === null) {
		return undefined;
	}

	if (row.revoked_at !== null) {
		await audit(context.env, "token_rejected", { "userId": row.user_id, "grantId": id }, await origin(context), { "reason": "grant revoked" });

		return "revoked";
	}

	return { "id": id as string, "stub": context.env.GRANTS.get(context.env.GRANTS.idFromString(id as string)) };
}

/**
 * An OAuth error (RFC 6749 §5.2, RFC 9449 §8) — with a fresh nonce when that's what's missing. Recorded (`auth_refused`),
 * but for the nonce challenge, which every client meets routinely, and for what a Grant recorded already (`recorded`).
 */
async function oauthError(context: Context<AppEnv>, error: string, reason: string, { subject = {}, recorded = false }: { "subject"?: Subject; "recorded"?: boolean } = {}): Promise<Response> {
	context.get("span").info("token request refused", { "reason": reason });

	if (error !== "use_dpop_nonce" && !recorded) {
		await audit(context.env, "auth_refused", subject, await origin(context), { "reason": reason, "detail": await described(context.env, context.req.method, new URL(context.req.url)) });
	}

	if (error === "use_dpop_nonce") {
		context.header("dpop-nonce", await nonce(context.env).issue());
	}

	context.header("cache-control", "no-store");

	return context.json({ "error": error }, 400);
}

/** POST /token: `authorization_code` (code, code_verifier) or `refresh_token` (refresh_token), with a DPoP proof. */
export async function tokenEndpoint(context: Context<AppEnv>): Promise<Response> {
	const form = await context.req.parseBody();
	const grantType = form["grant_type"];
	const presented = grantType === "authorization_code" ? form["code"] : grantType === "refresh_token" ? form["refresh_token"] : undefined;

	if (grantType !== "authorization_code" && grantType !== "refresh_token") {
		return oauthError(context, "unsupported_grant_type", "grant_type");
	}

	const client = form["client_id"];

	if (typeof presented !== "string" || (grantType === "authorization_code" && typeof form["code_verifier"] !== "string") || typeof client !== "string" || !isClient(client)) {
		return oauthError(context, "invalid_request", "missing parameters");
	}

	const grant = await grantOf(context, presented);

	if (grant === "revoked") {
		return oauthError(context, "invalid_grant", "grant revoked", { "recorded": true });
	}

	if (grant === undefined) {
		return oauthError(context, "invalid_grant", "no such grant");
	}

	// The client as it is now (BEHAVIOR.md): the sign-in's first redemption remembers it; a refresh is compared with it.
	const print = await fingerprint(context.env, grant.id, context.req.raw.headers);
	let changed: Difference[] = [];
	const proof = await verifyProof({ "method": "POST", "url": context.req.url, "proof": context.req.header("dpop") }, {
		"nonce": nonce(context.env).check,
		"seen": async (jti, expires) => {
			const use = await grant.stub.use(jti, expires, { "print": print, "action": "POST /token" });

			changed = use.changed;

			return use.seen;
		}
	});

	if ("error" in proof) {
		return oauthError(context, proof.error, proof.reason, { "subject": { "grantId": grant.id } });
	}

	await recordChanged(context, { "grantId": grant.id }, changed);

	const from = await origin(context);
	const issued = grantType === "authorization_code"
		? await grant.stub.redeem({ "code": presented, "verifier": form["code_verifier"] as string, "jkt": proof.jkt, "client": client, "from": from, "print": print })
		: await grant.stub.rotate({ "refreshToken": presented, "jkt": proof.jkt, "client": client, "from": from, "print": print });

	if (!issued.ok) {
		return oauthError(context, "invalid_grant", "code or refresh token refused", { "recorded": true });
	}

	const iss = issuer(context);
	const accessToken = await signAccessToken(signingKey(context.env), { "iss": iss, "aud": iss, "sub": issued.userId, "jkt": proof.jkt, "clientId": issued.client, "extra": { "grant": grant.id } }, { "ttl": ACCESS_TTL });

	context.header("cache-control", "no-store");
	context.header("dpop-nonce", await nonce(context.env).issue());

	return context.json({ "access_token": accessToken, "token_type": "DPoP", "expires_in": ACCESS_TTL, "refresh_token": issued.refreshToken });
}

/** POST /revoke (RFC 7009): `token`, the current refresh token, with a proof from the sign-in's key. Always 200. */
export async function revokeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const form = await context.req.parseBody();
	const presented = typeof form["token"] === "string" ? form["token"] : undefined;
	const grant = await grantOf(context, presented);

	if (grant !== undefined && grant !== "revoked") {
		const proof = await verifyProof({ "method": "POST", "url": context.req.url, "proof": context.req.header("dpop") }, { "nonce": nonce(context.env).check, "seen": async (jti, expires) => (await grant.stub.use(jti, expires, { "action": "POST /revoke" })).seen });

		if (!("error" in proof)) {
			await grant.stub.revokeWith({ "refreshToken": presented as string, "jkt": proof.jkt, "from": await origin(context) });
		} else if (proof.error === "use_dpop_nonce") {
			return oauthError(context, proof.error, proof.reason);
		} else {
			await audit(context.env, "auth_refused", { "grantId": grant.id }, await origin(context), { "reason": proof.reason, "detail": "POST /revoke" });
		}
	}

	return context.body(null, 200);
}

/** 401 for a resource (RFC 9449 §7.1): `WWW-Authenticate: DPoP`, and a fresh nonce when that's what's missing. */
async function unauthorized(context: Context<AppEnv>, error: "invalid_token" | "invalid_dpop_proof" | "use_dpop_nonce", reason: string, subject: Subject = {}): Promise<Response> {
	context.get("span").info("request unauthorized", { "reason": reason });

	// Recorded, but for the nonce challenge, which every client meets routinely.
	if (error !== "use_dpop_nonce") {
		await audit(context.env, "auth_refused", subject, await origin(context), { "reason": reason, "detail": await described(context.env, context.req.method, new URL(context.req.url)) });
	}

	context.header("www-authenticate", `DPoP error="${error}", algs="ES256 ES384 ES512 PS256 PS384 PS512 EdDSA"`);

	if (error === "use_dpop_nonce") {
		context.header("dpop-nonce", await nonce(context.env).issue());
	}

	return context.json({ "error": error }, 401);
}

/**
 * Who's signed in, by DPoP: `Authorization: DPoP <access token>` (ours, unexpired, bound to a key), a proof from that key
 * for this request with the access token's hash and a current nonce, a jti the grant hasn't seen, and a live grant. The
 * sign-in, or the 401 (recorded) that says why not. Its client is compared with how the sign-in's client is known
 * (BEHAVIOR.md), and a difference that matters is recorded the first time it's seen; and what it's doing (its action,
 * the matched route's template) is the next step of the sign-in's chain (B8).
 */
export async function signedIn(context: Context<AppEnv>): Promise<{ "user": string; "grant": string; "client": unknown } | Response> {
	const [scheme, accessToken] = (context.req.header("authorization") ?? "").split(" ");

	if (scheme?.toLowerCase() !== "dpop" || accessToken === undefined || accessToken === "") {
		return unauthorized(context, "invalid_token", "no DPoP access token");
	}

	const iss = issuer(context);
	const token = await verifyAccessToken(accessToken, [publicKey(signingKey(context.env))], { "iss": iss, "aud": iss });

	if ("reason" in token) {
		return unauthorized(context, "invalid_token", token.reason);
	}

	if (typeof token.claims["grant"] !== "string") {
		return unauthorized(context, "invalid_token", "no grant");
	}

	// The grant id is ours (the token is signed), so it's safe to address its Durable Object.
	const grantId = token.claims["grant"];
	const stub = context.env.GRANTS.get(context.env.GRANTS.idFromString(grantId));
	const print = await fingerprint(context.env, grantId, context.req.raw.headers);
	let active = false;
	let changed: Difference[] = [];
	const proof = await verifyProof({ "method": context.req.method, "url": context.req.url, "proof": context.req.header("dpop"), "accessToken": accessToken, "jkt": token.claims.cnf.jkt }, {
		"nonce": nonce(context.env).check,
		"seen": async (jti, expires) => {
			const use = await stub.use(jti, expires, { "print": print, "action": actionOf(context.req.method, new URL(context.req.url), routePath(context, -1)) });

			active = use.active;
			changed = use.changed;

			return use.seen;
		}
	});

	if ("error" in proof) {
		return unauthorized(context, proof.error, proof.reason, { "userId": token.claims.sub, "grantId": grantId });
	}

	if (!active) {
		return unauthorized(context, "invalid_token", "grant revoked", { "userId": token.claims.sub, "grantId": grantId });
	}

	await recordChanged(context, { "userId": token.claims.sub, "grantId": grantId }, changed);

	return { "user": token.claims.sub as string, "grant": grantId, "client": token.claims["client_id"] };
}

/**
 * DPoP in front of a route, for one of our clients: signed in (`signedIn`), with a token issued to `client`. Leaves
 * `user`, `grant` and `client` for the route.
 *
 * A token issued to another client is refused (403, audited): an editor session can't reach the admin API, even the
 * owner's, so code running on the editor's origin can't either; and an admin session can't drive the editor's routes.
 */
const sessionFor = (client: string) => createMiddleware<AppEnv>(async (context, next) => {
	const signed = await signedIn(context);

	if (signed instanceof Response) {
		return signed;
	}

	if (signed.client !== client) {
		context.get("span").info("request refused", { "reason": "a token for another client" });
		await audit(context.env, "auth_refused", { "userId": signed.user, "grantId": signed.grant }, await origin(context), { "reason": "a token for another client", "detail": await described(context.env, context.req.method, new URL(context.req.url)) });

		return context.json({ "error": "forbidden" }, 403);
	}

	context.set("user", signed.user);
	context.set("grant", signed.grant);
	context.set("client", client);

	// The rest of the request reads D1 through the tripwire's eyes (src/tripwire.ts): nothing of another user's.
	const started = Date.now();

	await watch(context, next);

	// Its sign-in's timeline (OPERATIONS.md O5): what it was (the action, as the behavior model names it), how it went,
	// how long, its trace. After the answer, not before it.
	const recorded = context.env.GRANTS.get(context.env.GRANTS.idFromString(signed.grant)).record({
		"route": actionOf(context.req.method, new URL(context.req.url), routePath(context, -1)),
		"status": context.res.status,
		"ms": Date.now() - started,
		"trace": (context.get("span") as { "traceId"?: string } | undefined)?.traceId ?? null
	}).catch(() => undefined);

	try {
		context.executionCtx.waitUntil(recorded);
	} catch {
		await recorded;
	}
});

/** The editor's routes: its account endpoints and the GitHub proxy. */
export const session = sessionFor("editor");

/** The admin API (src/admin.ts). */
export const adminSession = sessionFor("admin");
