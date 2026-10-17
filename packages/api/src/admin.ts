import type { AppEnv } from "./env.ts";
import { Hono } from "hono";
import { ROUTINE } from "./audit-copies.ts";
import { audit, origin } from "./audit.ts";
import { permissionsOf, requires, roles } from "./rbac.ts";
import { adminSession } from "./tokens.ts";
import { trafficEndpoint } from "./traffic.ts";

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

// ── Reads (B2) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What isn't worth a second look: the everyday record, and admins reading (kept a year, but expected). */
const EXPECTED = [...ROUTINE, "admin_access"];

/** `?limit=` within 1..max (default `fallback`). */
const limitOf = (value: string | undefined, fallback: number, max: number): number => Math.min(Math.max(Number.parseInt(value ?? "", 10) || fallback, 1), max);

/** Every user: our id, GitHub's id (the app looks the login up live; it isn't stored), when they joined, how many live
 *  sign-ins they have, and when they were last seen. Most recently seen first. */
admin.get("/users", requires("users:read"), async (context) => {
	const { results } = await context.env.DB.prepare(`SELECT u.id, u.github_id, u.created_at, u.deleted_at, SUM(CASE WHEN g.id IS NOT NULL AND g.revoked_at IS NULL THEN 1 ELSE 0 END) AS live, MAX(g.last_used_at) AS last_seen
		FROM users u LEFT JOIN grants g ON g.user_id = u.id GROUP BY u.id ORDER BY last_seen IS NULL, last_seen DESC LIMIT ?`).bind(limitOf(context.req.query("limit"), 200, 1000)).all<{ "id": string; "github_id": number; "created_at": number; "deleted_at": number | null; "live": number; "last_seen": number | null }>();

	return context.json({ "users": results.map((row) => ({ "id": row.id, "githubId": row.github_id, "createdAt": row.created_at, "deletedAt": row.deleted_at, "liveSessions": row.live, "lastSeenAt": row.last_seen })) });
});

/** One user: the same, every sign-in they've had (live and ended, with its client), and their latest audit rows. */
admin.get("/users/:id", requires("users:read"), async (context) => {
	const id = context.req.param("id");
	const user = await context.env.DB.prepare("SELECT id, github_id, created_at, deleted_at FROM users WHERE id = ?").bind(id).first<{ "id": string; "github_id": number; "created_at": number; "deleted_at": number | null }>();

	if (user === null) {
		return context.json({ "error": "not_found" }, 404);
	}

	const [sessions, rows] = await context.env.DB.batch([
		context.env.DB.prepare("SELECT id, client, label, created_at, last_used_at, revoked_at FROM grants WHERE user_id = ? ORDER BY last_used_at DESC").bind(id),
		context.env.DB.prepare("SELECT id, at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(id)
	]);

	return context.json({
		"user": { "id": user.id, "githubId": user.github_id, "createdAt": user.created_at, "deletedAt": user.deleted_at },
		"sessions": (sessions?.results ?? []).map(session),
		"audit": (rows?.results ?? []).map(auditRow)
	});
});

/** Live sign-ins across users, the most recently used first. */
admin.get("/sessions", requires("sessions:read"), async (context) => {
	const { results } = await context.env.DB.prepare(`SELECT g.id, g.client, g.label, g.created_at, g.last_used_at, g.revoked_at, g.user_id, u.github_id
		FROM grants g JOIN users u ON u.id = g.user_id WHERE g.revoked_at IS NULL ORDER BY g.last_used_at DESC LIMIT ?`).bind(limitOf(context.req.query("limit"), 200, 1000)).all();

	return context.json({ "sessions": results.map((row) => ({ ...session(row), "userId": row["user_id"], "githubId": row["github_id"] })) });
});

/**
 * The audit log, newest first, filtered as `npm run audit` filters it: `event`, `user`, `grant`, `ip` (a hash),
 * `suspicious` (everything but the everyday record), `since` (`24h`, `7d`), and `before` (an id, for the next page).
 */
admin.get("/audit", requires("audit:read"), async (context) => {
	const query = context.req.query();
	const where: string[] = [];
	const values: (string | number)[] = [];
	const span = /^(\d+)([hd])$/u.exec(query["since"] ?? "");

	for (const [parameter, column] of [["event", "event"], ["user", "user_id"], ["grant", "grant_id"], ["ip", "ip_hash"]] as const) {
		if (query[parameter] !== undefined && query[parameter] !== "") {
			where.push(`${column} = ?`);
			values.push(query[parameter]);
		}
	}

	if (query["suspicious"] === "true") {
		where.push(`event NOT IN (${EXPECTED.map(() => "?").join(", ")})`);
		values.push(...EXPECTED);
	}

	if (span !== null) {
		where.push("at >= ?");
		values.push(Date.now() - Number(span[1]) * (span[2] === "h" ? 3_600_000 : 86_400_000));
	}

	if (/^\d+$/u.test(query["before"] ?? "")) {
		where.push("id < ?");
		values.push(Number(query["before"]));
	}

	const { results } = await context.env.DB.prepare(`SELECT id, at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id FROM audit ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY id DESC LIMIT ?`).bind(...values, limitOf(query["limit"], 100, 500)).all();

	return context.json({ "rows": results.map(auditRow) });
});

/** Cloudflare's analytics of the zone and the Workers (src/traffic.ts), through the API's own read-only token. */
admin.get("/traffic", requires("traffic:read"), trafficEndpoint);

function session(row: Record<string, unknown>): Record<string, unknown> {
	return { "id": row["id"], "client": row["client"] ?? "editor", "label": row["label"], "createdAt": row["created_at"], "lastUsedAt": row["last_used_at"], "revokedAt": row["revoked_at"] };
}

function auditRow(row: Record<string, unknown>): Record<string, unknown> {
	return { "id": row["id"], "at": row["at"], "event": row["event"], "userId": row["user_id"], "grantId": row["grant_id"], "country": row["country"], "ipHash": row["ip_hash"], "reason": row["reason"], "detail": row["detail"], "traceId": row["trace_id"] };
}
