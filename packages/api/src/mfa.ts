import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { open, seal } from "@brianjenkins94/util/auth/seal";
import { base64url } from "jose";
import { audit, origin } from "./audit.ts";
import { heldAttempt, signInAs } from "./signin.ts";
import { base32, isRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, typedRecovery, unbase32, verifyTotp } from "./totp.ts";

/**
 * Authenticator-app MFA (SIGN-IN.md, "MFA, optional"; C5), for your own account, from the admin app's Your account page:
 *
 *   POST /admin/account/mfa/start      a new secret, pending: the app scans its QR code
 *   POST /admin/account/mfa/confirm    `code`, from the app: it's on, and ten recovery codes, shown this once
 *   POST /admin/account/mfa/off        `code`, the app's or a recovery code: it's off
 *   POST /admin/account/mfa/recovery   `code`, the app's: ten new recovery codes, the old ones gone
 *
 * Each needs a recent sign-in (within RECENT): the action's own check, and the one every account can pass, GitHub's
 * included (SIGN-IN.md, "Departures"). Turning it off and new recovery codes need the second factor itself too.
 *
 * `secondFactor` is the check at sign-in (after an emailed code or a password, before the session starts: POST
 * /auth/second, `code`) and in a password reset: the app's code (each 30-second step once) or a recovery code (each
 * once), 5 tries a bucket.
 */

/** How recent a sign-in must be to change MFA. */
const RECENT = 10 * 60_000;

const TRIES = 5;

const TRY_REFILL = 60_000;

/** Where a sealed TOTP secret belongs: bound to its user, so one can't be moved to another. */
const sealedFor = (user: string): string => `totp:${user}`;

/** A recovery code as kept: an HMAC under CODE_KEY, bound to its user (as emailed codes are, src/email.ts). */
async function recoveryHash(env: Bindings, user: string, code: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CODE_KEY), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);

	return base64url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${user}:recovery:${typedRecovery(code)}`))));
}

/** Whether `user` has MFA on. */
export async function hasMfa(env: Bindings, user: string): Promise<boolean> {
	return (await env.DB.prepare("SELECT 1 FROM totp WHERE user_id = ? AND enrolled_at IS NOT NULL").bind(user).first()) !== null;
}

/**
 * The second factor: an app's code or a recovery code, for `user`. Spends a try, then what it matched (a step, or a
 * recovery code), so neither works twice. What it was, or why not.
 */
export async function secondFactor(env: Bindings, user: string, code: string, now = Date.now()): Promise<{ "ok": true; "kind": "totp" | "recovery" } | { "ok": false; "reason": string; "status": 400 | 429 }> {
	const row = await env.DB.prepare("SELECT secret, last_step, tries, tries_at FROM totp WHERE user_id = ? AND enrolled_at IS NOT NULL").bind(user).first<{ "secret": string; "last_step": number; "tries": number; "tries_at": number }>();

	if (row === null || env.TOTP_KEK === undefined) {
		return { "ok": false, "reason": "two-factor isn't on for this account", "status": 400 };
	}

	const tries = Math.min(TRIES, row.tries + (now - row.tries_at) / TRY_REFILL);

	if (tries < 1) {
		return { "ok": false, "reason": "too many tries", "status": 429 };
	}

	await env.DB.prepare("UPDATE totp SET tries = ?, tries_at = ? WHERE user_id = ?").bind(tries - 1, now, user).run();

	if (isRecoveryCode(typedRecovery(code))) {
		const used = await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").bind(now, user, await recoveryHash(env, user, code)).run();

		return used.meta.changes === 1 ? { "ok": true, "kind": "recovery" } : { "ok": false, "reason": "that recovery code isn't one of yours, or it's been used", "status": 400 };
	}

	const step = await verifyTotp(unbase32(await open(env.TOTP_KEK, row.secret, sealedFor(user))), code.replaceAll(/\s/gu, ""), now, row.last_step);

	if (step === undefined) {
		return { "ok": false, "reason": "that code isn't right, or it's been used", "status": 400 };
	}

	// Only if no other request took this step meanwhile: a code is good once.
	const took = await env.DB.prepare("UPDATE totp SET last_step = ? WHERE user_id = ? AND last_step < ?").bind(step, user, step).run();

	return took.meta.changes === 1 ? { "ok": true, "kind": "totp" } : { "ok": false, "reason": "that code isn't right, or it's been used", "status": 400 };
}

/** A refusal: recorded, answered with what's wrong. */
async function refuse(context: Context<AppEnv>, status: 400 | 403 | 429 | 503, error: string, reason: string): Promise<Response> {
	context.get("span").info("mfa refused", { "reason": reason });
	await audit(context.env, "auth_refused", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": `mfa: ${reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	context.header("cache-control", "no-store");

	return context.json({ "error": error, "reason": reason }, status);
}

