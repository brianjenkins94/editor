/**
 * The admin app's pages (README.md, "The UI"): an overview of cards, then native tables (Web Awesome's native styles) of
 * users, one user, sign-ins and the audit log. Each reads the admin API; what the signed-in user's roles don't allow, the
 * API refuses and the page says so. One write (B6): ending a sign-in, after a confirm.
 */
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { loginOf } from "./logins";
import { get, post } from "./session";

/** The signed-in admin's permissions (GET /admin/me), for the pages to offer only what they may do. */
export const Permissions = createContext<string[]>([]);

// ── Shapes the admin API answers with (packages/api/src/admin.ts) ─────────────────────────────────────────────────

export interface User { "id": string; "githubId": number; "createdAt": number; "deletedAt": number | null; "liveSessions": number; "lastSeenAt": number | null }

/** A deleted account is kept 30 days (packages/api/src/account.ts, GRACE_DAYS), restorable by signing in, then purged. */
const PURGE_AFTER = 30 * 86_400_000;

function Deleted({ at }: { "at": number | null }) {
	return at === null ? null : <wa-badge variant="danger" title={`Purged after ${new Date(at + PURGE_AFTER).toLocaleDateString()} unless they sign in again`}>deleted</wa-badge>;
}

interface Session { "id": string; "client": string; "label": string | null; "createdAt": number; "lastUsedAt": number; "revokedAt": number | null; "current": boolean; "userId"?: string; "githubId"?: number }

interface AuditRow { "id": number; "at": number; "event": string; "userId": string | null; "grantId": string | null; "country": string | null; "ipHash": string | null; "reason": string | null; "detail": string | null; "traceId": string | null }

/** What each admin API read answers, by path: the type of a page's data follows from the path it reads. */
interface Reads {
	"/users": { "users": User[] };
	"/sessions": { "sessions": Session[] };
	[user: `/users/${string}`]: { "user": { "githubId": number; "createdAt": number; "deletedAt": number | null }; "sessions": Session[]; "audit": AuditRow[] };
	[audit: `/audit?${string}`]: { "rows": AuditRow[] };
	[traffic: `/traffic?${string}`]: Traffic;
}

/** Cloudflare's analytics, as /admin/traffic shapes them (packages/api/src/traffic.ts). */
interface Traffic {
	"window": { "name": string; "since": string; "until": string };
	"byHost": { "host": string; "status": number; "requests": number }[];
	"paths": { "host": string; "path": string; "status": number; "requests": number }[];
	"agents": { "agent": string; "requests": number }[];
	"countries": { "country": string; "requests": number }[];
	"hours": { "hour": string; "host": string; "requests": number }[];
	"workers": { "script": string; "requests": number; "errors": number; "subrequests": number; "cpuP50": number; "cpuP99": number }[];
}

/** The everyday record; everything else is worth a second look (packages/api/src/audit-copies.ts, ROUTINE). */
const ROUTINE = new Set(["login", "token_issued", "refreshed", "grant_revoked", "github_refresh_refused", "proxy_call", "admin_access"]);

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A read, its result once it's here, and what went wrong if it didn't come. */
function useRead<P extends keyof Reads>(path: P): { "data"?: Reads[P]; "error"?: string } {
	const [result, setResult] = useState<{ "data"?: Reads[P]; "error"?: string }>({});

	useEffect(() => {
		let current = true;

		setResult({});
		get<Reads[P]>(path).then((data) => {
			if (current) {
				setResult({ "data": data });
			}
		}, (error: unknown) => {
			if (current) {
				setResult({ "error": error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : error instanceof Error && / 503$/u.test(error.message) ? "No analytics token is set for this API (ANALYTICS_TOKEN)." : "Couldn't load this." });
			}
		});

		return () => {
			current = false;
		};
	}, [path]);

	return result;
}

function Loading({ read, children }: { "read": { "data"?: unknown; "error"?: string }; "children": () => ComponentChildren }): ComponentChildren {
	if (read.error !== undefined) {
		return <wa-callout variant="danger">{read.error}</wa-callout>;
	}

	return read.data === undefined ? <wa-spinner /> : children();
}

