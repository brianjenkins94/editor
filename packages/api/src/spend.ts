import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { audit, NOWHERE } from "./audit.ts";
import { tellOwner } from "./mail.ts";
import { maintenance, setMaintenance } from "./maintenance.ts";

/**
 * The cost guard (OPERATIONS.md, "The cost guard"): every hour, the account's usage over the last 24 hours, meter by
 * meter, from Cloudflare's GraphQL Analytics (the read-only ANALYTICS_TOKEN src/traffic.ts uses), priced at the Workers
 * Paid plan's overage rates. That ignores what the plan includes, so it overestimates: a runaway shows up early, never
 * late. Half the daily budget emails the owner (once a day); the whole budget turns the kill switch on (src/maintenance.ts),
 * which emails too. If the analytics can't be read three hours running, the owner is told the guard is blind.
 *
 * The usage is the account's (both deployments, every Worker on it): it's the account that's billed. Each deployment
 * runs the check and guards itself, so a runaway anywhere takes both down.
 */

/** A runaway, in dollars over 24 hours (decided 2026-10-19). */
export const BUDGET = 20;

/** Where the owner's told it's heading there. */
export const WARN_AT = BUDGET / 2;

/**
 * What each meter costs beyond the plan, in dollars per unit: Cloudflare's pricing pages as read on 2026-10-19
 * (developers.cloudflare.com/workers/platform/pricing, /email-service/platform/pricing). Static asset requests are free.
 */
export const PRICES = {
	"Worker requests": 0.30 / 1e6,
	"Worker CPU (ms)": 0.02 / 1e6,
	"Durable Object requests": 0.15 / 1e6,
	"Durable Object duration (GB-s)": 12.50 / 1e6,
	"Durable Object rows read": 0.001 / 1e6,
	"Durable Object rows written": 1.00 / 1e6,
	"D1 rows read": 0.001 / 1e6,
	"D1 rows written": 1.00 / 1e6,
	"R2 class A operations": 4.50 / 1e6,
	"R2 class B operations": 0.36 / 1e6,
	"Emails sent": 0.35 / 1e3
} as const;

export type Meter = keyof typeof PRICES;