/** The action's own check: a sign-in within RECENT, and MFA set up in this environment. The refusal, or nothing. */
async function recent(context: Context<AppEnv>): Promise<Response | undefined> {
	if (context.env.TOTP_KEK === undefined || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "two-factor isn't set up here");
	}

	const grant = await context.env.DB.prepare("SELECT created_at FROM grants WHERE id = ?").bind(context.get("grant")).first<{ "created_at": number }>();

	return grant === null || Date.now() - grant.created_at > RECENT ? refuse(context, 403, "sign_in_again", "sign in again to change two-factor (it needs a sign-in in the last 10 minutes)") : undefined;
}

/** Ten new recovery codes for `user`, replacing any: kept as HMACs, handed back in clear this once. */
async function replaceRecoveryCodes(env: Bindings, user: string): Promise<string[]> {
	const codes = newRecoveryCodes();

	await env.DB.batch([
		env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(user),
		...await Promise.all(codes.map(async (code) => env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").bind(user, await recoveryHash(env, user, code))))
	]);

	return codes;
}

/** How the account page shows it: on since when, and recovery codes left; or off. */
export async function mfaState(env: Bindings, user: string): Promise<{ "enrolledAt": number; "recoveryLeft": number } | null> {
	const row = await env.DB.prepare("SELECT enrolled_at, (SELECT COUNT(*) FROM recovery_codes WHERE user_id = ? AND used_at IS NULL) AS left FROM totp WHERE user_id = ? AND enrolled_at IS NOT NULL").bind(user, user).first<{ "enrolled_at": number; "left": number }>();

	return row === null ? null : { "enrolledAt": row.enrolled_at, "recoveryLeft": row.left };
}

/** POST /admin/account/mfa/start: a new secret, pending until the app's code confirms it. */
export async function mfaStartEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");

	if (await hasMfa(context.env, user)) {
		return refuse(context, 400, "already_on", "two-factor is already on: turn it off first to start again");
	}

	const secret = newSecret();
	const now = Date.now();
	const named = await context.env.DB.prepare("SELECT address FROM emails WHERE user_id = ?").bind(user).first<{ "address": string }>();

	await context.env.DB.prepare("INSERT INTO totp (user_id, secret, created_at, enrolled_at, last_step, tries, tries_at) VALUES (?, ?, ?, NULL, -1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, enrolled_at = NULL, last_step = -1, tries = excluded.tries, tries_at = excluded.tries_at").bind(user, await seal(context.env.TOTP_KEK as string, base32(secret), sealedFor(user)), now, TRIES, now).run();
	context.header("cache-control", "no-store");

	return context.json({ "secret": base32(secret), "uri": otpauthUri(secret, named?.address ?? user.slice(0, 8)) });
}

/** POST /admin/account/mfa/confirm: `code` from the app; it's on, and the recovery codes, this once. */
export async function mfaConfirmEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");
	const form = await context.req.parseBody();
	const pending = await context.env.DB.prepare("SELECT secret FROM totp WHERE user_id = ? AND enrolled_at IS NULL").bind(user).first<{ "secret": string }>();

	if (pending === null) {
		return refuse(context, 400, "not_started", "start setting it up first");
	}

	const now = Date.now();
	const step = await verifyTotp(unbase32(await open(context.env.TOTP_KEK as string, pending.secret, sealedFor(user))), String(form["code"] ?? "").replaceAll(/\s/gu, ""), now);

	if (step === undefined) {
		return refuse(context, 400, "code", "that code isn't right: check the app's clock, and try the next one");
	}

	await context.env.DB.prepare("UPDATE totp SET enrolled_at = ?, last_step = ? WHERE user_id = ?").bind(now, step, user).run();

	const codes = await replaceRecoveryCodes(context.env, user);

	await audit(context.env, "mfa_enrolled", { "userId": user, "grantId": context.get("grant") }, await origin(context), { "reason": "authenticator app" });
	context.header("cache-control", "no-store");

	return context.json({ "on": true, "recoveryCodes": codes });
}

