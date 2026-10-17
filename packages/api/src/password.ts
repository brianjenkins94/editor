import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { CODE_TTL } from "./attempt.ts";
import { audit, origin } from "./audit.ts";
import { ADDRESS, codeHash, isCode, newCode, sendCode, typed } from "./email.ts";
import { hashPassword, passwordProblem, verifyPassword } from "./password-hash.ts";
import { configureWasm } from "@hallaxius/argon2w";
import argon2Wasm from "@hallaxius/argon2w/wasm";

// Argon2's WebAssembly, as a module Wrangler compiles at deploy: the runtime won't compile any at runtime.
configureWasm(argon2Wasm);
import { canSend } from "./mail.ts";
import { hasMfa, mfaState, secondFactor } from "./mfa.ts";
import { askSecondFactor, forgetAttempt, heldAttempt, signInAs } from "./signin.ts";

/**
 * Passwords (SIGN-IN.md, "Passwords"; C3):
 *
 *   POST /auth/password                   `address`, `password`: sign in with a password, for this browser's attempt
 *   GET  /admin/account                   your sign-in methods: GitHub, your email, whether you have a password
 *   POST /admin/account/password/code     a code to your email, to set a password (the action's own check)
 *   POST /admin/account/password          `code`, `password`: the code, then the password set
 *   POST /auth/reset                      `address`: a code to it, to reset its password, for this browser's attempt (C4)
 *   POST /auth/reset/password             `address`, `code`, `password`, `end` (and `second`, with MFA on): the code, then
 *                                         the new password
 *
 * A password is set while signed in, never at sign-up: a password account starts as an email account, and its address
 * is what signs in with the password. The rules are Pilcrow's (printable ASCII, 10 to 100 characters, no space at either
 * end, nothing changed), and a password in a known breach is refused (Have I Been Pwned's range API: only the first 5
 * characters of its SHA-1 leave us). Hashed with Argon2id at OWASP's baseline (19 MiB, 2 passes, 1 lane, a 16-byte salt,
 * a 32-byte hash): src/password-hash.ts, through @hallaxius/argon2w (about 13 ms a hash in workerd).
 *
 * Tries are a bucket per user, 5 and one back a minute, and per IP the sign-in limit; no lockouts. Errors say what's
 * wrong (SIGN-IN.md): the time a hash takes tells anyone who asks whether an account exists anyway.
 */

const TRIES = 5;

const TRY_REFILL = 60_000;

/** The one action a code is for, so far. */
const SET_PASSWORD = "set-password";

const RESET_PASSWORD = "reset-password";

/** How many known breaches have this password (Have I Been Pwned, k-anonymity), or undefined if it couldn't be asked. */
export async function breaches(env: Bindings, password: string): Promise<number | undefined> {
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password)))].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
	const response = await fetch(`${env.PWNED_API ?? "https://api.pwnedpasswords.com"}/range/${digest.slice(0, 5)}`, { "headers": { "add-padding": "true", "user-agent": "editor-api" } }).catch(() => undefined);

	if (response?.ok !== true) {
		return undefined;
	}

	const line = (await response.text()).split("\n").find((entry) => entry.startsWith(`${digest.slice(5)}:`));

	return line === undefined ? 0 : Number.parseInt(line.split(":")[1] ?? "0", 10);
}

/** A bucket of tries, `tries` at `at`: what's in it now, one back each TRY_REFILL, at most TRIES. */
const refilled = (tries: number, at: number, now: number): number => Math.min(TRIES, tries + (now - at) / TRY_REFILL);

