import type { AppEnv } from "./env.ts";
import { Hono } from "hono";
import { audit, origin } from "./audit.ts";
import { permissionsOf, roles } from "./rbac.ts";
import { adminSession } from "./tokens.ts";

/**
 * The admin API (packages/admin/README.md, "The admin API"), mounted at /admin. Only tokens issued to the `admin` client
 * reach it, and each route names the permission it requires (`requires`, src/rbac.ts), so this file is also the
 * access-control table. Every request that's answered is recorded (`admin_access`): who looked at what is itself part of
 * the security record. Refusals are recorded where they happen (`auth_refused`).
 */
export const admin = new Hono<AppEnv>();

admin.use(adminSession, async (context, next) => {
	await next();

	if (context.res.status < 400) {
		await audit(context.env, "admin_access", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
	}
});

/** Who you are to the admin app: your user, roles and permissions, for it to draw itself. Any admin token may ask. */
admin.get("/me", async (context) => {
	const held = await roles(context);

	return context.json({ "user": context.get("user"), "roles": held, "permissions": permissionsOf(held) });
});