/** A GitHub user, by login (looked up live) with their id. */
function Login({ id }: { "id": number }) {
	const [login, setLogin] = useState<string | undefined>();

	useEffect(() => {
		void loginOf(id).then(setLogin);
	}, [id]);

	return <span title={`GitHub user ${id}`}>{login ?? `#${id}`}</span>;
}

/** A moment, relative ("3 minutes ago"), with the exact time on hover. */
function When({ at }: { "at": number | null }) {
	return at === null ? <span class="muted">never</span> : <wa-relative-time date={new Date(at).toISOString()} title={new Date(at).toLocaleString()} />;
}

const short = (id: string | null | undefined): string => (typeof id === "string" ? `${id.slice(0, 8)}…` : "");

function Table({ head, children }: { "head": string[]; "children": ComponentChildren }) {
	return (
		<div class="table">
			<table class="wa-zebra-rows wa-hover-rows">
				<thead><tr>{head.map((label) => <th key={label}>{label}</th>)}</tr></thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function Overview() {
	const users = useRead("/users");
	const sessions = useRead("/sessions");
	const today = useRead("/audit?since=24h&limit=500");
	const suspicious = today.data?.rows.filter((row) => !ROUTINE.has(row.event));
	const card = (label: string, value: number | undefined, href: string) => (
		<a class="stat" href={href}>
			<wa-card>
				<div class="wa-stack wa-gap-2xs">
					<span class="wa-caption-m">{label}</span>
					<strong class="wa-heading-2xl">{value ?? "…"}</strong>
				</div>
			</wa-card>
		</a>
	);

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Overview</h1>
			<div class="wa-grid wa-gap-l stats">
				{card("Users", users.data?.users.length, "#/users")}
				{card("Live sign-ins", sessions.data?.sessions.length, "#/sessions")}
				{card("Audit rows, last 24 hours", today.data?.rows.length, "#/audit?since=24h")}
				{card("Worth a look, last 24 hours", suspicious?.length, "#/audit?since=24h&suspicious=true")}
			</div>
		</section>
	);
}

export function Users() {
	const read = useRead("/users");

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Users</h1>
			<Loading read={read}>{() => (
				<Table head={["GitHub", "Joined", "Live sign-ins", "Last seen", "Our id"]}>
					{read.data!.users.map((user) => (
						<tr key={user.id}>
							<td><a href={`#/users/${user.id}`}><Login id={user.githubId} /></a> <Deleted at={user.deletedAt} /></td>
							<td><When at={user.createdAt} /></td>
							<td>{user.liveSessions}</td>
							<td><When at={user.lastSeenAt} /></td>
							<td class="mono">{short(user.id)}</td>
						</tr>
					))}
				</Table>
			)}</Loading>
		</section>
	);
}

function SessionRows({ sessions, withUser }: { "sessions": Session[]; "withUser": boolean }) {
	const canEnd = useContext(Permissions).includes("sessions:revoke");
	// Ended here since the list was read: when, by id.
	const [ended, setEnded] = useState<Record<string, number>>({});
	const [ending, setEnding] = useState<Session | undefined>();
	const endButton = (session: Session) => (
		<wa-button
			size="small"
			appearance="outlined"
			variant="danger"
			onClick={() => {
				setEnding(session);
			}}
		>
			End
		</wa-button>
	);

	return (
		<>
			<Table head={[...withUser ? ["GitHub"] : [], "Client", "Device", "Started", "Last used", "Ended", "Sign-in", ...canEnd ? [""] : []]}>
				{sessions.map((session) => {
					const revokedAt = session.revokedAt ?? ended[session.id] ?? null;

					return (
						<tr key={session.id}>
							{withUser && <td><a href={`#/users/${session.userId}`}><Login id={session.githubId as number} /></a></td>}
							<td><wa-badge variant={session.client === "admin" ? "brand" : "neutral"}>{session.client}</wa-badge></td>
							<td>{session.label ?? <span class="muted">unknown</span>}</td>
							<td><When at={session.createdAt} /></td>
							<td><When at={session.lastUsedAt} /></td>
							<td>{revokedAt === null ? <wa-badge variant="success">live</wa-badge> : <When at={revokedAt} />}</td>
							<td class="mono">{short(session.id)}</td>
							{canEnd && <td>{session.current ? <span class="muted">this one</span> : revokedAt === null && endButton(session)}</td>}
						</tr>
					);
				})}
			</Table>
			{ending !== undefined && (
				<EndSignIn
					session={ending}
					onClose={(at) => {
						if (at !== undefined) {
							setEnded({ ...ended, [ending.id]: at });
						}

						setEnding(undefined);
					}}
				/>
			)}
		</>
	);
}