/** A refusal: recorded, and answered with what's wrong. */
async function refuse(context: Context<AppEnv>, status: 400 | 401 | 429 | 502 | 503, error: string, reason: string, event: "sign_in_refused" | "auth_refused" = "sign_in_refused"): Promise<Response> {
	context.get("span").info("password refused", { "reason": reason });
	await audit(context.env, event, event === "auth_refused" ? { "userId": context.get("user"), "grantId": context.get("grant") } : {}, await origin(context), { "reason": `password: ${reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	context.header("cache-control", "no-store");

	return context.json({ "error": error, "reason": reason }, status);
}

// ── Signing in with a password ─────────────────────────────────────────────────────────────────────────────────────

/** This browser's attempt, if it's running and its client offers passwords. */
async function passwordAttempt(context: Context<AppEnv>): Promise<NonNullable<ReturnType<typeof heldAttempt>> | Response> {
	const held = heldAttempt(context);
	const described = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.describe(held.secret);

	if (held === undefined || "reason" in described) {
		return refuse(context, 401, "no_attempt", "reason" in described ? described.reason : "no attempt");
	}

	if (!(context.env.SIGN_IN_METHODS[described.client] ?? []).includes("password")) {
		return refuse(context, 400, "not_offered", "method not offered");
	}

	return held;
}

/** The account with this address, if it has a password: or the refusal that says which it lacks. */
async function passwordAccount(context: Context<AppEnv>, address: string): Promise<{ "user_id": string; "hash": string } | Response> {
	if (address.length > 254 || !ADDRESS.test(address)) {
		return refuse(context, 400, "address", "not an email address");
	}

	const account = await context.env.DB.prepare("SELECT e.user_id, p.hash FROM emails e LEFT JOIN passwords p ON p.user_id = e.user_id WHERE lower(e.address) = lower(?)").bind(address).first<{ "user_id": string; "hash": string | null }>();

	if (account === null) {
		return refuse(context, 400, "no_account", "no account with that email");
	}

	return account.hash === null ? refuse(context, 400, "no_password", "that account has no password: sign in with a code") : { "user_id": account.user_id, "hash": account.hash };
}

/** POST /auth/password: `address` and `password`, for this browser's attempt. A match starts the sign-in; the page goes
 *  on to `location`, as with an emailed code. */
export async function passwordSignInEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = await passwordAttempt(context);

	if (held instanceof Response) {
		return held;
	}

	const form = await context.req.parseBody();
	const address = typeof form["address"] === "string" ? form["address"] : "";
	const password = typeof form["password"] === "string" ? form["password"] : "";

	if (address.length > 254 || !ADDRESS.test(address)) {
		return refuse(context, 400, "address", "not an email address");
	}

	const account = await context.env.DB.prepare("SELECT e.user_id, p.hash, p.tries, p.tries_at FROM emails e LEFT JOIN passwords p ON p.user_id = e.user_id WHERE lower(e.address) = lower(?)").bind(address).first<{ "user_id": string; "hash": string | null; "tries": number | null; "tries_at": number | null }>();

	if (account === null) {
		return refuse(context, 400, "no_account", "no account with that email");
	}

	if (account.hash === null) {
		return refuse(context, 400, "no_password", "that account has no password: sign in with a code");
	}

	const now = Date.now();
	const tries = refilled(account.tries ?? TRIES, account.tries_at ?? now, now);

	if (tries < 1) {
		return refuse(context, 429, "too_many_tries", "too many tries");
	}

	await context.env.DB.prepare("UPDATE passwords SET tries = ?, tries_at = ? WHERE user_id = ?").bind(tries - 1, now, account.user_id).run();

	if (!await verifyPassword(password, account.hash)) {
		return refuse(context, 400, "wrong_password", "wrong password");
	}

	return await hasMfa(context.env, account.user_id) ? askSecondFactor(context, held, account.user_id, "password") : signInAs(context, held, account.user_id, "password");
}

// ── Your account ───────────────────────────────────────────────────────────────────────────────────────────────────

/** GET /admin/account: how you can sign in: GitHub (its id), your email, and whether you have a password. */
export async function accountEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const [row, email, password] = await context.env.DB.batch([
		context.env.DB.prepare("SELECT github_id FROM users WHERE id = ?").bind(user),
		context.env.DB.prepare("SELECT address, verified_at FROM emails WHERE user_id = ?").bind(user),
		context.env.DB.prepare("SELECT set_at FROM passwords WHERE user_id = ?").bind(user)
	]);
	const address = email?.results[0] as { "address": string; "verified_at": number | null } | undefined;
	const set = password?.results[0] as { "set_at": number } | undefined;

	return context.json({
		"user": user,
		"githubId": (row?.results[0] as { "github_id": number | null } | undefined)?.github_id ?? null,
		"email": address === undefined ? null : { "address": address.address, "verifiedAt": address.verified_at },
		"password": set === undefined ? null : { "setAt": set.set_at },
		"mfa": await mfaState(context.env, user)
	});
}

/**
 * A code for one of `user`'s actions, emailed to `address`: its HMAC kept in `action_codes`, bound to `bound` (the user
 * and the action; for a reset, the browser's attempt too), for 10 minutes. A new code replaces the last, not the tries
 * left. The refusal, if it wasn't sent.
 */
async function issueActionCode(context: Context<AppEnv>, user: string, action: string, bound: string, address: string, words: string, event: "sign_in_refused" | "auth_refused"): Promise<Response | undefined> {
	if (!canSend(context.env) || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "email isn't set up here", event);
	}

	const code = newCode();
	const now = Date.now();

	await context.env.DB.prepare("INSERT INTO action_codes (user_id, action, code_hash, expires, tries, tries_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, action) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires").bind(user, action, await codeHash(context.env, bound, code), now + CODE_TTL, TRIES, now).run();

	const sent = await sendCode(context, address, code, { "kind": "action", "action": words });

	return "reason" in sent ? refuse(context, sent.status, sent.error, sent.reason, event) : undefined;
}

/**
 * Check `code` for `user`'s `action` (a try from its bucket, then the HMAC, then its time), then `password` (the rules,
 * then known breaches). The refusal, or nothing: then the password may be stored. The code isn't spent here, so a refused
 * password can be replaced without another email.
 */
async function checkCodeAndPassword(context: Context<AppEnv>, user: string, action: string, bound: string, code: string, password: string, event: "sign_in_refused" | "auth_refused"): Promise<Response | undefined> {
	const now = Date.now();
	const kept = await context.env.DB.prepare("SELECT code_hash, expires, tries, tries_at FROM action_codes WHERE user_id = ? AND action = ?").bind(user, action).first<{ "code_hash": string; "expires": number; "tries": number; "tries_at": number }>();

	if (kept === null) {
		return refuse(context, 400, "no_code", "ask for a code first", event);
	}

	const tries = refilled(kept.tries, kept.tries_at, now);

	if (tries < 1) {
		return refuse(context, 429, "too_many_tries", "too many tries", event);
	}

	await context.env.DB.prepare("UPDATE action_codes SET tries = ?, tries_at = ? WHERE user_id = ? AND action = ?").bind(tries - 1, now, user, action).run();

	const given = new TextEncoder().encode(isCode(typed(code)) ? await codeHash(context.env, bound, typed(code)) : "");
	const expected = new TextEncoder().encode(kept.code_hash);

	if (given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
		return refuse(context, 400, "code", "code wrong", event);
	}

	if (kept.expires < now) {
		return refuse(context, 400, "code", "code expired", event);
	}

	const problem = passwordProblem(password);

	if (problem !== undefined) {
		return refuse(context, 400, "password", problem, event);
	}

	const found = await breaches(context.env, password);

	if (found === undefined) {
		return refuse(context, 503, "breach_check", "couldn't check it against known breaches: try again", event);
	}

	return found > 0 ? refuse(context, 400, "breached", `found in ${found.toLocaleString("en")} known breaches: choose another`, event) : undefined;
}

/** Store `user`'s password (its tries full again), and spend the action's code. */
async function storePassword(env: Bindings, user: string, password: string, action: string): Promise<void> {
	const now = Date.now();

	await env.DB.batch([
		env.DB.prepare("INSERT INTO passwords (user_id, hash, set_at, tries, tries_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, set_at = excluded.set_at, tries = excluded.tries, tries_at = excluded.tries_at").bind(user, await hashPassword(password), now, TRIES, now),
		env.DB.prepare("DELETE FROM action_codes WHERE user_id = ? AND action = ?").bind(user, action)
	]);
}

/** POST /admin/account/password/code: a code to your email, for setting a password. */
export async function passwordCodeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const email = await context.env.DB.prepare("SELECT address FROM emails WHERE user_id = ?").bind(user).first<{ "address": string }>();

	if (email === null) {
		return refuse(context, 400, "no_email", "no email on this account: a password signs in with your email", "auth_refused");
	}

	const refused = await issueActionCode(context, user, SET_PASSWORD, `${user}:${SET_PASSWORD}`, email.address, "set a password", "auth_refused");

	if (refused !== undefined) {
		return refused;
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "address": email.address, "expires_in": CODE_TTL / 1000 });
}

/** POST /admin/account/password: `code` (the one just emailed) and `password`: checked (checkCodeAndPassword), then set. */
export async function setPasswordEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const form = await context.req.parseBody();
	const password = typeof form["password"] === "string" ? form["password"] : "";
	const refused = await checkCodeAndPassword(context, user, SET_PASSWORD, `${user}:${SET_PASSWORD}`, typeof form["code"] === "string" ? form["code"] : "", password, "auth_refused");

	if (refused !== undefined) {
		return refused;
	}

	await storePassword(context.env, user, password, SET_PASSWORD);
	await audit(context.env, "password_set", { "userId": user, "grantId": context.get("grant") }, await origin(context));
	context.header("cache-control", "no-store");

	return context.json({ "set": true });
}

// ── Resetting it (C4) ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a reset code is bound to: this browser's attempt, the account, and the action (so only this browser, for this
 *  account, can use it). */
const resetBound = (attempt: string, user: string): string => `${attempt}:${user}:${RESET_PASSWORD}`;

/** POST /auth/reset: `address`: a code to it, for resetting its account's password, in this browser's attempt. */
export async function resetCodeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = await passwordAttempt(context);

	if (held instanceof Response) {
		return held;
	}

	const form = await context.req.parseBody();
	const address = typeof form["address"] === "string" ? form["address"] : "";
	const account = await passwordAccount(context, address);

	if (account instanceof Response) {
		return account;
	}

	const refused = await issueActionCode(context, account.user_id, RESET_PASSWORD, resetBound(held.id, account.user_id), address, "reset your password", "sign_in_refused");

	if (refused !== undefined) {
		return refused;
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "expires_in": CODE_TTL / 1000 });
}

/**
 * POST /auth/reset/password: `address`, `code`, `password`, and `end` ("true" to end every sign-in of the account: asked,
 * not forced; SIGN-IN.md). The code and the password checked as setting one is, then stored. The attempt is spent, and no
 * session starts: the page sends you back to the app to sign in with the new password. (With MFA, C5, the second factor
 * will be asked for too.)
 */
export async function resetPasswordEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = await passwordAttempt(context);

	if (held instanceof Response) {
		return held;
	}

	const form = await context.req.parseBody();
	const field = (name: string): string => (typeof form[name] === "string" ? form[name] : "");
	const account = await passwordAccount(context, field("address"));

	if (account instanceof Response) {
		return account;
	}

	const refused = await checkCodeAndPassword(context, account.user_id, RESET_PASSWORD, resetBound(held.id, account.user_id), field("code"), field("password"), "sign_in_refused");

	if (refused !== undefined) {
		return refused;
	}

	// With MFA on, email alone isn't enough to reset (SIGN-IN.md): the second factor too, the app's or a recovery code.
	if (await hasMfa(context.env, account.user_id)) {
		if (field("second") === "") {
			return refuse(context, 400, "second_factor", "two-factor code needed: from your authenticator app, or a recovery code");
		}

		const second = await secondFactor(context.env, account.user_id, field("second"));

		if ("reason" in second) {
			return refuse(context, second.status, "second_factor", second.reason);
		}
	}

	await storePassword(context.env, account.user_id, field("password"), RESET_PASSWORD);
	await held.stub.finish(held.secret);
	forgetAttempt(context);

	const from = await origin(context);
	const { results } = field("end") === "true" ? await context.env.DB.prepare("SELECT id FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(account.user_id).all<{ "id": string }>() : { "results": [] };

	for (const { id } of results) {
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(id)).revoke({ "from": from, "reason": "password reset" });
	}

	await audit(context.env, "password_reset", { "userId": account.user_id }, from, { "reason": field("end") === "true" ? `every sign-in ended (${results.length})` : "other sign-ins kept" });
	context.header("cache-control", "no-store");

	return context.json({ "reset": true, "ended": results.length });
}
