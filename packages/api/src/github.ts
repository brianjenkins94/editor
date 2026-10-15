import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";
import { base64url } from "jose";
import { origin } from "./audit.ts";
import { open, seal } from "./seal.ts";

/**
 * Signing in with GitHub (README.md, "Tokens and the flow", steps 1–2). The app sends the browser to /auth/github/start
 * with its PKCE challenge, its DPoP key's thumbprint and its own state; we send it on to GitHub with a PKCE pair of our
 * own, and everything else sealed into GitHub's `state` (STATE_KEY, 10 minutes), so nothing is stored until GitHub says
 * who the user is. /auth/github/callback exchanges GitHub's code, starts a Grant, and sends the browser back to the app
 * with our code — which only the app's PKCE verifier and DPoP key can redeem.
 */

const STATE_TTL = 600_000;

const CLIENT_ID = "editor";

/** What rides through GitHub, sealed. */
interface Pending {
	"redirectUri": string;
	"state": string;
	"codeChallenge": string;
	"jkt": string;
	"verifier": string;
	"expires": number;
}

/** GitHub's origins: the real ones, but for tests (GITHUB_ORIGIN / GITHUB_API, never set in wrangler.jsonc). */
export const github = (env: AppEnv["Bindings"]): { "web": string; "api": string } => ({ "web": env.GITHUB_ORIGIN ?? "https://github.com", "api": env.GITHUB_API ?? "https://api.github.com" });

/** Our callback, at the origin we were reached at: it has to be one of the GitHub App's redirect URIs. */
const callback = (context: Context<AppEnv>): string => `${new URL(context.req.url).origin}/auth/github/callback`;

/** A base64url SHA-256 (43 characters): what a PKCE S256 challenge and a JWK thumbprint both are. */
const DIGEST = /^[\w-]{43}$/u;

function refuse(context: Context<AppEnv>, reason: string): Response {
	context.get("span").info("sign-in refused", { "reason": reason });

	return context.json({ "error": "invalid_request" }, 400);
}

/** Back to the app with an OAuth answer: `code` on success, `error` otherwise; always its own `state`, and our `iss`. */
function answer(context: Context<AppEnv>, pending: Pending, parameters: Record<string, string>): Response {
	const target = new URL(pending.redirectUri);

	for (const [key, value] of Object.entries({ ...parameters, "state": pending.state, "iss": new URL(context.req.url).origin })) {
		target.searchParams.set(key, value);
	}

	context.header("cache-control", "no-store");

	return context.redirect(target.href, 302);
}

/** GET /auth/github/start (an OAuth authorization endpoint, RFC 6749 §4.1.1 with PKCE and RFC 9449's dpop_jkt). */
export async function startEndpoint(context: Context<AppEnv>): Promise<Response> {
	const query = context.req.query();

	if (query["client_id"] !== CLIENT_ID || query["response_type"] !== "code") {
		return refuse(context, "client_id or response_type");
	}

	// Exact match only: an app origin's own page, never anywhere a code could leak to.
	if (!context.env.REDIRECT_URIS.split(",").includes(query["redirect_uri"] ?? "")) {
		return refuse(context, "redirect_uri not registered");
	}

	if (query["code_challenge_method"] !== "S256" || !DIGEST.test(query["code_challenge"] ?? "") || !DIGEST.test(query["dpop_jkt"] ?? "") || (query["state"] ?? "") === "" || (query["state"] ?? "").length > 512) {
		return refuse(context, "PKCE, dpop_jkt or state");
	}

	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const pending: Pending = { "redirectUri": query["redirect_uri"] as string, "state": query["state"] as string, "codeChallenge": query["code_challenge"] as string, "jkt": query["dpop_jkt"] as string, "verifier": verifier, "expires": Date.now() + STATE_TTL };
	const authorize = new URL("/login/oauth/authorize", github(context.env).web);

	authorize.search = new URLSearchParams({
		"client_id": context.env.GITHUB_CLIENT_ID,
		"redirect_uri": callback(context),
		"state": await seal(context.env.STATE_KEY, JSON.stringify(pending), "github-state"),
		"code_challenge": await s256(verifier),
		"code_challenge_method": "S256"
	}).toString();

	context.header("cache-control", "no-store");

	return context.redirect(authorize.href, 302);
}

