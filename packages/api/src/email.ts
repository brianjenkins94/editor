import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { escapeHtml } from "@brianjenkins94/util/text";
import { codeHash as hash, isCode, newCode, shown, typed } from "@brianjenkins94/util/auth/codes";
import { CODE_TTL } from "./attempt.ts";
import { audit, origin } from "./audit.ts";
import { keyed } from "./behavior.ts";
import ACTION_HTML from "./action-code.html";
import ACTION_TEXT from "./action-code.txt";
import CODE_HTML from "./email-code.html";
import CODE_TEXT from "./email-code.txt";
import { canSend, send } from "./mail.ts";
import { signUpPaused, userWith } from "./identities.ts";
import { isPaused, SWITCHES } from "./maintenance.ts";
import { hasMfa } from "./mfa-state.ts";
import { heldAttempt } from "./attempt.ts";
import { askSecondFactor, signInAs } from "./signin.ts";
import { refusal } from "./refusals.ts";
import { methodsOf } from "./clients.ts";

/**
 * Signing in by email (SIGN-IN.md, "Email"; C2), from the sign-in page, for this browser's attempt (its cookie):
 *
 *   POST /auth/email          `address`: a code, and a link holding it, sent there; the attempt keeps the code's HMAC
 *   POST /auth/email/verify   `code`: checked against the attempt's (5 tries, one back a minute); a match finds the
 *                             address's user, or makes one, and starts the sign-in (Grant.begin), as GitHub's callback does
 *
 * The link is the sign-in page with the code in its fragment (`/sign-in#code=…`): the page sends it as if typed, which only
 * finishes the attempt in the browser that started it. Anywhere else, the page shows the code to type there; a mail
 * scanner opening the link does nothing (the fragment never reaches us, and there's no attempt to finish).
 *
 * Sending is limited per address (one a minute, five an hour), by the address's own `email_code_sent` rows; refusals are
 * `sign_in_refused` rows with their reason, as every sign-in refusal is. No lockouts: a bucket refills.
 */

const PER_MINUTE = 60_000;

const PER_HOUR = 5;





/** What's kept of a code: an HMAC under CODE_KEY, bound to what it's for (an attempt, or a user's action), so a leaked
 *  store can't be guessed at offline and a code works only where it was asked for (SIGN-IN.md, "Departures";
 *  util/auth/codes). */
export const codeHash = async (env: Bindings, bound: string, code: string): Promise<string> => hash(env.CODE_KEY as string, bound, code);

/**
 * Send `code` to `address`: the address's limits first (one a minute, five an hour, whatever the code is for: its own
 * `email_code_sent` rows, a keyed hash, never the address), then the email, then its row. A sign-in's email has the
 * link (src/email-code.*); an action's (setting a password) has only the code (src/action-code.*). What stopped it, if
 * something did: an HTTP status, an error and a reason for the caller to refuse with.
 */
export async function sendCode(context: Context<AppEnv>, address: string, code: string, purpose: { "kind": "sign-in" } | { "kind": "action"; "action": string }): Promise<{ "ok": true } | { "ok": false; "status": 429 | 502 | 503; "error": string; "reason": string }> {
	// Paused (the `email-codes` switch, src/maintenance.ts): no code goes out, whatever it was for.
	if (await isPaused(context.env, "email-codes")) {
		context.header("retry-after", "300");

		return { "ok": false, "status": 503, "error": "paused", "reason": SWITCHES["email-codes"].public };
	}

	const tag = await keyed(context.env, "email", address.toLowerCase());
	const now = Date.now();
	const sent = await context.env.DB.prepare("SELECT COUNT(*) AS count, MAX(at) AS last FROM audit WHERE event = 'email_code_sent' AND detail = ? AND at > ?").bind(tag, now - 3_600_000).first<{ "count": number; "last": number | null }>();

	if (sent !== null && sent.last !== null && now - sent.last < PER_MINUTE) {
		context.header("retry-after", String(Math.ceil((PER_MINUTE - (now - sent.last)) / 1000)));

		return { "ok": false, "status": 429, "error": "too_soon", "reason": "a code was sent less than a minute ago" };
	}

	if (sent !== null && sent.count >= PER_HOUR) {
		return { "ok": false, "status": 429, "error": "too_many", "reason": "five codes sent in the last hour" };
	}

	// The email: its .txt and .html, their {{placeholders}} filled (HTML-escaped in the HTML).
	const fill: Record<string, string> = { "code": shown(code), "link": `${new URL(context.req.url).origin}/sign-in#code=${code}`, "minutes": String(CODE_TTL / 60_000), "action": purpose.kind === "action" ? purpose.action : "" };
	const [text, html] = purpose.kind === "sign-in" ? [CODE_TEXT, CODE_HTML] : [ACTION_TEXT, ACTION_HTML];
	const mailed = await send(context.env, {
		"to": address,
		"subject": purpose.kind === "sign-in" ? `Your sign-in code: ${shown(code)}` : `Your code to ${purpose.action}: ${shown(code)}`,
		"text": text.replaceAll(/\{\{(\w+)\}\}/gu, (_, key: string) => fill[key] ?? ""),
		"html": html.replaceAll(/\{\{(\w+)\}\}/gu, (_, key: string) => escapeHtml(fill[key] ?? ""))
	});

	if ("reason" in mailed) {
		return { "ok": false, "status": 502, "error": "not_sent", "reason": `not sent: ${mailed.reason}` };
	}

	await audit(context.env, "email_code_sent", {}, await origin(context), { "detail": tag });

	return { "ok": true };
}

