/**
 * Signing in — the shell's side of packages/api (its README.md and SIGN-IN.md have the design). Optional: the editor is
 * whole signed out (public repos, samples, everything local), and no account is made until someone signs in. Signing in
 * goes through the API's sign-in page (PAR, C7): GitHub, an emailed code, or a password, two-factor if they've set it
 * up. The browser never holds a GitHub token: it holds OUR tokens, DPoP-bound to a key it can't export, and reaches
 * GitHub through the API's proxy when the sign-in is GitHub's; signed in by email or a password, it calls GitHub as it
 * does signed out.
 *
 * The client itself is util/auth/client (shared with the admin app): the non-extractable DPoP key in IndexedDB, the
 * PKCE round trip (a full page: the shell is cross-origin isolated, which a popup's opener can't survive), refresh, and
 * `dpopFetch`, the AuthProvider github.ts and the clone use. This file is the editor's configuration of it (which API,
 * which pages, which storage names) and the account calls of packages/api/src/account.ts.
 *
 * Shell-side only: the key and the tokens live in the top frame's storage, and no other realm gets a client.
 */
import { createClient } from "@brianjenkins94/util/auth/client";
// The redirect URI is the site's root, a deep link's (`env/<owner>/<repo>`) too: the API knows one page per site, and the
// sign-in's `returnTo` brings us back to the deep link.
import { isProduction, PRODUCTION, site } from "./address";

/** The API (packages/api): production's on the production site, the dev deployment's everywhere else (Pages, localhost). */
export const API = isProduction() ? PRODUCTION.api : "https://editor-api-dev.brianjenkins94.workers.dev";

/** The pages the API will send a sign-in back to (the `editor` client's, packages/api/src/clients.ts): sign-in is offered only on these. */
const PAGES = [`${PRODUCTION.site}/`, "https://brianjenkins94.github.io/editor/", "http://localhost:5173/", "http://editor.localhost:5173/"];

/** Signed-out, or the session ended (revoked, or GitHub refused to refresh it): the shell shows signed-out. */
export const SIGNED_OUT = "shell:signedOut";

// The storage names predate the shared client: kept, so a browser signed in before it stays signed in.
const client = createClient({ "api": API, "clientId": "editor", "redirectUri": site, "par": true, "tokensKey": "shell:session", "pendingKey": "shell:signIn", "database": "editor-session", "signedOutEvent": SIGNED_OUT });

export const { isSignedIn, signIn, completeSignIn } = client;

/** A `fetch` for the API: our token and a proof on every request, refreshed when stale (util/auth/client). */
export const dpopFetch = client.fetch;

export function canSignIn(): boolean {
	return PAGES.includes(site());
}

// ── Your sessions and your account (packages/api/src/account.ts) ────────────────────────────────────────────────

/** Who's signed in, as the API has it (GET /account): the account packages/account shows, GitHub's id when it's a
 *  GitHub sign-in's. Read once a page; signing out forgets it (a session ended under us is signed out already). */
export interface Me { "user": string; "githubId": number | null; "email": { "address": string } | null }

let me: Promise<Me> | undefined;

export function account(): Promise<Me> {
	me ??= client.json<Me>("/account").catch((error: unknown) => {
		me = undefined;

		throw error;
	});

	return me;
}

/** Sign out here: the session ends at the API, and this browser forgets its key and who it was. */
export async function signOut(): Promise<void> {
	me = undefined;
	await client.signOut();
}

/** Whether GitHub is reached through the API's proxy: signed in, and the account is GitHub's. */
export async function viaProxy(): Promise<boolean> {
	try {
		return isSignedIn() && (await account()).githubId !== null;
	} catch {
		// The API unreachable, or down for maintenance: GitHub as signed out, public repos.
		return false;
	}
}

/** Whether the API is down for maintenance (its kill switch: packages/api/OPERATIONS.md). Asked only when it matters:
 *  signed in, or about to offer a sign-in. */
export async function apiDown(): Promise<boolean> {
	const answer = await fetch(`${API}/status`).catch(() => undefined);

	return answer?.ok === true && (await answer.json() as { "maintenance"?: boolean }).maintenance === true;
}

/** The session timeline's events (shell/reporting.ts), signed in: best effort. */
export async function postEvents(events: { "name": string; "detail"?: string; "at": number }[]): Promise<void> {
	await client.fetch(`${API}/session/events`, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "events": events }) }).catch(() => undefined);
}

/** An uncaught error, reported (shell/reporting.ts): with the sign-in when there is one, anonymously otherwise. Its id,
 *  to show the person; undefined if it couldn't be reported. */
export async function reportError(report: { "name": string; "message": string; "stack"?: string; "source": string; "release": string; "breadcrumbs": string[] }): Promise<string | undefined> {
	const send = isSignedIn() ? client.fetch : fetch;
	const answer = await send(`${API}/errors`, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify(report) }).catch(() => undefined);

	return answer?.ok === true ? (await answer.json() as { "id"?: string }).id : undefined;
}

/** The account routes, for packages/account's page: reads, and writes whose refusal it shows. */
export const accountApi = {
	"get": async <T>(path: string): Promise<T> => client.json<T>(path),
	"submit": async <T>(path: string, form: Record<string, string>): Promise<{ "ok": boolean; "status": number; "body": Partial<T> & { "reason"?: string } }> => {
		const response = await client.fetch(`${API}${path}`, { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(form) });

		return { "ok": response.ok, "status": response.status, "body": await response.json().catch(() => ({})) as Partial<T> & { "reason"?: string } };
	},
	"loginOf": async (githubId: number): Promise<string | undefined> => {
		const response = await fetch(`https://api.github.com/user/${githubId}`, { "headers": { "accept": "application/vnd.github+json" } }).catch(() => undefined);

		return response?.ok === true ? (await response.json() as { "login": string }).login : undefined;
	}
};

export interface Session { "id": string; "current": boolean; "label": string | null; "createdAt": number; "lastUsedAt": number }

/** Where you're signed in, the most recently used first; this browser's marked `current`. */
export async function sessions(): Promise<Session[]> {
	return (await client.json<{ "sessions": Session[] }>("/sessions")).sessions;
}

/** End one of your other sessions (this one's is `signOut`). */
export async function endSession(id: string): Promise<void> {
	await client.json(`/sessions/${id}/revoke`, {});
}

/** End every session you have, this one included. */
export async function signOutEverywhere(): Promise<void> {
	await client.json("/sessions/revoke-all", {});
	me = undefined;
	await client.forget();
}

/** Delete the account: at GitHub too (the app's authorization), every session, and everything that points at you. */
export async function deleteAccount(): Promise<{ "githubAuthorizationRevoked": boolean }> {
	const answer = await client.json<{ "githubAuthorizationRevoked": boolean }>("/account/delete", { "confirm": "delete" });

	me = undefined;
	await client.forget();

	return answer;
}