/** GET /auth/github/callback: GitHub's answer — exchanged for the user's tokens and id, then a Grant and our code. */
export async function callbackEndpoint(context: Context<AppEnv>): Promise<Response> {
	let pending: Pending;

	try {
		pending = JSON.parse(await open(context.env.STATE_KEY, context.req.query("state") ?? "", "github-state")) as Pending;
	} catch {
		return refuse(context, "state doesn't open");
	}

	if (pending.expires < Date.now()) {
		return refuse(context, "state expired");
	}

	const code = context.req.query("code");

	if (code === undefined) {
		context.get("span").info("sign-in declined at GitHub", { "reason": "no code" });

		return answer(context, pending, { "error": context.req.query("error") === "access_denied" ? "access_denied" : "server_error" });
	}

	const { web, api } = github(context.env);
	const exchanged = await fetch(`${web}/login/oauth/access_token`, {
		"method": "POST",
		"headers": { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
		"body": new URLSearchParams({ "client_id": context.env.GITHUB_CLIENT_ID, "client_secret": context.env.GITHUB_CLIENT_SECRET, "code": code, "redirect_uri": callback(context), "code_verifier": pending.verifier })
	}).then((response) => response.json()).catch(() => ({})) as { "access_token"?: string; "refresh_token"?: string; "expires_in"?: number; "refresh_token_expires_in"?: number };

	// A GitHub App with expiring user tokens always gives both (README.md: "Expire user authorization tokens" on).
	if (typeof exchanged.access_token !== "string" || typeof exchanged.refresh_token !== "string") {
		context.get("span").info("sign-in failed at GitHub", { "reason": "code exchange" });

		return answer(context, pending, { "error": "server_error" });
	}

	const user = await fetch(`${api}/user`, { "headers": { "authorization": `Bearer ${exchanged.access_token}`, "accept": "application/vnd.github+json", "user-agent": "editor-api", "x-github-api-version": "2022-11-28" } })
		.then((response) => (response.ok ? response.json() : {}))
		.catch(() => ({})) as { "id"?: unknown };

	if (typeof user.id !== "number") {
		context.get("span").info("sign-in failed at GitHub", { "reason": "user" });

		return answer(context, pending, { "error": "server_error" });
	}

	const now = Date.now();
	const grant = context.env.GRANTS.get(context.env.GRANTS.newUniqueId());
	const { "code": ours } = await grant.begin({
		"githubId": user.id,
		"github": { "accessToken": exchanged.access_token, "refreshToken": exchanged.refresh_token, "expiresAt": now + (exchanged.expires_in ?? 28_800) * 1000, "refreshExpiresAt": now + (exchanged.refresh_token_expires_in ?? 15_897_600) * 1000 },
		"codeChallenge": pending.codeChallenge,
		"jkt": pending.jkt,
		"from": await origin(context.req.raw, context.env.AUDIT_KEY)
	});

	return answer(context, pending, { "code": ours });
}

/** GET /.well-known/oauth-authorization-server (RFC 8414): what a client (the shell's oauth4webapi) needs to find us. */
export function metadataEndpoint(context: Context<AppEnv>): Response {
	const issuer = new URL(context.req.url).origin;

	return context.json({
		"issuer": issuer,
		"authorization_endpoint": `${issuer}/auth/github/start`,
		"token_endpoint": `${issuer}/token`,
		"revocation_endpoint": `${issuer}/revoke`,
		"jwks_uri": `${issuer}/.well-known/jwks.json`,
		"response_types_supported": ["code"],
		"grant_types_supported": ["authorization_code", "refresh_token"],
		"code_challenge_methods_supported": ["S256"],
		"token_endpoint_auth_methods_supported": ["none"],
		"dpop_signing_alg_values_supported": ["ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"],
		"authorization_response_iss_parameter_supported": true
	});
}
