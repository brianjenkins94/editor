import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { audit, origin } from "./audit.ts";

/**
 * Your sessions, and your account (README.md, "Identity and the data we keep"), all behind `session`: the signed-in user
 * sees and ends only their own sign-ins, and can delete the account — which leaves nothing that points at them.
 */

/** "Chrome on macOS": the browser and the OS from a User-Agent, and nothing more of it (it isn't kept). */
export function deviceLabel(userAgent: string | undefined): string | undefined {
	if (userAgent === undefined || userAgent === "") {
		return undefined;
	}

	// In this order: Edge's User-Agent names Chrome and Safari too, Chrome's names Safari, an iPad's names Mac OS X.
	const browser = /Edg\//u.test(userAgent) ? "Edge" : /Firefox\//u.test(userAgent) ? "Firefox" : /Chrome\//u.test(userAgent) ? "Chrome" : /Safari\//u.test(userAgent) ? "Safari" : "A browser";
	const system = /iPhone|iPad/u.test(userAgent) ? "iOS" : /Android/u.test(userAgent) ? "Android" : /Mac OS X/u.test(userAgent) ? "macOS" : /Windows/u.test(userAgent) ? "Windows" : /Linux/u.test(userAgent) ? "Linux" : undefined;

	return system === undefined ? browser : `${browser} on ${system}`;
}

const grant = (context: Context<AppEnv>, id: string): DurableObjectStub<import("./grant.ts").Grant> => context.env.GRANTS.get(context.env.GRANTS.idFromString(id));

/** GET /sessions: the user's live sign-ins, the most recently used first, this one marked. */
export async function sessionsEndpoint(context: Context<AppEnv>): Promise<Response> {
	const { results } = await context.env.DB.prepare("SELECT id, created_at, last_used_at, label FROM grants WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC").bind(context.get("user")).all<{ "id": string; "created_at": number; "last_used_at": number; "label": string | null }>();

	return context.json({ "sessions": results.map((row) => ({ "id": row.id, "current": row.id === context.get("grant"), "createdAt": row.created_at, "lastUsedAt": row.last_used_at, "label": row.label })) });
}

/** POST /sessions/:id/revoke: end one of the user's sign-ins. Anyone else's is a 404 — and recorded, being a probe. */
export async function revokeSessionEndpoint(context: Context<AppEnv>): Promise<Response> {
	const id = context.req.param("id") ?? "";
	const row = /^[0-9a-f]{64}$/u.test(id) ? await context.env.DB.prepare("SELECT user_id FROM grants WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ "user_id": string }>() : null;

	if (row?.user_id !== context.get("user")) {
		await audit(context.env, "auth_refused", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": "not one of your sessions", "detail": `POST /sessions/${id.slice(0, 64)}/revoke` });

		return context.json({ "error": "not_found" }, 404);
	}

	await grant(context, id).revoke({ "from": await origin(context), "reason": id === context.get("grant") ? "signed out" : "signed out from another session" });

	return context.json({ "revoked": 1 });
}

/** POST /sessions/revoke-all: end every one of the user's sign-ins, this one included (and each one's GitHub token). */
export async function revokeAllEndpoint(context: Context<AppEnv>): Promise<Response> {
	const { results } = await context.env.DB.prepare("SELECT id FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(context.get("user")).all<{ "id": string }>();
	const from = await origin(context);

	for (const { id } of results) {
		await grant(context, id).revoke({ "from": from, "reason": "signed out everywhere" });
	}

	return context.json({ "revoked": results.length });
}

/**
 * POST /account/delete, with `confirm=delete`: the GitHub App's authorization revoked at GitHub, every sign-in ended and
 * its Grant's storage erased, the user's `users` and `grants` rows deleted, and their id taken off the audit log —
 * which keeps what happened (it's the security record), but no longer who it happened to.
 */
export async function deleteAccountEndpoint(context: Context<AppEnv>): Promise<Response> {
	if ((await context.req.parseBody())["confirm"] !== "delete") {
		return context.json({ "error": "confirm", "message": "send confirm=delete" }, 400);
	}

	const user = context.get("user");
	const from = await origin(context);
	const deauthorized = await grant(context, context.get("grant")).deauthorize();
	const { results } = await context.env.DB.prepare("SELECT id FROM grants WHERE user_id = ?").bind(user).all<{ "id": string }>();

	for (const { id } of results) {
		await grant(context, id).forget({ "from": from });
	}

	await context.env.DB.batch([
		context.env.DB.prepare("DELETE FROM grants WHERE user_id = ?").bind(user),
		context.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user),
		context.env.DB.prepare("UPDATE audit SET user_id = NULL WHERE user_id = ?").bind(user)
	]);
	await audit(context.env, "account_deleted", { "grantId": context.get("grant") }, from, { "reason": deauthorized ? "GitHub authorization revoked" : "GitHub authorization not revoked: no working GitHub token" });

	return context.json({ "deleted": true, "githubAuthorizationRevoked": deauthorized });
}