/** The confirm step before ending a sign-in (POST /admin/sessions/:id/revoke, confirm=revoke): what will happen, then
 *  the call. Closes with when it ended, or with nothing if it didn't. */
function EndSignIn({ session, onClose }: { "session": Session; "onClose": (at?: number) => void }) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();
	const end = (): void => {
		setBusy(true);
		post(`/sessions/${session.id}/revoke`, { "confirm": "revoke" }).then(() => {
			onClose(Date.now());
		}, (error: unknown) => {
			setBusy(false);
			setProblem(error instanceof Error && / 404$/u.test(error.message) ? "It had already ended." : error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include ending sign-ins." : "Couldn't end it. Try again.");
		});
	};
	const whose = session.githubId === undefined ? "Their" : <><Login id={session.githubId} />'s</>;

	return (
		<wa-dialog
			open
			label="End this sign-in?"
			onwa-after-hide={(event: Event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div class="wa-stack">
				<p>
					{whose} {session.client} sign-in{session.label === null ? "" : ` on ${session.label}`}, started <When at={session.createdAt} />, stops working at once, and its GitHub token is revoked. They can sign in again.
				</p>
				<p class="muted">The audit log records that you ended it.</p>
				{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			</div>
			<wa-button slot="footer" appearance="plain" data-dialog="close">Cancel</wa-button>
			<wa-button slot="footer" variant="danger" loading={busy} onClick={end}>End sign-in</wa-button>
		</wa-dialog>
	);
}

function AuditRows({ rows }: { "rows": AuditRow[] }) {
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

export function UserPage({ id }: { "id": string }) {
	const read = useRead(`/users/${encodeURIComponent(id)}`);

	return (
		<Loading read={read}>{() => (
			<section class="wa-stack wa-gap-l">
				<h1 class="wa-heading-xl"><Login id={read.data!.user.githubId} /> <Deleted at={read.data!.user.deletedAt} /></h1>
				<p class="muted">GitHub user {read.data!.user.githubId} · joined <When at={read.data!.user.createdAt} /> · our id <span class="mono">{id}</span></p>
				{read.data!.user.deletedAt !== null && <wa-callout variant="warning">They deleted their account <When at={read.data!.user.deletedAt} />. It's purged after {new Date(read.data!.user.deletedAt + PURGE_AFTER).toLocaleDateString()}, unless they sign in again before then.</wa-callout>}
				<h2 class="wa-heading-l">Sign-ins</h2>
				<SessionRows sessions={read.data!.sessions} withUser={false} />
				<h2 class="wa-heading-l">Latest audit rows</h2>
				<AuditRows rows={read.data!.audit} />
			</section>
		)}</Loading>
	);
}

export function Sessions() {
	const read = useRead("/sessions");

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Live sign-ins</h1>
			<Loading read={read}>{() => <SessionRows sessions={read.data!.sessions} withUser={true} />}</Loading>
		</section>
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
			<form class="wa-cluster wa-gap-m filters" onSubmit={(event) => {
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
						<p class="muted">Cloudflare's analytics, {new Date(traffic.window.since).toLocaleString()} to {new Date(traffic.window.until).toLocaleString()}. The Free plan has no network (ASN) or security-event breakdowns.</p>
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
						<div class="wa-grid wa-gap-l pair">
							<div class="wa-stack">
								<h2 class="wa-heading-l">Top agents</h2>
								<Table head={["Requests", "User agent"]}>
									{traffic.agents.map((row) => <tr key={row.agent}><td>{row.requests}</td><td class="mono agent" title={row.agent}>{row.agent === "" ? "(none)" : row.agent}</td></tr>)}
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
