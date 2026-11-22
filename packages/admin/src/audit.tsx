/**
 * The audit log (packages/api/README.md, "The UI"), filtered as the address says, and the rows a user's page shows of it.
 */
import { useEffect, useState } from "preact/hooks";
import { get } from "./session";
import { short, Table, When } from "./ui";

export interface AuditRow { "id": number; "at": number; "event": string; "userId": string | null; "grantId": string | null; "country": string | null; "ipHash": string | null; "reason": string | null; "detail": string | null; "traceId": string | null }

/** The everyday record; everything else is worth a second look (packages/api/src/audit-copies.ts, ROUTINE). */
export const ROUTINE = new Set(["login", "token_issued", "refreshed", "grant_revoked", "github_refresh_refused", "proxy_call", "email_code_sent", "smoke_test_passed", "admin_access"]);

export function AuditRows({ rows }: { "rows": AuditRow[] }) {
	return (
		<Table head={["When", "Event", "Reason", "What", "User", "Sign-in", "Where", "Trace"]}>
			{rows.map((row) => (
				<tr key={row.id}>
					<td><When at={row.at} /></td>
					<td><wa-badge variant={ROUTINE.has(row.event) ? "neutral" : "warning"}>{row.event}</wa-badge></td>
					<td>{row.reason ?? ""}</td>
					<td class="mono">{row.detail ?? ""}</td>
					<td>{row.userId === null ? "" : <a class="mono" href={`#/users/${row.userId}`}>{short(row.userId)}</a>}</td>
					<td class="mono">{short(row.grantId)}</td>
					<td>{[row.country, row.ipHash === null ? null : `ip#${row.ipHash.slice(0, 6)}`].filter(Boolean).join(" ")}</td>
					<td class="mono" title={row.traceId ?? ""}>{short(row.traceId)}</td>
				</tr>
			))}
		</Table>
	);
}

/** The audit log, filtered as the address says (`#/audit?event=…&suspicious=true&since=24h`), a page at a time. */
export function Audit({ query }: { "query": URLSearchParams }) {
	const [rows, setRows] = useState<AuditRow[]>([]);
	const [more, setMore] = useState<number | undefined>();
	const [error, setError] = useState<string | undefined>();
	const filters = (overrides: Record<string, string>): string => {
		const next = new URLSearchParams(query);

		for (const [key, value] of Object.entries(overrides)) {
			if (value === "") {
				next.delete(key);
			} else {
				next.set(key, value);
			}
		}

		return `#/audit?${next}`;
	};
	const load = async (before?: number): Promise<void> => {
		const page = new URLSearchParams(query);

		page.set("limit", "100");

		if (before !== undefined) {
			page.set("before", String(before));
		}

		try {
			const { rows: next } = await get<{ "rows": AuditRow[] }>(`/audit?${page}`);

			setRows((current) => (before === undefined ? next : [...current, ...next]));
			setMore(next.length === 100 ? next.at(-1)?.id : undefined);
		} catch (failure) {
			setError(failure instanceof Error && / 403$/u.test(failure.message) ? "Your roles don't include this." : "Couldn't load this.");
		}
	};

	useEffect(() => {
		void load();
	}, [query.toString()]);

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Audit log</h1>
			<form class="wa-cluster wa-gap-m wa-align-items-end" onSubmit={(event) => {
				event.preventDefault();
				const field = (name: string): string => (event.currentTarget.elements.namedItem(name) as HTMLInputElement).value.trim();

				location.hash = filters({ "event": field("event"), "repo": field("repo") });
			}}>
				<wa-input name="event" label="Event" placeholder="auth_refused" value={query.get("event") ?? ""} with-clear />
				<wa-input name="repo" label="Repository" placeholder="owner/name" value={query.get("repo") ?? ""} with-clear />
				<wa-select label="Since" value={query.get("since") ?? ""} onChange={(event: Event) => {
					location.hash = filters({ "since": (event.target as HTMLSelectElement).value });
				}}>
					<wa-option value="">Any time</wa-option>
					<wa-option value="1h">The last hour</wa-option>
					<wa-option value="24h">The last 24 hours</wa-option>
					<wa-option value="7d">The last 7 days</wa-option>
				</wa-select>
				<wa-checkbox checked={query.get("suspicious") === "true"} onChange={(event: Event) => {
					location.hash = filters({ "suspicious": (event.target as HTMLInputElement).checked ? "true" : "" });
				}}>Worth a look only</wa-checkbox>
				<wa-button type="submit" variant="neutral">Filter</wa-button>
			</form>
			{error !== undefined ? <wa-callout variant="danger">{error}</wa-callout> : <AuditRows rows={rows} />}
			{more !== undefined && <wa-button appearance="outlined" onClick={() => void load(more)}>Older rows</wa-button>}
		</section>
	);
}
