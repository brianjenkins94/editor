import type { Context } from "hono";
import type { Pushed } from "./attempt.ts";
import type { AppEnv } from "./env.ts";
import { verifyProof } from "@brianjenkins94/util/auth/dpop";
import { attemptOf, forgetAttempt, heldAttempt, holdAttempt, PUSH_TTL } from "./attempt.ts";
import { audit, origin } from "./audit.ts";
import { deviceLabel } from "./account.ts";
import { answerUrl, toGitHub } from "./github.ts";
import { canSend } from "./mail.ts";
import { nonce } from "./tokens.ts";
import { oauthRefusal } from "./refusals.ts";
import { CLIENTS, isClient, methodsOf, pagesOf } from "./clients.ts";
import { isPaused, maintenance } from "./maintenance.ts";

/**
 * Signing in through our own page (SIGN-IN.md, "The shape"):
 *
 *   POST /auth/par      the client pushes its authorization request (RFC 9126), proven with a DPoP proof and our nonce:
 *                       an attempt is made, and the client gets an opaque request_uri for it
 *   GET  /auth/start    the browser arrives with only client_id and request_uri: the attempt opens, once, in this
 *                       browser (its cookie), and the browser goes on to the sign-in page (public/sign-in.html)
 *   GET  /auth/attempt  what the page may offer this attempt: its client's methods (SIGN_IN_METHODS), email only where
 *                       email can be sent (a binding or the outbox, and CODE_KEY)
 *   GET  /auth/github   the page's GitHub choice: on to GitHub, the attempt in GitHub's sealed state; GitHub's callback
 *                       (github.ts) finishes the attempt in the same browser and starts the sign-in (Grant.begin)
 *
 * Every refusal is recorded (`sign_in_refused`, with its reason). The legacy /auth/github/start (front-channel request,
 * straight to GitHub) stays for the editor until it moves over (SIGN-IN.md, C7).
 */

const REQUEST_URI = "urn:ietf:params:oauth:request_uri:";

/** A base64url SHA-256 (43 characters): what a PKCE S256 challenge is. */
const DIGEST = /^[\w-]{43}$/u;

/**
 * The end of a sign-in by one of our own methods (an emailed code, a password, then a second factor if the account has
 * MFA): this browser's attempt finished, once, its cookie gone, and the sign-in started for `user` (Grant.begin, its
 * `login` row saying `method`). The answer is where the page goes next: the app's redirect page with our code, as
 * GitHub's callback sends it.
 */
export async function signInAs(context: Context<AppEnv>, held: NonNullable<ReturnType<typeof heldAttempt>>, user: string, method: string): Promise<Response> {
	const finished = await held.stub.finish(held.secret);

	forgetAttempt(context);
	context.header("cache-control", "no-store");

	if ("reason" in finished) {
		await audit(context.env, "sign_in_refused", {}, await origin(context), { "reason": finished.reason, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });

		return context.json({ "error": "no_attempt", "reason": finished.reason }, 401);
	}

	const grant = context.env.GRANTS.get(context.env.GRANTS.newUniqueId());
	const { "code": ours } = await grant.begin({ "client": finished.request.client, "userId": user, "method": method, "codeChallenge": finished.request.codeChallenge, "jkt": finished.request.jkt, "from": await origin(context), "label": deviceLabel(context.req.header("user-agent")) });

	return context.json({ "location": answerUrl(context, finished.request, { "code": ours }) });
}

/** After a first factor, for an account with MFA: the attempt remembers whom it found and how, and the page asks for the
 *  second (`second_factor`: "totp", an authenticator app's code or a recovery code; "email", a code just emailed). */
export async function askSecondFactor(context: Context<AppEnv>, held: NonNullable<ReturnType<typeof heldAttempt>>, user: string, method: string, kind: "totp" | "email"): Promise<Response> {
	await held.stub.passed(held.secret, user, method);
	context.header("cache-control", "no-store");

	return context.json({ "second_factor": kind });
}

const refuse = oauthRefusal;

