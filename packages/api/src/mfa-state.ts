import type { Bindings } from "./env.ts";

/**
 * Whether a user has two-factor on, and how (README.md, "Two-factor"): an authenticator app (C5, `totp`), or a code
 * by email after a password (C6, `email_mfa`). Read where a sign-in decides whether to ask for a second step (src/email.ts,
 * src/password.ts) and by the account page; changed only in src/mfa.ts.
 */

/** Whether `user` has an authenticator app on: the stronger second factor, asked for whenever it's on. */
export async function hasMfa(env: Bindings, user: string): Promise<boolean> {
	return (await env.DB.prepare("SELECT 1 FROM totp WHERE user_id = ? AND enrolled_at IS NOT NULL").bind(user).first()) !== null;
}

/** Whether `user` has two-factor by email on: asked for after a password only (an emailed sign-in code already proves the
 *  inbox), and only when there's no authenticator app. */
export async function hasEmailMfa(env: Bindings, user: string): Promise<boolean> {
	return (await env.DB.prepare("SELECT 1 FROM email_mfa WHERE user_id = ?").bind(user).first()) !== null;
}

/** How the account page shows it: on since when, and recovery codes left; or off. */
export async function mfaState(env: Bindings, user: string): Promise<{ "enrolledAt": number; "recoveryLeft": number } | null> {
	const row = await env.DB.prepare("SELECT enrolled_at, (SELECT COUNT(*) FROM recovery_codes WHERE user_id = ? AND used_at IS NULL) AS left FROM totp WHERE user_id = ? AND enrolled_at IS NOT NULL").bind(user, user).first<{ "enrolled_at": number; "left": number }>();

	return row === null ? null : { "enrolledAt": row.enrolled_at, "recoveryLeft": row.left };
}

/** Two-factor by email, as the account page shows it: on since when, or off. */
export async function emailMfaState(env: Bindings, user: string): Promise<{ "enrolledAt": number } | null> {
	const row = await env.DB.prepare("SELECT enrolled_at FROM email_mfa WHERE user_id = ?").bind(user).first<{ "enrolled_at": number }>();

	return row === null ? null : { "enrolledAt": row.enrolled_at };
}
