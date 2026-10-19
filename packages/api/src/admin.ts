import type { AppEnv } from "./env.ts";
import { Hono } from "hono";
import { accountRoutes } from "./account-routes.ts";
import { ROUTINE } from "./audit-copies.ts";
import { architectureEndpoint } from "./architecture.ts";
import { audit, origin } from "./audit.ts";
import { grantStub } from "./grant.ts";
import { githubIdColumn } from "./identities.ts";
import { inboxEndpoint } from "./inbox.ts";
import { alertsEndpoint, mailEndpoint, testAlertEndpoint } from "./mail-report.ts";
import { smokeTest } from "./smoke.ts";
import { repositoryTag } from "./behavior.ts";
import { permissionsOf, requires, roles } from "./rbac.ts";
import { adminSession } from "./tokens.ts";
import { trafficEndpoint } from "./traffic.ts";
import { down, isSwitch, maintenance, setMaintenance, setSwitch, switches, SWITCHES } from "./maintenance.ts";
import { spendEndpoint } from "./spend.ts";
import { errorGroupEndpoint, errorOccurrenceEndpoint, errorsEndpoint, sourceMapEndpoint } from "./errors.ts";
import { timelineEndpoint } from "./timeline.ts";

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

// While the kill switch is on (src/maintenance.ts), the admin API is the owner's only: to look, and to turn it off.
admin.use(async (context, next) => {
	if ((await maintenance(context.env)).on && !(await roles(context)).includes("owner")) {
		return down(context);
	}

	await next();
});

/** Who you are to the admin app: your user, roles and permissions, for it to draw itself; the kill switch, with why
 *  and by whom; and the narrower switches, each with what it pauses and whether it is. Any admin token may ask. */
admin.get("/me", async (context) => {
	const held = await roles(context);
	const paused = await switches(context.env);

	return context.json({ "user": context.get("user"), "roles": held, "permissions": permissionsOf(held), "maintenance": await maintenance(context.env), "switches": Object.entries(SWITCHES).map(([name, { what, detail }]) => ({ "name": name, "what": what, "detail": detail, "paused": paused[name as keyof typeof SWITCHES] ?? null })) });
});

/** The narrower switches (src/maintenance.ts, O8): `name` one of SWITCHES, `turn` "pause" (with a `reason`) or
 *  "resume". The owner's only, as the kill switch is. Answers the paused switches. */
admin.post("/switches", requires("maintenance:switch"), async (context) => {
	const form = await context.req.parseBody();
	const name = typeof form["name"] === "string" ? form["name"] : "";
	const turn = form["turn"];
	const reason = typeof form["reason"] === "string" && form["reason"].trim() !== "" ? form["reason"].trim().slice(0, 200) : null;

	if (!isSwitch(name) || (turn !== "pause" && turn !== "resume")) {
		return context.json({ "error": "switch", "reason": "pause or resume one of the switches" }, 400);
	}

	return context.json({ "paused": await setSwitch(context.env, name, turn === "pause", reason, `user:${context.get("user")}`) });
});

/** The kill switch (OPERATIONS.md): `turn` "on" or "off", with a `reason` (on). The owner's only. */
admin.post("/maintenance", requires("maintenance:switch"), async (context) => {
	const form = await context.req.parseBody();
	const turn = form["turn"];
	const reason = typeof form["reason"] === "string" && form["reason"].trim() !== "" ? form["reason"].trim().slice(0, 200) : null;

	if (turn !== "on" && turn !== "off") {
		return context.json({ "error": "turn", "reason": "turn it on or off" }, 400);
	}

	return context.json(await setMaintenance(context.env, turn === "on", turn === "on" ? reason ?? "turned on by the owner" : reason, `user:${context.get("user")}`));
});

// ── Reads (B2) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What isn't worth a second look: the everyday record, and admins reading (kept a year, but expected). */
const EXPECTED = [...ROUTINE, "admin_access"];

/** `?limit=` within 1..max (default `fallback`). */
const limitOf = (value: string | undefined, fallback: number, max: number): number => Math.min(Math.max(Number.parseInt(value ?? "", 10) || fallback, 1), max);

/** Every user: our id, GitHub's id (the app looks the login up live; it isn't stored), when they joined, how many live
 *  sign-ins they have, and when they were last seen. Most recently seen first. */
admin.get("/users", requires("users:read"), async (context) => {
	const { results } = await context.env.DB.prepare(`SELECT u.id, ${githubIdColumn("u")} AS github_id, u.created_at, u.deleted_at, SUM(CASE WHEN g.id IS NOT NULL AND g.revoked_at IS NULL THEN 1 ELSE 0 END) AS live, MAX(g.last_used_at) AS last_seen
		FROM users u LEFT JOIN grants g ON g.user_id = u.id GROUP BY u.id ORDER BY last_seen IS NULL, last_seen DESC LIMIT ?`).bind(limitOf(context.req.query("limit"), 200, 1000)).all<{ "id": string; "github_id": number; "created_at": number; "deleted_at": number | null; "live": number; "last_seen": number | null }>();

	return context.json({ "users": results.map((row) => ({ "id": row.id, "githubId": row.github_id, "createdAt": row.created_at, "deletedAt": row.deleted_at, "liveSessions": row.live, "lastSeenAt": row.last_seen })) });
});

