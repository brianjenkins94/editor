/**
 * The admin app's overview and its users (packages/api/README.md, "The UI"): a page of cards, the list of accounts, and
 * one user's identities, sign-ins and audit rows. Each reads the admin API; what the signed-in user's roles don't allow,
 * the API refuses and the page says so.
 */
import type { ComponentChildren } from "preact";
import { AuditRows, ROUTINE } from "./audit";
import { SessionRows } from "./sessions";
import { Loading, Login, short, Table, useRead, When } from "./ui";

export interface User { "id": string; "githubId": number | null; "createdAt": number; "deletedAt": number | null; "liveSessions": number; "lastSeenAt": number | null }

/** A deleted account is kept 30 days (packages/api/src/account.ts, GRACE_DAYS), restorable by signing in, then purged. */
const PURGE_AFTER = 30 * 86_400_000;

function Deleted({ at }: { "at": number | null }) {
	return at === null ? null : <wa-badge variant="danger" title={`Purged after ${new Date(at + PURGE_AFTER).toLocaleDateString()} unless they sign in again`}>deleted</wa-badge>;
}

export function Overview({ "switch": killSwitch }: { "switch"?: ComponentChildren }) {
	const users = useRead("/users");
	const sessions = useRead("/sessions");
	const today = useRead("/audit?since=24h&limit=500");
	const suspicious = today.data?.rows.filter((row) => !ROUTINE.has(row.event));
	const card = (label: string, value: number | undefined, href: string) => (
		<a class="wa-link-plain" href={href}>
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
			{killSwitch}
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

export function UserPage({ id }: { "id": string }) {
	const read = useRead(`/users/${encodeURIComponent(id)}`);

	return (
		<Loading read={read}>{() => (
			<section class="wa-stack wa-gap-l">
				<h1 class="wa-heading-xl"><Login id={read.data!.user.githubId} /> <Deleted at={read.data!.user.deletedAt} /></h1>
				<p class="wa-color-text-quiet">{read.data!.user.githubId === null ? "No GitHub account" : `GitHub user ${read.data!.user.githubId}`} · joined <When at={read.data!.user.createdAt} /> · our id <span class="mono">{id}</span></p>
				{read.data!.user.deletedAt !== null && <wa-callout variant="warning">They deleted their account <When at={read.data!.user.deletedAt} />. It's purged after {new Date(read.data!.user.deletedAt + PURGE_AFTER).toLocaleDateString()}, unless they sign in again before then.</wa-callout>}
				<h2 class="wa-heading-l">Sign-ins</h2>
				<SessionRows sessions={read.data!.sessions} withUser={false} />
				<h2 class="wa-heading-l">Latest audit rows</h2>
				<AuditRows rows={read.data!.audit} />
			</section>
		)}</Loading>
	);
}
