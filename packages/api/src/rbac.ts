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

/** The platform owner: every platform permission. (Organization roles come later, as rows.) */
export const ROLES = { "owner": PERMISSIONS } satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof ROLES;

/**
 * A user's roles. `owner` is config, not data: the user's GitHub id is in OWNERS (wrangler.jsonc). It can't be granted or
 * revoked through the API, so neither a compromised admin session nor a bad database write can make another owner.
 */
export async function rolesOf(env: Bindings, userId: string): Promise<Role[]> {
	const user = await env.DB.prepare("SELECT github_id FROM users WHERE id = ?").bind(userId).first<{ "github_id": number }>();

	return user !== null && env.OWNERS.includes(user.github_id) ? ["owner"] : [];
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
