import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

/**
 * Traffic (packages/admin/README.md, B4): Cloudflare's own analytics of the zone (unusuallygood.dev: every host, the
 * static ones included, which no Worker sees) and of the account's Workers, through Cloudflare's GraphQL API with
 * ANALYTICS_TOKEN, a read-only secret (Account Analytics Read; Zone Analytics Read on the zone). The browser never
 * holds a Cloudflare credential: it asks /admin/traffic.
 *
 * One GraphQL request per read, for a window of the last hour, 6 hours or 24 hours (the Free plan's analytics go back a
 * day). The Free plan doesn't offer the network (ASN) or security-event breakdowns.
 */

const WINDOWS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 - 60_000 } as const;

const QUERY = `query ($zone: String!, $account: String!, $since: Time!, $until: Time!) { viewer {
	zones(filter: { zoneTag: $zone }) {
		byHost: httpRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost edgeResponseStatus } }
		paths: httpRequestsAdaptiveGroups(limit: 40, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost clientRequestPath edgeResponseStatus } }
		agents: httpRequestsAdaptiveGroups(limit: 25, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) { count dimensions { userAgent } }
		countries: httpRequestsAdaptiveGroups(limit: 25, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [count_DESC]) { count dimensions { clientCountryName } }
		hours: httpRequestsAdaptiveGroups(limit: 500, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [datetimeHour_ASC]) { count dimensions { datetimeHour clientRequestHTTPHost } }
	}
	accounts(filter: { accountTag: $account }) {
		workers: workersInvocationsAdaptive(limit: 25, filter: { datetime_geq: $since, datetime_leq: $until }, orderBy: [sum_requests_DESC]) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } }
	}
} }`;

interface Group<D> { "count": number; "dimensions": D }

interface Answer {
	"data"?: { "viewer": {
		"zones": { "byHost": Group<{ "clientRequestHTTPHost": string; "edgeResponseStatus": number }>[]; "paths": Group<{ "clientRequestHTTPHost": string; "clientRequestPath": string; "edgeResponseStatus": number }>[]; "agents": Group<{ "userAgent": string }>[]; "countries": Group<{ "clientCountryName": string }>[]; "hours": Group<{ "datetimeHour": string; "clientRequestHTTPHost": string }>[] }[];
		"accounts": { "workers": { "sum": { "requests": number; "errors": number; "subrequests": number }; "quantiles": { "cpuTimeP50": number; "cpuTimeP99": number }; "dimensions": { "scriptName": string } }[] }[];
	} };
	"errors"?: { "message": string }[] | null;
}

/** GET /admin/traffic?window=1h|6h|24h (default 24h): requests by host and status, the top paths, agents and countries,
 *  requests by hour and host, and each Worker's requests, errors and CPU. */
export async function trafficEndpoint(context: Context<AppEnv>): Promise<Response> {
	if (context.env.ANALYTICS_TOKEN === undefined || context.env.ANALYTICS_TOKEN === "") {
		return context.json({ "error": "no_analytics_token", "message": "ANALYTICS_TOKEN isn't set for this environment" }, 503);
	}

	const name = context.req.query("window") ?? "24h";
	const span = WINDOWS[name as keyof typeof WINDOWS] ?? WINDOWS["24h"];
	const until = new Date();
	const since = new Date(until.getTime() - span);
	const response = await fetch(`${context.env.CLOUDFLARE_API ?? "https://api.cloudflare.com"}/client/v4/graphql`, {
		"method": "POST",
		"headers": { "authorization": `Bearer ${context.env.ANALYTICS_TOKEN}`, "content-type": "application/json" },
		"body": JSON.stringify({ "query": QUERY, "variables": { "zone": context.env.ANALYTICS_ZONE, "account": context.env.ANALYTICS_ACCOUNT, "since": since.toISOString(), "until": until.toISOString() } })
	});
	const answer = await response.json().catch(() => ({})) as Answer;
	const zone = answer.data?.viewer.zones[0];
	const account = answer.data?.viewer.accounts[0];

	if (!response.ok || zone === undefined || account === undefined || (answer.errors ?? []).length > 0) {
		// Cloudflare's own message names the field or permission it refused: worth showing to an admin, never a secret.
		return context.json({ "error": "analytics", "message": (answer.errors ?? []).map((error) => error.message).join("; ") || `Cloudflare answered ${response.status}` }, 502);
	}

	return context.json({
		"window": { "name": name in WINDOWS ? name : "24h", "since": since.toISOString(), "until": until.toISOString() },
		"byHost": zone.byHost.map((group) => ({ "host": group.dimensions.clientRequestHTTPHost, "status": group.dimensions.edgeResponseStatus, "requests": group.count })),
		"paths": zone.paths.map((group) => ({ "host": group.dimensions.clientRequestHTTPHost, "path": group.dimensions.clientRequestPath, "status": group.dimensions.edgeResponseStatus, "requests": group.count })),
		"agents": zone.agents.map((group) => ({ "agent": group.dimensions.userAgent, "requests": group.count })),
		"countries": zone.countries.map((group) => ({ "country": group.dimensions.clientCountryName, "requests": group.count })),
		"hours": zone.hours.map((group) => ({ "hour": group.dimensions.datetimeHour, "host": group.dimensions.clientRequestHTTPHost, "requests": group.count })),
		"workers": account.workers.map((worker) => ({ "script": worker.dimensions.scriptName, "requests": worker.sum.requests, "errors": worker.sum.errors, "subrequests": worker.sum.subrequests, "cpuP50": worker.quantiles.cpuTimeP50, "cpuP99": worker.quantiles.cpuTimeP99 }))
	});
}
