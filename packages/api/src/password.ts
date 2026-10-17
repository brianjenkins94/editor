import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { deviceLabel } from "./account.ts";
import { CODE_TTL } from "./attempt.ts";
import { audit, origin } from "./audit.ts";
import { ADDRESS, codeHash, isCode, newCode, sendCode, typed } from "./email.ts";
import { answerUrl } from "./github.ts";
import { hashPassword, passwordProblem, verifyPassword } from "./password-hash.ts";
import { configureWasm } from "@hallaxius/argon2w";
import argon2Wasm from "@hallaxius/argon2w/wasm";

// Argon2's WebAssembly, as a module Wrangler compiles at deploy: the runtime won't compile any at runtime.
configureWasm(argon2Wasm);
import { canSend } from "./mail.ts";
import { forgetAttempt, heldAttempt } from "./signin.ts";

/**
 * Passwords (SIGN-IN.md, "Passwords"; C3):
 *
 *   POST /auth/password                   `address`, `password`: sign in with a password, for this browser's attempt
 *   GET  /admin/account                   your sign-in methods: GitHub, your email, whether you have a password
 *   POST /admin/account/password/code     a code to your email, to set a password (the action's own check)
 *   POST /admin/account/password          `code`, `password`: the code, then the password set
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

/** POST /auth/password: `address` and `password`, for this browser's attempt. A match starts the sign-in; the page goes
 *  on to `location`, as with an emailed code. */
export async function passwordSignInEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);
	const described = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.describe(held.secret);

	if (held === undefined || "reason" in described) {
		return refuse(context, 401, "no_attempt", "reason" in described ? described.reason : "no attempt");
	}

	if (!(context.env.SIGN_IN_METHODS[described.client] ?? []).includes("password")) {
		return refuse(context, 400, "not_offered", "method not offered");
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

	const finished = await held.stub.finish(held.secret);

	forgetAttempt(context);

	if ("reason" in finished) {
		return refuse(context, 401, "no_attempt", finished.reason);
	}

	const grant = context.env.GRANTS.get(context.env.GRANTS.newUniqueId());
	const { "code": ours } = await grant.begin({ "client": finished.request.client, "userId": account.user_id, "method": "password", "codeChallenge": finished.request.codeChallenge, "jkt": finished.request.jkt, "from": await origin(context), "label": deviceLabel(context.req.header("user-agent")) });

	context.header("cache-control", "no-store");

	return context.json({ "location": answerUrl(context, finished.request, { "code": ours }) });
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
		"password": set === undefined ? null : { "setAt": set.set_at }
	});
}

/** POST /admin/account/password/code: a code to your email, for setting a password. */
export async function passwordCodeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const email = await context.env.DB.prepare("SELECT address FROM emails WHERE user_id = ?").bind(user).first<{ "address": string }>();

	if (email === null) {
		return refuse(context, 400, "no_email", "no email on this account: a password signs in with your email", "auth_refused");
	}

	if (!canSend(context.env) || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "email isn't set up here", "auth_refused");
	}

	const code = newCode();
	const now = Date.now();

	// A new code replaces the last, not the tries left.
	await context.env.DB.prepare("INSERT INTO action_codes (user_id, action, code_hash, expires, tries, tries_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, action) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires").bind(user, SET_PASSWORD, await codeHash(context.env, `${user}:${SET_PASSWORD}`, code), now + CODE_TTL, TRIES, now).run();

	const sent = await sendCode(context, email.address, code, { "kind": "action", "action": "set a password" });

	if ("reason" in sent) {
		return refuse(context, sent.status, sent.error, sent.reason, "auth_refused");
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "address": email.address, "expires_in": CODE_TTL / 1000 });
}

/** POST /admin/account/password: `code` (the one just emailed) and `password`. The code is checked first (a try from its
 *  bucket), then the password's rules and breaches; the code is spent only when the password is set, so a refused password
 *  can be replaced without another email. */
export async function setPasswordEndpoint(context: Context<AppEnv>): Promise<Response> {
	const user = context.get("user");
	const form = await context.req.parseBody();
	const code = typed(typeof form["code"] === "string" ? form["code"] : "");
	const password = typeof form["password"] === "string" ? form["password"] : "";
	const now = Date.now();
	const kept = await context.env.DB.prepare("SELECT code_hash, expires, tries, tries_at FROM action_codes WHERE user_id = ? AND action = ?").bind(user, SET_PASSWORD).first<{ "code_hash": string; "expires": number; "tries": number; "tries_at": number }>();

	if (kept === null) {
		return refuse(context, 400, "no_code", "ask for a code first", "auth_refused");
	}

	const tries = refilled(kept.tries, kept.tries_at, now);

	if (tries < 1) {
		return refuse(context, 429, "too_many_tries", "too many tries", "auth_refused");
	}

	await context.env.DB.prepare("UPDATE action_codes SET tries = ?, tries_at = ? WHERE user_id = ? AND action = ?").bind(tries - 1, now, user, SET_PASSWORD).run();

	const given = new TextEncoder().encode(isCode(code) ? await codeHash(context.env, `${user}:${SET_PASSWORD}`, code) : "");
	const expected = new TextEncoder().encode(kept.code_hash);

	if (given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
		return refuse(context, 400, "code", "code wrong", "auth_refused");
	}

	if (kept.expires < now) {
		return refuse(context, 400, "code", "code expired", "auth_refused");
	}

	const problem = passwordProblem(password);

	if (problem !== undefined) {
		return refuse(context, 400, "password", problem, "auth_refused");
	}

	const found = await breaches(context.env, password);

	if (found === undefined) {
		return refuse(context, 503, "breach_check", "couldn't check it against known breaches: try again", "auth_refused");
	}

	if (found > 0) {
		return refuse(context, 400, "breached", `found in ${found.toLocaleString("en")} known breaches: choose another`, "auth_refused");
	}

	await context.env.DB.batch([
		context.env.DB.prepare("INSERT INTO passwords (user_id, hash, set_at, tries, tries_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, set_at = excluded.set_at, tries = excluded.tries, tries_at = excluded.tries_at").bind(user, await hashPassword(password), now, TRIES, now),
		context.env.DB.prepare("DELETE FROM action_codes WHERE user_id = ? AND action = ?").bind(user, SET_PASSWORD)
	]);
	await audit(context.env, "password_set", { "userId": user, "grantId": context.get("grant") }, await origin(context));
	context.header("cache-control", "no-store");

	return context.json({ "set": true });
}
