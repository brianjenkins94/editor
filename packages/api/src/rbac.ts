import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { createMiddleware } from "hono/factory";
import { audit, origin } from "./audit.ts";

/**
 * Roles and permissions (packages/admin/README.md, "Roles and permissions"). Permissions are fixed strings; roles map to
 * them here, in code, so what a role can do is reviewed like any other change. Who holds a role is decided per request,
 * never carried in a token, so a role taken away is gone at once.
 */

/** Everything the admin API can be asked to do, one string per action. */
export const PERMISSIONS = ["users:read", "sessions:read", "sessions:revoke", "audit:read", "audit:verify", "traffic:read", "behavior:read", "architecture:read", "mail:read", "mail:test"] as const;

export type Permission = typeof PERMISSIONS[number];

/** What only reads: every `…:read`, and checking the audit log against its copies. A permission added later that only
 *  reads (named `…:read`) is a viewer's too. */
const READS = PERMISSIONS.filter((permission) => permission.endsWith(":read") || permission === "audit:verify");

/**
 * The platform owner: every platform permission. A viewer: everything that only reads, nothing that changes anything
 * or sends anything (`sessions:revoke`, `mail:test`). (Organization roles come later, as rows.)
 */
export const ROLES = { "owner": PERMISSIONS, "viewer": READS } satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof ROLES;

/**
 * A user's roles. `owner` and `viewer` are config, not data: the user's GitHub id is in OWNERS or VIEWERS (wrangler.jsonc).
 * Neither can be granted or revoked through the API, so neither a compromised admin session nor a bad database write can
 * make another. A user without a GitHub account (email only) holds neither: a role needs GitHub's sign-in, and its 2FA.
 */
export async function rolesOf(env: Bindings, userId: string): Promise<Role[]> {
	const user = await env.DB.prepare("SELECT github_id FROM users WHERE id = ?").bind(userId).first<{ "github_id": number | null }>();

	if (user === null || user.github_id === null) {
		return [];
	}

	return [...env.OWNERS.includes(user.github_id) ? ["owner" as const] : [], ...(env.VIEWERS ?? []).includes(user.github_id) ? ["viewer" as const] : []];
}

/** What a set of roles allows, in PERMISSIONS' order. */
export const permissionsOf = (roles: Role[]): Permission[] => PERMISSIONS.filter((permission) => roles.some((role) => (ROLES[role] as readonly Permission[]).includes(permission)));

/** The signed-in user's roles, looked up once per request. */
export async function roles(context: Context<AppEnv>): Promise<Role[]> {
	const known = context.get("roles");

	if (known !== undefined) {
		return known;
	}

	const found = await rolesOf(context.env, context.get("user"));

	context.set("roles", found);

	return found;
}

/** A route's permission: without it, a 403, recorded (`auth_refused`, "lacks <permission>"). After a session middleware. */
export const requires = (permission: Permission) => createMiddleware<AppEnv>(async (context, next) => {
	if (!permissionsOf(await roles(context)).includes(permission)) {
		context.get("span").info("request refused", { "reason": "lacks a permission" });
		await audit(context.env, "auth_refused", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": `lacks ${permission}`, "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });

		return context.json({ "error": "forbidden" }, 403);
	}

	await next();
});