/** POST /admin/account/mfa/off: `code`, the app's or a recovery code; it's off, and the recovery codes gone. */
export async function mfaOffEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");
	const checked = await secondFactor(context.env, user, String((await context.req.parseBody())["code"] ?? ""));

	if ("reason" in checked) {
		return refuse(context, checked.status, "code", checked.reason);
	}

	await context.env.DB.batch([
		context.env.DB.prepare("DELETE FROM totp WHERE user_id = ?").bind(user),
		context.env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(user)
	]);
	await audit(context.env, "mfa_removed", { "userId": user, "grantId": context.get("grant") }, await origin(context), { "reason": `with a ${checked.kind === "totp" ? "code from the app" : "recovery code"}` });
	context.header("cache-control", "no-store");

	return context.json({ "on": false });
}

/** POST /admin/account/mfa/recovery: `code` from the app; ten new recovery codes, the old ones gone. */
export async function mfaRecoveryEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");
	const code = String((await context.req.parseBody())["code"] ?? "");

	if (isRecoveryCode(typedRecovery(code))) {
		return refuse(context, 400, "code", "use a code from the app to make new recovery codes");
	}

	const checked = await secondFactor(context.env, user, code);

	if ("reason" in checked) {
		return refuse(context, checked.status, "code", checked.reason);
	}

	const codes = await replaceRecoveryCodes(context.env, user);

	await audit(context.env, "mfa_recovery_codes", { "userId": user, "grantId": context.get("grant") }, await origin(context));
	context.header("cache-control", "no-store");

	return context.json({ "recoveryCodes": codes });
}

/** POST /auth/second: `code`, the second factor, for this browser's attempt whose first factor passed. A match starts
 *  the sign-in (its `login` row says both: "email+totp", "password+recovery"). */
export async function secondStepEndpoint(context: Context<AppEnv>): Promise<Response> {
	const held = heldAttempt(context);
	const first = held === undefined ? { "ok": false as const, "reason": "no attempt" } : await held.stub.firstFactor(held.secret);
	const signInRefusal = async (status: 400 | 401 | 429, error: string, reason: string): Promise<Response> => {
		await audit(context.env, "sign_in_refused", "user" in first ? { "userId": first.user } : {}, await origin(context), { "reason": `mfa: ${reason}`, "detail": "POST /auth/second" });
		context.header("cache-control", "no-store");

		return context.json({ "error": error, "reason": reason }, status);
	};

	if (held === undefined || "reason" in first) {
		return signInRefusal(401, "no_attempt", "reason" in first ? first.reason : "no attempt");
	}

	const checked = await secondFactor(context.env, first.user, String((await context.req.parseBody())["code"] ?? ""));

	if ("reason" in checked) {
		return signInRefusal(checked.status, "code", checked.reason);
	}

	return signInAs(context, held, first.user, `${first.method}+${checked.kind}`);
}
