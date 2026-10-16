import type { Context } from "hono";
import type { JWK } from "jose";
import type { Grant } from "./grant.ts";
import { nonces, publicKey, signAccessToken, verifyAccessToken, verifyProof } from "@brianjenkins94/util/auth/dpop";
import { createMiddleware } from "hono/factory";
import type { Subject } from "./audit.ts";
import { audit, origin } from "./audit.ts";
import type { AppEnv, Bindings } from "./env.ts";

/**
 * Our tokens (README.md, "Tokens and the flow"): /token redeems a code or rotates a refresh token for a DPoP-bound access
 * token, /revoke ends a sign-in, and `session` puts DPoP in front of a route. Every request carries a proof of the
 * sign-in's key, with a server nonce (a `use_dpop_nonce` answer hands out a fresh one).
 */

const ACCESS_TTL = 300;

const CLIENT_ID = "editor";

/** The issuer, and the audience: this Worker, by the origin it was reached at. */
const issuer = (context: Context<AppEnv>): string => new URL(context.req.url).origin;

const signingKey = (env: Bindings): JWK => JSON.parse(env.SIGNING_JWK) as JWK;

const nonce = (env: Bindings): ReturnType<typeof nonces> => nonces(env.NONCE_KEY);

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
		await audit(context.env, "auth_refused", subject, await origin(context), { "reason": reason, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
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

	if (typeof presented !== "string" || (grantType === "authorization_code" && typeof form["code_verifier"] !== "string") || form["client_id"] !== CLIENT_ID) {
		return oauthError(context, "invalid_request", "missing parameters");
	}

	const grant = await grantOf(context, presented);

	if (grant === "revoked") {
		return oauthError(context, "invalid_grant", "grant revoked", { "recorded": true });
	}

	if (grant === undefined) {
		return oauthError(context, "invalid_grant", "no such grant");
	}

	const proof = await verifyProof({ "method": "POST", "url": context.req.url, "proof": context.req.header("dpop") }, { "nonce": nonce(context.env).check, "seen": async (jti, expires) => (await grant.stub.use(jti, expires)).seen });

	if ("error" in proof) {
		return oauthError(context, proof.error, proof.reason, { "subject": { "grantId": grant.id } });
	}

	const from = await origin(context);
	const issued = grantType === "authorization_code"
		? await grant.stub.redeem({ "code": presented, "verifier": form["code_verifier"] as string, "jkt": proof.jkt, "from": from })
		: await grant.stub.rotate({ "refreshToken": presented, "jkt": proof.jkt, "from": from });

	if (!issued.ok) {
		return oauthError(context, "invalid_grant", "code or refresh token refused", { "recorded": true });
	}

	const iss = issuer(context);
	const accessToken = await signAccessToken(signingKey(context.env), { "iss": iss, "aud": iss, "sub": issued.userId, "jkt": proof.jkt, "clientId": CLIENT_ID, "extra": { "grant": grant.id } }, { "ttl": ACCESS_TTL });

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
		const proof = await verifyProof({ "method": "POST", "url": context.req.url, "proof": context.req.header("dpop") }, { "nonce": nonce(context.env).check, "seen": async (jti, expires) => (await grant.stub.use(jti, expires)).seen });

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
		await audit(context.env, "auth_refused", subject, await origin(context), { "reason": reason, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	}

	context.header("www-authenticate", `DPoP error="${error}", algs="ES256 ES384 ES512 PS256 PS384 PS512 EdDSA"`);

	if (error === "use_dpop_nonce") {
		context.header("dpop-nonce", await nonce(context.env).issue());
	}

	return context.json({ "error": error }, 401);
}

/**
 * DPoP in front of a route: `Authorization: DPoP <access token>` (ours, unexpired, bound to a key), a proof from that key
 * for this request with the access token's hash and a current nonce, a jti the grant hasn't seen, and a live grant.
 * Leaves `user` and `grant` for the route.
 */
export const session = createMiddleware<AppEnv>(async (context, next) => {
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
	let active = false;
	const proof = await verifyProof({ "method": context.req.method, "url": context.req.url, "proof": context.req.header("dpop"), "accessToken": accessToken, "jkt": token.claims.cnf.jkt }, {
		"nonce": nonce(context.env).check,
		"seen": async (jti, expires) => {
			const use = await stub.use(jti, expires);

			active = use.active;

			return use.seen;
		}
	});

	if ("error" in proof) {
		return unauthorized(context, proof.error, proof.reason, { "userId": token.claims.sub, "grantId": grantId });
	}

	if (!active) {
		return unauthorized(context, "invalid_token", "grant revoked", { "userId": token.claims.sub, "grantId": grantId });
	}

	context.set("user", token.claims.sub as string);
	context.set("grant", grantId);

	await next();
});
