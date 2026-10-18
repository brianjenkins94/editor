import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { open, seal } from "@brianjenkins94/util/auth/seal";
import { checkActionCode, issueActionCode } from "./action-codes.ts";
import { audit, origin } from "./audit.ts";
import { newCode, typed } from "@brianjenkins94/util/auth/codes";
import { base32, isRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, typedRecovery, unbase32, verifyTotp } from "@brianjenkins94/util/auth/totp";
import { codeHash, sendCode } from "./email.ts";
import { emailOf } from "./identities.ts";
import { hasEmailMfa } from "./mfa-state.ts";
import { hasMfa } from "./mfa-state.ts";
import { heldAttempt } from "./attempt.ts";
import { signInAs } from "./signin.ts";
import { refusal, signedInRecently } from "./refusals.ts";

/**
 * Authenticator-app MFA (SIGN-IN.md, "MFA, optional"; C5), for your own account, from the admin app's Your account page:
 *
 *   POST /admin/account/mfa/start      a new secret, pending: the app scans its QR code
 *   POST /admin/account/mfa/confirm    `code`, from the app: it's on, and ten recovery codes, shown this once
 *   POST /admin/account/mfa/off        `code`, the app's or a recovery code: it's off
 *   POST /admin/account/mfa/recovery   `code`, the app's: ten new recovery codes, the old ones gone
 *   POST /admin/account/mfa/email/code `turn` ("on" or "off"): a code to your email, to turn two-factor by email on or off
 *   POST /admin/account/mfa/email      `turn`, `code`: two-factor by email on, or off (C6)
 *
 * Each needs a recent sign-in (within 10 minutes, src/refusals.ts): the action's own check, and the one every account can pass, GitHub's
 * included (SIGN-IN.md, "Departures"). Turning it off and new recovery codes need the second factor itself too.
 *
 * `secondFactor` is the check at sign-in (after an emailed code or a password, before the session starts: POST
 * /auth/second, `code`) and in a password reset: the app's code (each 30-second step once) or a recovery code (each
 * once), 5 tries a bucket.
 */

/** How recent a sign-in must be to change MFA. */

const TRIES = 5;

const TRY_REFILL = 60_000;

/** Where a sealed TOTP secret belongs: bound to its user, so one can't be moved to another. */
const sealedFor = (user: string): string => `totp:${user}`;

/** A recovery code as kept: an HMAC under CODE_KEY, bound to its user (as emailed codes are, src/email.ts). */
const recoveryHash = async (env: Bindings, user: string, code: string): Promise<string> => codeHash(env, `${user}:recovery`, typedRecovery(code));

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

const refuse = refusal("mfa", "auth_refused");

/** The action's own check: a sign-in in the last 10 minutes, and MFA set up in this environment. The refusal, or nothing. */
async function recent(context: Context<AppEnv>): Promise<Response | undefined> {
	if (context.env.TOTP_KEK === undefined || context.env.CODE_KEY === undefined) {
		return refuse(context, 503, "unavailable", "two-factor isn't set up here");
	}

	return await signedInRecently(context) ? undefined : refuse(context, 403, "sign_in_again", "sign in again to change two-factor (it needs a sign-in in the last 10 minutes)");
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
	const named = await emailOf(context.env, user);

	await context.env.DB.prepare("INSERT INTO totp (user_id, secret, created_at, enrolled_at, last_step, tries, tries_at) VALUES (?, ?, ?, NULL, -1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, enrolled_at = NULL, last_step = -1, tries = excluded.tries, tries_at = excluded.tries_at").bind(user, await seal(context.env.TOTP_KEK as string, base32(secret), sealedFor(user)), now, TRIES, now).run();
	context.header("cache-control", "no-store");

	return context.json({ "secret": base32(secret), "uri": otpauthUri(secret, named ?? user.slice(0, 8), "unusually good") });
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

	const code = String((await context.req.parseBody())["code"] ?? "");

	// Two-factor by email, without an app: the code just emailed to the attempt (its email step: tries, once).
	if (!await hasMfa(context.env, first.user) && await hasEmailMfa(context.env, first.user)) {
		const confirmed = await held.stub.confirm(held.secret, await codeHash(context.env, held.id, typed(code)));

		return "reason" in confirmed ? signInRefusal(confirmed.reason === "too many tries" ? 429 : 400, "code", confirmed.reason) : signInAs(context, held, first.user, `${first.method}+email`);
	}

	const checked = await secondFactor(context.env, first.user, code);

	if ("reason" in checked) {
		return signInRefusal(checked.status, "code", checked.reason);
	}

	return signInAs(context, held, first.user, `${first.method}+${checked.kind}`);
}

