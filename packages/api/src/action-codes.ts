import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { CODE_TTL } from "./attempt.ts";
import { codeHash, isCode, newCode, sendCode, typed } from "./email.ts";
import { canSend } from "./mail.ts";
import { refusal } from "./refusals.ts";

/**
 * Codes for one action of a user's (SIGN-IN.md: sensitive actions take a fresh, action-specific check): setting or
 * resetting a password (src/password.ts), turning two-factor by email on or off (src/mfa.ts). Each is emailed, kept as
 * an HMAC in `action_codes` bound to what it's for, good for 10 minutes, 5 tries a bucket; the caller spends it once the
 * action is done.
 */

const TRIES = 5;

const TRY_REFILL = 60_000;

const refuse = refusal("code");

/**
 * A code for one of `user`'s actions, emailed to `address`: its HMAC kept in `action_codes`, bound to `bound` (the user
 * and the action; for a reset, the browser's attempt too), for 10 minutes. A new code replaces the last, not the tries
 * left. The refusal, if it wasn't sent.
 */
export async function issueActionCode(context: Context<AppEnv>, user: string, action: string, bound: string, address: string, words: string, event: "sign_in_refused" | "auth_refused"): Promise<Response | undefined> {
	if (!canSend(context.env) || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "email isn't set up here", event);
	}

	const code = newCode();
	const now = Date.now();

	await context.env.DB.prepare("INSERT INTO action_codes (user_id, action, code_hash, expires, tries, tries_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, action) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires").bind(user, action, await codeHash(context.env, bound, code), now + CODE_TTL, TRIES, now).run();

	const sent = await sendCode(context, address, code, { "kind": "action", "action": words });

	return "reason" in sent ? refuse(context, sent.status, sent.error, sent.reason, event) : undefined;
}

/** Check `code` for `user`'s `action`: a try from its bucket, then the HMAC (bound to `bound`), then its time. The
 *  refusal, or nothing. The code isn't spent here: the caller spends it once the action is done. */
export async function checkActionCode(context: Context<AppEnv>, user: string, action: string, bound: string, code: string, event: "sign_in_refused" | "auth_refused"): Promise<Response | undefined> {
	const now = Date.now();
	const kept = await context.env.DB.prepare("SELECT code_hash, expires, tries, tries_at FROM action_codes WHERE user_id = ? AND action = ?").bind(user, action).first<{ "code_hash": string; "expires": number; "tries": number; "tries_at": number }>();

	if (kept === null) {
		return refuse(context, 400, "no_code", "ask for a code first", event);
	}

	const tries = Math.min(TRIES, kept.tries + (now - kept.tries_at) / TRY_REFILL);

	if (tries < 1) {
		return refuse(context, 429, "too_many_tries", "too many tries", event);
	}

	await context.env.DB.prepare("UPDATE action_codes SET tries = ?, tries_at = ? WHERE user_id = ? AND action = ?").bind(tries - 1, now, user, action).run();

	const given = new TextEncoder().encode(isCode(typed(code)) ? await codeHash(context.env, bound, typed(code)) : "");
	const expected = new TextEncoder().encode(kept.code_hash);

	if (given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
		return refuse(context, 400, "code", "code wrong", event);
	}

	return kept.expires < now ? refuse(context, 400, "code", "code expired", event) : undefined;
}