/** POST /auth/par: the client's authorization request, pushed. 201 with its request_uri. */
export async function parEndpoint(context: Context<AppEnv>): Promise<Response> {
	const form = await context.req.parseBody();
	const field = (name: string): string => (typeof form[name] === "string" ? form[name] : "");
	const client = field("client_id");

	if (!isClient(client) || field("response_type") !== "code") {
		return refuse(context, "client_id or response_type");
	}

	if (!pagesOf(context.env, client).includes(field("redirect_uri"))) {
		return refuse(context, "redirect_uri not registered");
	}

	if (field("code_challenge_method") !== "S256" || !DIGEST.test(field("code_challenge")) || field("state") === "" || field("state").length > 512) {
		return refuse(context, "PKCE or state");
	}

	// The key the sign-in will be bound to is proven here, with our nonce: nothing is pushed for a key nobody holds.
	const proof = await verifyProof({ "method": "POST", "url": context.req.url, "proof": context.req.header("dpop") }, { "nonce": nonce(context.env).check, "seen": () => false });

	if ("error" in proof) {
		if (proof.error === "use_dpop_nonce") {
			context.header("dpop-nonce", await nonce(context.env).issue());
			context.header("cache-control", "no-store");

			return context.json({ "error": "use_dpop_nonce" }, 400);
		}

		return refuse(context, proof.reason);
	}

	const id = context.env.ATTEMPTS.newUniqueId();
	const request: Pushed = { "client": client, "redirectUri": field("redirect_uri"), "state": field("state"), "codeChallenge": field("code_challenge"), "jkt": proof.jkt };

	await context.env.ATTEMPTS.get(id).push(request);
	context.header("cache-control", "no-store");

	return context.json({ "request_uri": `${REQUEST_URI}${id.toString()}`, "expires_in": PUSH_TTL / 1000 }, 201);
}

/** GET /auth/start: open the pushed request's attempt in this browser, then the sign-in page. */
export async function startEndpoint(context: Context<AppEnv>): Promise<Response> {
	const client = context.req.query("client_id") ?? "";
	const requestUri = context.req.query("request_uri") ?? "";
	const stub = requestUri.startsWith(REQUEST_URI) ? attemptOf(context, requestUri.slice(REQUEST_URI.length)) : undefined;

	if (stub === undefined) {
		return refuse(context, "request_uri");
	}

	const opened = await stub.open(client);

	if ("reason" in opened) {
		return refuse(context, opened.reason);
	}

	holdAttempt(context, requestUri.slice(REQUEST_URI.length), opened.secret);
	context.header("cache-control", "no-store");

	return context.redirect("/sign-in", 302);
}

/** GET /auth/attempt: what the sign-in page may show for this browser's attempt. */
export async function attemptEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);
	const described = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.describe(held.secret);

	context.header("cache-control", "no-store");

	if ("reason" in described) {
		return context.json({ "error": "no_attempt" }, 401);
	}

	// Email needs mail set up here, and emailed codes not paused (the `email-codes` switch, src/maintenance.ts).
	const emailing = canSend(context.env) && context.env.CODE_KEY !== undefined && !await isPaused(context.env, "email-codes");
	const ready = (method: string): boolean => method !== "email" || emailing;
	// While the kill switch is on, only the owner's way back in: the admin client, by GitHub or a passkey (src/maintenance.ts).
	const now = (await maintenance(context.env)).on ? (method: string): boolean => method === "github" || method === "passkey" : () => true;

	return context.json({ "client": described.client, "name": isClient(described.client) ? CLIENTS[described.client].name : described.client, "methods": methodsOf(described.client).filter(ready).filter(now) });
}

/** GET /auth/github: the page's GitHub choice, for this browser's attempt, when its client offers GitHub. */
export async function githubEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);
	const described = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.describe(held.secret);

	if (held === undefined || "reason" in described) {
		return refuse(context, "reason" in described ? described.reason : "no attempt", 401);
	}

	if (!methodsOf(described.client).includes("github")) {
		return refuse(context, "method not offered");
	}

	return toGitHub(context, { "attempt": held.id });
}
