/**
 * The live sign-ins (packages/api/README.md, "The UI"), and the table every page lists sign-ins in: who, which client and
 * device, when, and its timeline (timeline.tsx) for a role that may replay one. One write (B6): ending a sign-in, after
 * a confirm.
 */
import type { ComponentChildren } from "preact";
import type { Session } from "./ui";
import { useContext, useState } from "preact/hooks";
import { post } from "./session";
import { Loading, Login, Permissions, short, Table, useRead, When } from "./ui";

/** Columns a page adds to the sign-in table, before End: their headings, and each sign-in's cells. */
export interface Columns<S extends Session> { "head": string[]; "cells": (session: S) => ComponentChildren }

export function SessionRows<S extends Session>({ sessions, withUser, columns }: { "sessions": S[]; "withUser": boolean; "columns"?: Columns<S> }) {
	const canEnd = useContext(Permissions).includes("sessions:revoke");
	const canReplay = useContext(Permissions).includes("sessions:replay");
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
			<Table head={[...withUser ? ["GitHub"] : [], "Client", "Device", "Started", "Last used", "Ended", "Sign-in", ...columns?.head ?? [], ...canEnd ? [""] : []]}>
				{sessions.map((session) => {
					const revokedAt = session.revokedAt ?? ended[session.id] ?? null;

					return (
						<tr key={session.id}>
							{withUser && <td><a href={`#/users/${session.userId}`}><Login id={session.githubId ?? null} /></a></td>}
							<td><wa-badge variant={session.client === "admin" ? "brand" : "neutral"}>{session.client}</wa-badge></td>
							<td>{session.label ?? <span class="wa-color-text-quiet">unknown</span>}</td>
							<td><When at={session.createdAt} /></td>
							<td><When at={session.lastUsedAt} /></td>
							<td>{revokedAt === null ? <wa-badge variant="success">live</wa-badge> : <When at={revokedAt} />}</td>
							<td class="mono">{canReplay ? <a href={`#/sessions/${session.id}`} title="Its timeline">{short(session.id)}</a> : short(session.id)}</td>
							{columns?.cells(session)}
							{canEnd && <td>{session.current ? <span class="wa-color-text-quiet">this one</span> : revokedAt === null && endButton(session)}</td>}
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
			setProblem(error instanceof Error && / 404$/u.test(error.message) ? "It had already ended." : error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include ending sign-ins." : error instanceof Error && / 409$/u.test(error.message) ? "This is the tripwire's canary, not anyone's sign-in: it stays." : "Couldn't end it. Try again.");
		});
	};
	const whose = session.githubId === undefined || session.githubId === null ? "Their" : <><Login id={session.githubId} />'s</>;

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
				<p class="wa-color-text-quiet">The audit log records that you ended it.</p>
				{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			</div>
			<wa-button slot="footer" appearance="plain" data-dialog="close">Cancel</wa-button>
			<wa-button slot="footer" variant="danger" loading={busy} onClick={end}>End sign-in</wa-button>
		</wa-dialog>
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
