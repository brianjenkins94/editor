import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

/**
 * What our email did (packages/admin/README.md, the Mail page), from two records, side by side:
 *
 * - ours, the audit log: codes sent (`email_code_sent`), sign-ins by email (`login`, "email"), every refusal on the
 *   way (`sign_in_refused`, "email: …": the limits, wrong codes, and sends Email Service refused, by its error code),
 *   and the smoke test's last runs (src/smoke.ts);
 * - Cloudflare's, Email Service's analytics (`emailSendingAdaptiveGroups`, through the read-only ANALYTICS_TOKEN, as
 *   Traffic is): each email's last event, delivered or not and why, and how SPF, DKIM and DMARC came out.
 *
 * Zero-knowledge: counts by day and reason, never an address (ours are hashed already; Cloudflare's recipient and
 * subject aren't asked for). The suppression list isn't here: reading it needs an Email Sending Edit token.
 */

const DAY = 86_400_000;

const QUERY = `query ($zone: String!, $since: Date!, $until: Date!) { viewer { zones(filter: { zoneTag: $zone }) {
	emails: emailSendingAdaptiveGroups(limit: 1000, filter: { date_geq: $since, date_leq: $until, isLastEvent: 1 }, orderBy: [date_ASC]) { count dimensions { date status errorCause spf dkim dmarc } }
} } }`;

interface Delivery { "count": number; "dimensions": { "date": string; "status": string; "errorCause": string; "spf": string; "dkim": string; "dmarc": string } }

/** Cloudflare's side, or why it isn't here. Its records are the zone's: dev's and production's sends together (both are
 *  from no-reply@unusuallygood.dev), and none of a local API's, which sends to an outbox. */
async function deliveries(context: Context<AppEnv>, since: string, until: string): Promise<{ "rows": Delivery[] } | { "error": string }> {
	if (context.env.ENVIRONMENT === "local") {
		return { "error": "a local API sends to an outbox, not through Cloudflare" };
	}

	if (context.env.ANALYTICS_TOKEN === undefined || context.env.ANALYTICS_TOKEN === "") {
		return { "error": "ANALYTICS_TOKEN isn't set for this environment" };
	}

	const response = await fetch(`${context.env.CLOUDFLARE_API ?? "https://api.cloudflare.com"}/client/v4/graphql`, {
		"method": "POST",
		"headers": { "authorization": `Bearer ${context.env.ANALYTICS_TOKEN}`, "content-type": "application/json" },
		"body": JSON.stringify({ "query": QUERY, "variables": { "zone": context.env.ANALYTICS_ZONE, "since": since, "until": until } })
	}).catch(() => undefined);
	const answer = await response?.json().catch(() => ({})) as { "data"?: { "viewer": { "zones": { "emails": Delivery[] }[] } }; "errors"?: { "message": string }[] | null } | undefined;
	const rows = answer?.data?.viewer.zones[0]?.emails;

	return rows === undefined || (answer?.errors ?? []).length > 0 ? { "error": (answer?.errors ?? []).map((error) => error.message).join("; ") || `Cloudflare answered ${response?.status ?? "nothing"}` } : { "rows": rows };
}

/** GET /admin/mail?days=14 (at most 30): by day, codes sent, delivered and not, sign-ins by email, refusals; and the
 *  refusals and delivery failures by reason, and authentication's results. */
export async function mailEndpoint(context: Context<AppEnv>): Promise<Response> {
	const days = Math.min(Math.max(Number.parseInt(context.req.query("days") ?? "", 10) || 14, 1), 30);
	const now = Date.now();
	const start = now - (days - 1) * DAY;
	const since = new Date(start).toISOString().slice(0, 10);
	const until = new Date(now).toISOString().slice(0, 10);
	const day = "strftime('%Y-%m-%d', at / 1000, 'unixepoch')";
	const db = context.env.DB;
	const [sent, signedIn, refused, smoke] = await db.batch([
		db.prepare(`SELECT ${day} AS day, COUNT(*) AS count FROM audit WHERE event = 'email_code_sent' AND at >= ? GROUP BY day`).bind(Date.parse(since)),
		db.prepare(`SELECT ${day} AS day, COUNT(*) AS count FROM audit WHERE event = 'login' AND reason = 'email' AND at >= ? GROUP BY day`).bind(Date.parse(since)),
		db.prepare(`SELECT ${day} AS day, reason, COUNT(*) AS count FROM audit WHERE event = 'sign_in_refused' AND reason LIKE 'email: %' AND at >= ? GROUP BY day, reason`).bind(Date.parse(since)),
		db.prepare("SELECT at, event, reason FROM audit WHERE event IN ('smoke_test_passed', 'smoke_test_failed') ORDER BY id DESC LIMIT 10")
	]);
	const cloudflare = await deliveries(context, since, until);
	const delivered = "rows" in cloudflare ? cloudflare.rows : [];
	const byDay = (rows: { "day": string; "count": number }[] | undefined, date: string): number => (rows ?? []).filter((row) => row.day === date).reduce((sum, row) => sum + row.count, 0);
	const tally = <T>(rows: T[], key: (row: T) => string, count: (row: T) => number): { "key": string; "count": number }[] => [...rows.reduce((totals, row) => totals.set(key(row), (totals.get(key(row)) ?? 0) + count(row)), new Map<string, number>())].map(([key, total]) => ({ "key": key, "count": total })).sort((a, b) => b.count - a.count);
	const refusals = (refused?.results ?? []) as { "day": string; "reason": string; "count": number }[];
	const dates = Array.from({ "length": days }, (_, index) => new Date(start + index * DAY).toISOString().slice(0, 10));

	return context.json({
		"window": { "days": days, "since": since, "until": until },
		"days": dates.map((date) => ({
			"day": date,
			"sent": byDay(sent?.results as { "day": string; "count": number }[], date),
			"delivered": delivered.filter((row) => row.dimensions.date === date && row.dimensions.status === "delivered").reduce((sum, row) => sum + row.count, 0),
			"failed": delivered.filter((row) => row.dimensions.date === date && row.dimensions.status !== "delivered").reduce((sum, row) => sum + row.count, 0),
			"signedIn": byDay(signedIn?.results as { "day": string; "count": number }[], date),
			"refused": refusals.filter((row) => row.day === date).reduce((sum, row) => sum + row.count, 0)
		})),
		"refusals": tally(refusals, (row) => row.reason.slice("email: ".length), (row) => row.count).map(({ key, count }) => ({ "reason": key, "count": count })),
		"failures": tally(delivered.filter((row) => row.dimensions.status !== "delivered"), (row) => `${row.dimensions.status}${row.dimensions.errorCause === "" ? "" : `: ${row.dimensions.errorCause}`}`, (row) => row.count).map(({ key, count }) => ({ "reason": key, "count": count })),
		"authentication": (["spf", "dkim", "dmarc"] as const).map((check) => ({ "check": check, "results": tally(delivered, (row) => row.dimensions[check] || "none", (row) => row.count).map(({ key, count }) => ({ "result": key, "count": count })) })),
		"smoke": ((smoke?.results ?? []) as { "at": number; "event": string; "reason": string }[]).map((row) => ({ "at": row.at, "passed": row.event === "smoke_test_passed", "reason": row.reason })),
		"cloudflare": "error" in cloudflare ? { "error": cloudflare.error } : { "ok": true }
	});
}