// ── Two-factor by email (C6) ───────────────────────────────────────────────────────────────────────────────────────
// It stops a stolen password, not a stolen inbox: the inbox can reset the password too. The app says so, and offers an
// authenticator app first. Asked for after a password only; with an app on too, the app is asked for instead.

/** After a password, for an account with two-factor by email: a code to its address, kept in the attempt's email step.
 *  The refusal, if it couldn't be sent. */
export async function emailSecondFactor(context: Context<AppEnv>, held: NonNullable<ReturnType<typeof heldAttempt>>, user: string): Promise<Response | undefined> {
	const email = await emailOf(context.env, user);

	if (email === null) {
		return undefined;
	}

	const code = newCode();

	await held.stub.emailed(held.secret, email, await codeHash(context.env, held.id, code));

	const sent = await sendCode(context, email, code, { "kind": "action", "action": "finish signing in" });

	if ("reason" in sent) {
		await audit(context.env, "sign_in_refused", { "userId": user }, await origin(context), { "reason": `mfa: ${sent.reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
		context.header("cache-control", "no-store");

		return context.json({ "error": sent.error, "reason": sent.reason }, sent.status);
	}

	return undefined;
}

/** Which way, and what its code is bound to. */
const turning = (form: Record<string, unknown>, user: string): { "on": boolean; "action": string; "bound": string } => {
	const on = form["turn"] !== "off";

	return { "on": on, "action": `email-mfa-${on ? "on" : "off"}`, "bound": `${user}:email-mfa-${on ? "on" : "off"}` };
};

/** POST /admin/account/mfa/email/code: `turn` ("on" or "off"): a code to your email, for turning two-factor by email
 *  on or off. A recent sign-in, and an email on the account. */
export async function emailMfaCodeEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");
	const turn = turning(await context.req.parseBody(), user);
	const email = await emailOf(context.env, user);

	if (email === null) {
		return refuse(context, 400, "no_email", "no email on this account: two-factor by email needs one");
	}

	const notSent = await issueActionCode(context, user, turn.action, turn.bound, email, turn.on ? "turn on two-factor by email" : "turn off two-factor by email", "auth_refused");

	if (notSent !== undefined) {
		return notSent;
	}

	context.header("cache-control", "no-store");

	return context.json({ "sent": true, "address": email });
}

/** POST /admin/account/mfa/email: `turn` and `code`: the code checked, then two-factor by email on or off. */
export async function emailMfaEndpoint(context: Context<AppEnv>): Promise<Response> {
	const refused = await recent(context);

	if (refused !== undefined) {
		return refused;
	}

	const user = context.get("user");
	const form = await context.req.parseBody();
	const turn = turning(form, user);
	const wrong = await checkActionCode(context, user, turn.action, turn.bound, String(form["code"] ?? ""), "auth_refused");

	if (wrong !== undefined) {
		return wrong;
	}

	await context.env.DB.batch([
		turn.on ? context.env.DB.prepare("INSERT INTO email_mfa (user_id, enrolled_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING").bind(user, Date.now()) : context.env.DB.prepare("DELETE FROM email_mfa WHERE user_id = ?").bind(user),
		context.env.DB.prepare("DELETE FROM action_codes WHERE user_id = ? AND action = ?").bind(user, turn.action)
	]);
	await audit(context.env, turn.on ? "mfa_enrolled" : "mfa_removed", { "userId": user, "grantId": context.get("grant") }, await origin(context), { "reason": "email" });
	context.header("cache-control", "no-store");

	return context.json({ "on": turn.on });
}