/** R2's operations by class: reads are class B, deletes and aborts free, everything else (writes, lists) class A. */
const CLASS_B = new Set(["GetObject", "HeadObject", "HeadBucket", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

const FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

const QUERY = `query ($account: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $account }) {
	workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests cpuTimeUs } dimensions { date } }
	d1: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { rowsRead rowsWritten } dimensions { date } }
	objects: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { date } }
	periodic: durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { duration rowsRead rowsWritten } dimensions { date } }
	r2: r2OperationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } dimensions { date actionType } }
	email: emailSendingAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until, isLastEvent: 1 }) { count dimensions { date } }
} } }`;

interface Answer {
	"data"?: { "viewer": { "accounts": {
		"workers": { "sum": { "requests": number; "cpuTimeUs": number }; "dimensions": { "date": string } }[];
		"d1": { "sum": { "rowsRead": number; "rowsWritten": number }; "dimensions": { "date": string } }[];
		"objects": { "sum": { "requests": number }; "dimensions": { "date": string } }[];
		"periodic": { "sum": { "duration": number; "rowsRead": number; "rowsWritten": number }; "dimensions": { "date": string } }[];
		"r2": { "sum": { "requests": number }; "dimensions": { "date": string; "actionType": string } }[];
		"email": { "count": number; "dimensions": { "date": string } }[];
	}[] } };
	"errors"?: { "message": string }[] | null;
}

/** Usage by day (UTC dates) and meter. */
export type Usage = Record<string, Partial<Record<Meter, number>>>;

/** The account's usage from `since` to `until`, by day and meter; or why it couldn't be read. */
export async function usage(env: Bindings, since: Date, until: Date): Promise<{ "days": Usage } | { "unreadable": string }> {
	if (env.ANALYTICS_TOKEN === undefined || env.ANALYTICS_TOKEN === "") {
		return { "unreadable": "ANALYTICS_TOKEN isn't set here" };
	}

	const response = await fetch(`${env.CLOUDFLARE_API ?? "https://api.cloudflare.com"}/client/v4/graphql`, {
		"method": "POST",
		"headers": { "authorization": `Bearer ${env.ANALYTICS_TOKEN}`, "content-type": "application/json" },
		"body": JSON.stringify({ "query": QUERY, "variables": { "account": env.ANALYTICS_ACCOUNT, "since": since.toISOString(), "until": until.toISOString() } })
	}).catch(() => undefined);
	const answer = await response?.json().catch(() => ({})) as Answer | undefined;
	const account = answer?.data?.viewer.accounts[0];

	if (response?.ok !== true || account === undefined || (answer?.errors ?? []).length > 0) {
		return { "unreadable": (answer?.errors ?? []).map((error) => error.message).join("; ") || `Cloudflare answered ${response?.status ?? "nothing"}` };
	}

	const days: Usage = {};
	const add = (date: string, meter: Meter, amount: number): void => {
		days[date] ??= {};
		days[date][meter] = (days[date][meter] ?? 0) + amount;
	};

	for (const { sum, dimensions } of account.workers) {
		add(dimensions.date, "Worker requests", sum.requests);
		add(dimensions.date, "Worker CPU (ms)", sum.cpuTimeUs / 1000);
	}

	for (const { sum, dimensions } of account.d1) {
		add(dimensions.date, "D1 rows read", sum.rowsRead);
		add(dimensions.date, "D1 rows written", sum.rowsWritten);
	}

	for (const { sum, dimensions } of account.objects) {
		add(dimensions.date, "Durable Object requests", sum.requests);
	}

	for (const { sum, dimensions } of account.periodic) {
		add(dimensions.date, "Durable Object duration (GB-s)", sum.duration);
		add(dimensions.date, "Durable Object rows read", sum.rowsRead);
		add(dimensions.date, "Durable Object rows written", sum.rowsWritten);
	}

	for (const { sum, dimensions } of account.r2) {
		if (!FREE.has(dimensions.actionType)) {
			add(dimensions.date, CLASS_B.has(dimensions.actionType) ? "R2 class B operations" : "R2 class A operations", sum.requests);
		}
	}

	for (const { count, dimensions } of account.email) {
		add(dimensions.date, "Emails sent", count);
	}

	return { "days": days };
}

/** Each meter's amount and cost over a set of days, the most expensive first, and the total. */
export function priced(days: Usage): { "total": number; "meters": { "meter": Meter; "amount": number; "dollars": number }[] } {
	const amounts = new Map<Meter, number>();

	for (const day of Object.values(days)) {
		for (const [meter, amount] of Object.entries(day) as [Meter, number][]) {
			amounts.set(meter, (amounts.get(meter) ?? 0) + amount);
		}
	}

	const meters = [...amounts].map(([meter, amount]) => ({ "meter": meter, "amount": amount, "dollars": amount * PRICES[meter] })).toSorted((a, b) => b.dollars - a.dollars);

	return { "total": meters.reduce((total, meter) => total + meter.dollars, 0), "meters": meters };
}

const money = (dollars: number): string => `$${dollars.toFixed(2)}`;

/** Whether `event` was audited in the last `hours` hours: what keeps an email to once a day. */
async function since(env: Bindings, event: string, hours: number): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = ? AND at > ?").bind(event, Date.now() - hours * 3_600_000).first<{ "n": number }>();

	return row?.n ?? 0;
}

/**
 * The hourly check: the last 24 hours, priced. At the budget, the kill switch on (unless it is already, or a person turned
 * it off in the last day: then at double the budget); past half of it, the owner emailed once a day. Unreadable, recorded; three hours running, the owner told the guard is blind (once a
 * day). What it found, for the log.
 */
export async function checkSpend(env: Bindings): Promise<{ "total": number } | { "unreadable": string }> {
	const until = new Date();
	const read = await usage(env, new Date(until.getTime() - 24 * 3_600_000), until);

	if ("unreadable" in read) {
		await audit(env, "spend_unreadable", {}, NOWHERE, { "reason": read.unreadable.slice(0, 200) });

		if (await since(env, "spend_unreadable", 3.5) >= 3 && await since(env, "spend_blind", 24) === 0) {
			await audit(env, "spend_blind", {}, NOWHERE, { "reason": read.unreadable.slice(0, 200) });
			await tellOwner(env, "The cost guard can't read Cloudflare's analytics", `For three hours the hourly spend check couldn't read usage: ${read.unreadable}\nUntil it can, only Cloudflare's own billing notification would catch a runaway. Check ANALYTICS_TOKEN.`);
		}

		return read;
	}

	const { total, meters } = priced(read.days);
	const top = meters[0];
	const breakdown = meters.filter((meter) => meter.dollars >= 0.005).map((meter) => `${meter.meter}: ${Math.round(meter.amount).toLocaleString("en")} = ${money(meter.dollars)}`).join("\n") || "every meter under a cent";

	// A person turned the switch off in the last day (after a trip, say): the trailing 24 hours stay over budget a while
	// yet, so warn rather than trip again, unless it's double the budget.
	const overruled = (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'maintenance_off' AND at > ? AND detail != 'by cost guard' AND detail != 'by tripwire'").bind(Date.now() - 24 * 3_600_000).first<{ "n": number }>())?.n ?? 0;

	if (total >= (overruled > 0 ? 2 * BUDGET : BUDGET) && !(await maintenance(env)).on) {
		await audit(env, "spend_tripped", {}, NOWHERE, { "reason": `${money(total)} in 24 hours`, "detail": top?.meter });
		await setMaintenance(env, true, `spend: ${money(total)} in 24 hours, the budget ${money(BUDGET)}; mostly ${top?.meter ?? "unknown"}`, "cost guard");
		await tellOwner(env, `Spend past the budget: ${money(total)} in 24 hours`, `The cost guard turned the kill switch on.\n\n${breakdown}\n\nPriced at overage rates, so it's an overestimate. Find the cause before turning it off: the admin app's Traffic page has the same breakdown.`);
	} else if (total >= WARN_AT && await since(env, "spend_warning", 24) === 0) {
		await audit(env, "spend_warning", {}, NOWHERE, { "reason": `${money(total)} in 24 hours`, "detail": top?.meter });
		await tellOwner(env, `Spend at ${money(total)} in 24 hours`, `Past half the daily budget (${money(BUDGET)}): at the whole of it, the cost guard turns the kill switch on.\n\n${breakdown}`);
	}

	return { "total": total };
}

/** GET /admin/spend: the last 24 hours priced by meter, the budget, and the last 14 days' estimates by day. */
export async function spendEndpoint(context: Context<AppEnv>): Promise<Response> {
	const until = new Date();
	const [day, fortnight] = await Promise.all([usage(context.env, new Date(until.getTime() - 24 * 3_600_000), until), usage(context.env, new Date(until.getTime() - 14 * 86_400_000), until)]);

	if ("unreadable" in day || "unreadable" in fortnight) {
		return context.json({ "error": "analytics", "message": "unreadable" in day ? day.unreadable : (fortnight as { "unreadable": string }).unreadable }, 502);
	}

	return context.json({
		"budget": BUDGET,
		"warnAt": WARN_AT,
		"last24Hours": priced(day.days),
		"days": Object.keys(fortnight.days).toSorted().map((date) => ({ "date": date, "dollars": priced({ [date]: fortnight.days[date] ?? {} }).total }))
	});
}