/** An address as typed, checked, not changed: something@domain.tld, no spaces, at most 254 characters. */
export const ADDRESS = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

const refuse = refusal("email");

/** This browser's attempt, if it's running and its client offers email. */
async function emailAttempt(context: Context<AppEnv>): Promise<{ "id": string; "secret": string; "stub": NonNullable<ReturnType<typeof heldAttempt>>["stub"] } | Response> {
	const held = heldAttempt(context);
	const described = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.describe(held.secret);

	if (held === undefined || "reason" in described) {
		return refuse(context, 401, "no_attempt", "reason" in described ? described.reason : "no attempt");
	}

	if (!methodsOf(described.client).includes("email")) {
		return refuse(context, 400, "not_offered", "method not offered");
	}

	if (!canSend(context.env) || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "email isn't set up here");
	}

	return held;
}

/** POST /auth/email: a code for this browser's attempt, sent to `address`. */
export async function emailEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = await emailAttempt(context);

	if (held instanceof Response) {
		return held;
	}

	const form = await context.req.parseBody();
	const address = typeof form["address"] === "string" ? form["address"] : "";

	if (address.length > 254 || !ADDRESS.test(address)) {
		return refuse(context, 400, "address", "not an email address");
	}

	const code = newCode();
	const kept = await held.stub.emailed(held.secret, address, await codeHash(context.env, held.id, code));

	if ("reason" in kept) {
		return refuse(context, 401, "no_attempt", kept.reason);
	}

	const sent = await sendCode(context, address, code, { "kind": "sign-in" });

	if ("reason" in sent) {
		return refuse(context, sent.status, sent.error, sent.reason);
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "expires_in": CODE_TTL / 1000 });
}

/** The user an address belongs to, proven theirs just now: found (whatever its case), or made with it. */
export async function userOf(env: Bindings, address: string, now: number): Promise<string> {
	return userWith(env, "email", address, now);
}

/** POST /auth/email/verify: the code, for this browser's attempt. A match starts the sign-in; the page goes on to
 *  `location`, the app's redirect page with our code, as GitHub's callback would have sent it. */
export async function verifyEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = await emailAttempt(context);

	if (held instanceof Response) {
		return held;
	}

	const form = await context.req.parseBody();
	const code = typed(typeof form["code"] === "string" ? form["code"] : "");

	if (!isCode(code)) {
		return refuse(context, 400, "code", "not a code");
	}

	const confirmed = await held.stub.confirm(held.secret, await codeHash(context.env, held.id, code));

	if ("reason" in confirmed) {
		return refuse(context, confirmed.reason === "too many tries" ? 429 : 400, "code", confirmed.reason);
	}

	// New accounts paused (the `sign-ups` switch): an address that's nobody's yet doesn't become one. Told only now, after
	// the code proved the address, so asking says nothing about whose addresses have accounts.
	if (await signUpPaused(context.env, "email", confirmed.address)) {
		return refuse(context, 503, "paused", SWITCHES["sign-ups"].public);
	}

	const user = await userOf(context.env, confirmed.address, Date.now());

	return await hasMfa(context.env, user) ? askSecondFactor(context, held, user, "email", "totp") : signInAs(context, held, user, "email");
}