/** One user: the same, every sign-in they've had (live and ended, with its client), and their latest audit rows. */
admin.get("/users/:id", requires("users:read"), async (context) => {
	const id = context.req.param("id");
	const user = await context.env.DB.prepare(`SELECT id, ${githubIdColumn("users")} AS github_id, created_at, deleted_at FROM users WHERE id = ?`).bind(id).first<{ "id": string; "github_id": number; "created_at": number; "deleted_at": number | null }>();

	if (user === null) {
		return context.json({ "error": "not_found" }, 404);
	}

	const [sessions, rows] = await context.env.DB.batch([
		context.env.DB.prepare("SELECT id, client, label, created_at, last_used_at, revoked_at FROM grants WHERE user_id = ? ORDER BY last_used_at DESC").bind(id),
		context.env.DB.prepare("SELECT id, at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(id)
	]);

	return context.json({
		"user": { "id": user.id, "githubId": user.github_id, "createdAt": user.created_at, "deletedAt": user.deleted_at },
		"sessions": (sessions?.results ?? []).map((row) => session(row as Record<string, unknown>, context.get("grant"))),
		"audit": (rows?.results ?? []).map(auditRow)
	});
});

/** Live sign-ins across users, the most recently used first. */
admin.get("/sessions", requires("sessions:read"), async (context) => {
	const { results } = await context.env.DB.prepare(`SELECT g.id, g.client, g.label, g.created_at, g.last_used_at, g.revoked_at, g.user_id, ${githubIdColumn("u")} AS github_id
		FROM grants g JOIN users u ON u.id = g.user_id WHERE g.revoked_at IS NULL ORDER BY g.last_used_at DESC LIMIT ?`).bind(limitOf(context.req.query("limit"), 200, 1000)).all();

	return context.json({ "sessions": results.map((row) => ({ ...session(row, context.get("grant")), "userId": row["user_id"], "githubId": row["github_id"] })) });
});

/**
 * The audit log, newest first, filtered as `npm run audit` filters it: `event`, `user`, `grant`, `ip` (a hash),
 * `suspicious` (everything but the everyday record), `since` (`24h`, `7d`), and `before` (an id, for the next page).
 * And `repo` (`owner/name`): the proxy's calls about that repository, found by hashing its name as the log does
 * (BEHAVIOR.md); the log itself never names one.
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

	if (query["repo"] !== undefined && query["repo"] !== "") {
		where.push("detail LIKE ?");
		values.push(`% ${await repositoryTag(context.env, query["repo"])}%`);
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

// ── Your own account (src/account-routes.ts) ───────────────────────────────────────────────────────────────────────
// Any admin token, roles or none: it's your own account. The editor has the same routes at /account.

admin.route("/account", accountRoutes());

/** Cloudflare's analytics of the zone and the Workers (src/traffic.ts), through the API's own read-only token. */
admin.get("/traffic", requires("traffic:read"), trafficEndpoint);

/** The cost guard's estimate (src/spend.ts, OPERATIONS.md O2): the last 24 hours by meter, the budget, 14 days by day. */
admin.get("/spend", requires("traffic:read"), spendEndpoint);

/** What our email did (src/mail-report.ts): codes sent, delivered and not, sign-ins by email, refusals; counts only. */
admin.get("/mail", requires("mail:read"), mailEndpoint);

/** Our own inbox (src/inbox.ts): the latest mail to our addresses, who from, subject and size. */
admin.get("/inbox", requires("mail:read"), inboxEndpoint);

/** The email smoke test (src/smoke.ts), now: a sign-in by email with our own address, the code read back from our inbox.
 *  It sends a real email, so it's a permission of its own. */
admin.post("/mail/smoke", requires("mail:test"), async (context) => context.json(await smokeTest(context.env, context.executionCtx)));

/** Errors (src/errors.ts, OPERATIONS.md O4): the groups, a group's occurrences, one occurrence by the id a person quoted. */
admin.get("/errors", requires("errors:read"), errorsEndpoint);

admin.get("/errors/occurrence/:id", requires("errors:read"), errorOccurrenceEndpoint);

/** One of a release's source maps (O7), for the admin app to map an editor stack with. */
admin.get("/errors/maps/:release/:path{.+\\.map}", requires("errors:read"), sourceMapEndpoint);

admin.get("/errors/:fingerprint", requires("errors:read"), errorGroupEndpoint);

/** The emails to the owner (src/mail.ts, `tellOwner`): each, and what Cloudflare says became of it; and a test one. */
admin.get("/alerts", requires("mail:read"), alertsEndpoint);

admin.post("/alerts/test", requires("mail:test"), testAlertEndpoint);

/** The API as it runs, described by itself (src/architecture.ts): routes, stores and their tables, counts. */
admin.get("/architecture", requires("architecture:read"), architectureEndpoint);

/** What a sign-in did that the editor doesn't (B7), counted beside its score. */
const FLAGS = ["probe", "proxy_denied", "client_unusual", "client_changed"];

/**
 * The sign-ins whose transitions surprised the model most (BEHAVIOR.md, B8 and B9): mean bits a scored step, highest
 * first, each with its most surprising transitions (templates only) and how many times it did what the editor doesn't
 * (B7's rows). Only sign-ins with `min` scored steps (default 3): one odd step says little.
 */
admin.get("/unusual", requires("behavior:read"), async (context) => {
	const { results } = await context.env.DB.prepare(`SELECT s.grant_id, s.steps, s.bits, s.top, s.updated_at, g.client, g.label, g.created_at, g.last_used_at, g.revoked_at, g.user_id, ${githubIdColumn("u")} AS github_id,
			(SELECT json_group_object(event, n) FROM (SELECT event, COUNT(*) AS n FROM audit a WHERE a.grant_id = s.grant_id AND a.event IN (${FLAGS.map(() => "?").join(", ")}) GROUP BY event)) AS flags
		FROM scores s JOIN grants g ON g.id = s.grant_id JOIN users u ON u.id = g.user_id
		WHERE s.steps >= ? ORDER BY s.bits / s.steps DESC LIMIT ?`).bind(...FLAGS, limitOf(context.req.query("min"), 3, 1000), limitOf(context.req.query("limit"), 100, 500)).all<Record<string, unknown>>();

	return context.json({ "sessions": results.map((row) => ({
		...session({ "id": row["grant_id"], "client": row["client"], "label": row["label"], "created_at": row["created_at"], "last_used_at": row["last_used_at"], "revoked_at": row["revoked_at"] }, context.get("grant")),
		"userId": row["user_id"],
		"githubId": row["github_id"],
		"score": { "mean": (row["bits"] as number) / (row["steps"] as number), "steps": row["steps"], "top": JSON.parse(row["top"] as string) as unknown, "updatedAt": row["updated_at"] },
		"flags": JSON.parse((row["flags"] as string | null) ?? "{}") as Record<string, number>
	})) });
});

// ── Writes (B6) ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * End someone's sign-in, with `confirm=revoke`: its tokens stop working at once, and its GitHub token is revoked at
 * GitHub (Grant.revoke). Recorded on both sides: the sign-in's own row (`grant_revoked`, "ended by an admin", on that
 * user's record), and the admin's (`admin_revoked`, naming the sign-in and whose it was; never routine, so it's kept as
 * long as a refusal is and shows among the suspicious).
 */
/** A sign-in's timeline (src/timeline.ts, OPERATIONS.md O5): its requests, audit rows and errors, in order. */
admin.get("/sessions/:id/timeline", requires("sessions:replay"), timelineEndpoint);

admin.post("/sessions/:id/revoke", requires("sessions:revoke"), async (context) => {
	if ((await context.req.parseBody())["confirm"] !== "revoke") {
		return context.json({ "error": "confirm", "message": "send confirm=revoke" }, 400);
	}

	const id = context.req.param("id");
	const row = /^[0-9a-f]{64}$/u.test(id) ? await context.env.DB.prepare("SELECT user_id FROM grants WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ "user_id": string }>() : null;

	if (row === null) {
		return context.json({ "error": "not_found" }, 404);
	}

	const grant = grantStub(context.env, id);

	// The tripwire's canary isn't anyone's sign-in, and ending it would leave the tripwire without its bait.
	if (grant === undefined) {
		return context.json({ "error": "canary", "message": "the tripwire's canary isn't a sign-in to end" }, 409);
	}

	const from = await origin(context);

	await grant.revoke({ "from": from, "reason": "ended by an admin" });
	await audit(context.env, "admin_revoked", { "userId": context.get("user"), "grantId": context.get("grant") }, from, { "detail": `sign-in ${id} of user ${row.user_id}` });

	return context.json({ "revoked": 1 });
});

/** A sign-in as the admin app shows it; `current` is the admin's own (ended by signing out, not from a list). */
function session(row: Record<string, unknown>, current: string): Record<string, unknown> {
	return { "id": row["id"], "client": row["client"] ?? "editor", "label": row["label"], "createdAt": row["created_at"], "lastUsedAt": row["last_used_at"], "revokedAt": row["revoked_at"], "current": row["id"] === current };
}

function auditRow(row: Record<string, unknown>): Record<string, unknown> {
	return { "id": row["id"], "at": row["at"], "event": row["event"], "userId": row["user_id"], "grantId": row["grant_id"], "country": row["country"], "ipHash": row["ip_hash"], "reason": row["reason"], "detail": row["detail"], "traceId": row["trace_id"] };
}
