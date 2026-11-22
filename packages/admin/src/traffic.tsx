/**
 * The Traffic page (packages/api/README.md, "The UI"): what the last day would cost against the budget (the cost guard,
 * packages/api/src/spend.ts), then Cloudflare's analytics of the zone and the Workers for a window
 * (packages/api/src/traffic.ts).
 */
import { Loading, Table, useRead } from "./ui";

/** The cost guard's estimate (packages/api/src/spend.ts): overage rates, so an overestimate. */
export interface Spend {
	"budget": number;
	"warnAt": number;
	"last24Hours": { "total": number; "meters": { "meter": string; "amount": number; "dollars": number }[] };
	"days": { "date": string; "dollars": number }[];
}

/** Cloudflare's analytics, as /admin/traffic shapes them (packages/api/src/traffic.ts). */
export interface Traffic {
	"window": { "name": string; "since": string; "until": string };
	"byHost": { "host": string; "status": number; "requests": number }[];
	"paths": { "host": string; "path": string; "status": number; "requests": number }[];
	"agents": { "agent": string; "requests": number }[];
	"countries": { "country": string; "requests": number }[];
	"hours": { "hour": string; "host": string; "requests": number }[];
	"workers": { "script": string; "requests": number; "errors": number; "subrequests": number; "cpuP50": number; "cpuP99": number }[];
}

const money = (dollars: number): string => `$${dollars < 0.01 && dollars > 0 ? dollars.toFixed(4) : dollars.toFixed(2)}`;

/** The Traffic page's first section: what the last 24 hours would cost, against the budget, and the last 14 days. */
function SpendSection() {
	const read = useRead("/spend");

	return (
		<Loading read={read}>{() => {
			const spend = read.data!;
			const share = Math.min(1, spend.last24Hours.total / spend.budget);

			return (
				<div class="wa-stack">
					<h2 class="wa-heading-l">Spend</h2>
					<p class="wa-color-text-quiet">The last 24 hours at Cloudflare's overage rates (what the plan includes isn't taken off, so this is high). At {money(spend.warnAt)} you're emailed; at {money(spend.budget)} the cost guard turns the kill switch on. Checked hourly.</p>
					<div class="wa-cluster wa-gap-s">
						<strong class="wa-heading-2xl">{money(spend.last24Hours.total)}</strong>
						<span class="wa-color-text-quiet">of {money(spend.budget)} a day</span>
					</div>
					<wa-progress-bar value={share * 100} label="Share of the daily budget" />
					<Table head={["Meter", "Last 24 hours", "Cost"]}>
						{spend.last24Hours.meters.map((meter) => (
							<tr key={meter.meter}><td>{meter.meter}</td><td>{Math.round(meter.amount).toLocaleString()}</td><td>{money(meter.dollars)}</td></tr>
						))}
					</Table>
					<Table head={["Day (UTC)", "Estimate"]}>
						{spend.days.toReversed().map((day) => (
							<tr key={day.date}><td>{day.date}</td><td>{money(day.dollars)}</td></tr>
						))}
					</Table>
				</div>
			);
		}}</Loading>
	);
}

/** A status code as a badge: success, redirect, client error, server error. */
function Status({ code }: { "code": number }) {
	return <wa-badge variant={code >= 500 ? "danger" : code >= 400 ? "warning" : code >= 300 ? "neutral" : "success"}>{code}</wa-badge>;
}

/** Cloudflare's analytics of the zone (every host, the static ones included) and the Workers, for a window. */
export function TrafficPage({ query }: { "query": URLSearchParams }) {
	const window = query.get("window") ?? "24h";
	const read = useRead(`/traffic?window=${encodeURIComponent(window)}`);

	return (
		<section class="wa-stack wa-gap-l">
			<div class="wa-split">
				<h1 class="wa-heading-xl">Traffic</h1>
				<wa-select label="Window" value={window} onChange={(event: Event) => {
					location.hash = `#/traffic?window=${(event.target as HTMLSelectElement).value}`;
				}}>
					<wa-option value="1h">The last hour</wa-option>
					<wa-option value="6h">The last 6 hours</wa-option>
					<wa-option value="24h">The last 24 hours</wa-option>
				</wa-select>
			</div>
			<Loading read={read}>{() => {
				const traffic = read.data!;
				const hosts = [...new Set(traffic.byHost.map((row) => row.host))];
				const total = (host: string): number => traffic.byHost.filter((row) => row.host === host).reduce((sum, row) => sum + row.requests, 0);
				const hours = [...new Set(traffic.hours.map((row) => row.hour))];

				return (
					<div class="wa-stack wa-gap-l">
						<SpendSection />
						<p class="wa-color-text-quiet">Cloudflare's analytics, {new Date(traffic.window.since).toLocaleString()} to {new Date(traffic.window.until).toLocaleString()}. The Free plan has no network (ASN) or security-event breakdowns.</p>
						<h2 class="wa-heading-l">Workers</h2>
						<Table head={["Worker", "Requests", "Errors", "Subrequests", "CPU p50", "CPU p99"]}>
							{traffic.workers.map((row) => (
								<tr key={row.script}><td class="mono">{row.script}</td><td>{row.requests}</td><td>{row.errors}</td><td>{row.subrequests}</td><td>{(row.cpuP50 / 1000).toFixed(1)} ms</td><td>{(row.cpuP99 / 1000).toFixed(1)} ms</td></tr>
							))}
						</Table>
						<h2 class="wa-heading-l">By host and status</h2>
						<Table head={["Host", "Requests", "Statuses"]}>
							{hosts.map((host) => (
								<tr key={host}>
									<td class="mono">{host}</td>
									<td>{total(host)}</td>
									<td><div class="wa-cluster wa-gap-2xs">{traffic.byHost.filter((row) => row.host === host).map((row) => <span key={row.status}><Status code={row.status} /> {row.requests}</span>)}</div></td>
								</tr>
							))}
						</Table>
						<h2 class="wa-heading-l">By hour</h2>
						<Table head={["Hour", ...hosts]}>
							{hours.map((hour) => (
								<tr key={hour}>
									<td>{new Date(hour).toLocaleString([], { "month": "short", "day": "numeric", "hour": "numeric" })}</td>
									{hosts.map((host) => <td key={host}>{traffic.hours.find((row) => row.hour === hour && row.host === host)?.requests ?? ""}</td>)}
								</tr>
							))}
						</Table>
						<h2 class="wa-heading-l">Top paths</h2>
						<Table head={["Requests", "Status", "Host", "Path"]}>
							{traffic.paths.map((row) => <tr key={`${row.host}${row.path}${row.status}`}><td>{row.requests}</td><td><Status code={row.status} /></td><td class="mono">{row.host}</td><td class="mono">{row.path}</td></tr>)}
						</Table>
						<div class="wa-grid wa-gap-l wa-align-items-start pair">
							<div class="wa-stack">
								<h2 class="wa-heading-l">Top agents</h2>
								<Table head={["Requests", "User agent"]}>
									{traffic.agents.map((row) => <tr key={row.agent}><td>{row.requests}</td><td class="mono agent wa-text-truncate" title={row.agent}>{row.agent === "" ? "(none)" : row.agent}</td></tr>)}
								</Table>
							</div>
							<div class="wa-stack">
								<h2 class="wa-heading-l">Countries</h2>
								<Table head={["Requests", "Country"]}>
									{traffic.countries.map((row) => <tr key={row.country}><td>{row.requests}</td><td>{row.country}</td></tr>)}
								</Table>
							</div>
						</div>
					</div>
				);
			}}</Loading>
		</section>
	);
}
