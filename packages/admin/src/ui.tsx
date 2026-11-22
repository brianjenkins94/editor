/**
 * What the admin app's pages share (packages/api/README.md, "The UI"): the signed-in admin's permissions, a read of the
 * admin API and what it answers, and the pieces every page draws its tables with. Each page is its feature's own file
 * (users.tsx, sessions.tsx, audit.tsx, unusual.tsx, traffic.tsx; errors, mail, the timeline and the switches beside them).
 */
import type { ComponentChildren } from "preact";
import type { AuditRow } from "./audit";
import type { Spend, Traffic } from "./traffic";
import type { Unusual } from "./unusual";
import type { User } from "./users";
import { createContext } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loginOf } from "./logins";
import { get } from "./session";

/** The signed-in admin's permissions (GET /admin/me), for the pages to offer only what they may do. */
export const Permissions = createContext<string[]>([]);

/** A sign-in as the admin API answers it (packages/api/src/admin.ts). */
export interface Session { "id": string; "client": string; "label": string | null; "createdAt": number; "lastUsedAt": number; "revokedAt": number | null; "current": boolean; "userId"?: string; "githubId"?: number | null }

/** What each admin API read answers, by path: the type of a page's data follows from the path it reads. */
export interface Reads {
	"/users": { "users": User[] };
	"/sessions": { "sessions": Session[] };
	"/unusual": { "sessions": Unusual[] };
	[user: `/users/${string}`]: { "user": { "githubId": number | null; "createdAt": number; "deletedAt": number | null }; "sessions": Session[]; "audit": AuditRow[] };
	[audit: `/audit?${string}`]: { "rows": AuditRow[] };
	[traffic: `/traffic?${string}`]: Traffic;
	"/spend": Spend;
}

/** A read, its result once it's here, and what went wrong if it didn't come. */
export function useRead<P extends keyof Reads>(path: P): { "data"?: Reads[P]; "error"?: string } {
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

export function Loading({ read, children }: { "read": { "data"?: unknown; "error"?: string }; "children": () => ComponentChildren }): ComponentChildren {
	if (read.error !== undefined) {
		return <wa-callout variant="danger">{read.error}</wa-callout>;
	}

	return read.data === undefined ? <wa-spinner /> : children();
}

/** A GitHub user, by login (looked up live) with their id; a user with no GitHub account signs in by email (C2), and
 *  the admin app doesn't show their address. */
export function Login({ id }: { "id": number | null }) {
	const [login, setLogin] = useState<string | undefined>();

	useEffect(() => {
		if (id !== null) {
			void loginOf(id).then(setLogin);
		}
	}, [id]);

	return id === null ? <span class="wa-color-text-quiet" title="No GitHub account: signs in by email">by email</span> : <span title={`GitHub user ${id}`}>{login ?? `#${id}`}</span>;
}

/** A moment, relative ("3 minutes ago"), with the exact time on hover. */
export function When({ at }: { "at": number | null }) {
	return at === null ? <span class="wa-color-text-quiet">never</span> : <wa-relative-time date={new Date(at).toISOString()} title={new Date(at).toLocaleString()} />;
}

export const short = (id: string | null | undefined): string => (typeof id === "string" ? `${id.slice(0, 8)}…` : "");

export function Table({ head, children }: { "head": string[]; "children": ComponentChildren }) {
	return (
		<div class="table">
			<table class="wa-zebra-rows wa-hover-rows">
				<thead><tr>{head.map((label) => <th key={label}>{label}</th>)}</tr></thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
