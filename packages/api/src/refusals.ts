import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { audit, origin } from "./audit.ts";

/**
 * Refusals, one way everywhere: logged on the request's span, recorded in the audit log (`sign_in_refused` before anyone
 * is signed in; `auth_refused` after, with who and which sign-in), and answered with what's wrong, never cached. Each
 * module binds its own (`refusal("email")`): its area prefixes the audit reason ("email: code wrong"), so a row says
 * which flow refused. And the check sensitive actions share: a sign-in in the last 10 minutes.
 */

export type RefusalEvent = "sign_in_refused" | "auth_refused";

type Status = 400 | 401 | 403 | 409 | 429 | 502 | 503;

/** Record a refusal: the span, then the audit row. */
async function record(context: Context<AppEnv>, event: RefusalEvent, reason: string, area?: string): Promise<void> {
	context.get("span").info(`${area ?? "sign-in"} refused`, { "reason": reason });
	await audit(context.env, event, event === "auth_refused" ? { "userId": context.get("user"), "grantId": context.get("grant") } : {}, await origin(context), { "reason": area === undefined ? reason : `${area}: ${reason}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	context.header("cache-control", "no-store");
}

/** A module's refusal: `{ error, reason }` (and `extra`) with `status`, recorded as `event` (`fallback` unless given). */
export const refusal = (area: string, fallback: RefusalEvent = "sign_in_refused") => async (context: Context<AppEnv>, status: Status, error: string, reason: string, event: RefusalEvent = fallback, extra: Record<string, unknown> = {}): Promise<Response> => {
	await record(context, event, reason, area);

	return context.json({ "error": error, "reason": reason, ...extra }, status);
};

/** The OAuth endpoints' refusal (PAR, the starts, GitHub's callback): `invalid_request`, saying no more to the browser; the
 *  reason is the audit row's. */
export async function oauthRefusal(context: Context<AppEnv>, reason: string, status: 400 | 401 = 400): Promise<Response> {
	await record(context, "sign_in_refused", reason);

	return context.json({ "error": "invalid_request" }, status);
}

/** How recent a sign-in a sensitive action needs (changing two-factor, linking, passkeys): its own check, the one every
 *  account can pass. */
export const RECENT = 10 * 60_000;

/** Whether this sign-in was made within RECENT. */
export async function signedInRecently(context: Context<AppEnv>): Promise<boolean> {
	const grant = await context.env.DB.prepare("SELECT created_at FROM grants WHERE id = ?").bind(context.get("grant")).first<{ "created_at": number }>();

	return grant !== null && Date.now() - grant.created_at <= RECENT;
}
