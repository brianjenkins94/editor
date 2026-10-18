import type { AppEnv } from "./env.ts";
import { Hono } from "hono";
import { ROUTINE } from "./audit-copies.ts";
import { architectureEndpoint } from "./architecture.ts";
import { audit, origin } from "./audit.ts";
import { githubIdColumn } from "./identities.ts";
import { inboxEndpoint } from "./inbox.ts";
import { emailLinkCodeEndpoint, emailLinkEndpoint, githubFinishEndpoint, githubLinkEndpoint } from "./link.ts";
import { mailEndpoint } from "./mail-report.ts";
import { emailMfaCodeEndpoint, emailMfaEndpoint, mfaConfirmEndpoint, mfaOffEndpoint, mfaRecoveryEndpoint, mfaStartEndpoint } from "./mfa.ts";
import { accountEndpoint, passwordCodeEndpoint, setPasswordEndpoint } from "./password.ts";
import { smokeTest } from "./smoke.ts";
import { repositoryTag } from "./behavior.ts";
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

// ── Your own account (C3) ──────────────────────────────────────────────────────────────────────────────────────────
// Any admin token, roles or none: it's your own account. Setting a password takes a code to your email first.

admin.get("/account", accountEndpoint);

admin.post("/account/password/code", passwordCodeEndpoint);

admin.post("/account/password", setPasswordEndpoint);

// Two-factor (C5): set up (start, then confirm with the app's code), turned off, new recovery codes. A recent sign-in each.
admin.post("/account/mfa/start", mfaStartEndpoint);

admin.post("/account/mfa/confirm", mfaConfirmEndpoint);

admin.post("/account/mfa/off", mfaOffEndpoint);

admin.post("/account/mfa/recovery", mfaRecoveryEndpoint);

// Two-factor by email (C6): a code to your email, then on or off.
admin.post("/account/mfa/email/code", emailMfaCodeEndpoint);

admin.post("/account/mfa/email", emailMfaEndpoint);

admin.post("/account/github", githubLinkEndpoint);

admin.post("/account/github/finish", githubFinishEndpoint);

admin.post("/account/email/code", emailLinkCodeEndpoint);

admin.post("/account/email", emailLinkEndpoint);

/** Cloudflare's analytics of the zone and the Workers (src/traffic.ts), through the API's own read-only token. */
admin.get("/traffic", requires("traffic:read"), trafficEndpoint);

/** What our email did (src/mail-report.ts): codes sent, delivered and not, sign-ins by email, refusals; counts only. */
admin.get("/mail", requires("mail:read"), mailEndpoint);

/** Our own inbox (src/inbox.ts): the latest mail to our addresses, who from, subject and size. */
admin.get("/inbox", requires("mail:read"), inboxEndpoint);

/** The email smoke test (src/smoke.ts), now: a sign-in by email with our own address, the code read back from our inbox.
 *  It sends a real email, so it's a permission of its own. */
admin.post("/mail/smoke", requires("mail:test"), async (context) => context.json(await smokeTest(context.env, context.executionCtx)));

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
admin.post("/sessions/:id/revoke", requires("sessions:revoke"), async (context) => {
	if ((await context.req.parseBody())["confirm"] !== "revoke") {
		return context.json({ "error": "confirm", "message": "send confirm=revoke" }, 400);
	}

	const id = context.req.param("id");
	const row = /^[0-9a-f]{64}$/u.test(id) ? await context.env.DB.prepare("SELECT user_id FROM grants WHERE id = ? AND revoked_at IS NULL").bind(id).first<{ "user_id": string }>() : null;

	if (row === null) {
		return context.json({ "error": "not_found" }, 404);
	}

	const from = await origin(context);

	await context.env.GRANTS.get(context.env.GRANTS.idFromString(id)).revoke({ "from": from, "reason": "ended by an admin" });
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
