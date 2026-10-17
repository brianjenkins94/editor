/**
 * Signing in with GitHub — the shell's side of packages/api (its README.md has the design). The browser never holds a
 * GitHub token: it holds OUR tokens, DPoP-bound to a key it can't export, and reaches GitHub through the API's proxy.
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

/** The pages the API will send a sign-in back to (its REDIRECT_URIS' `editor`, wrangler.jsonc): sign-in is offered only on these. */
const PAGES = [`${PRODUCTION.site}/`, "https://brianjenkins94.github.io/editor/", "http://localhost:5173/", "http://editor.localhost:5173/"];

/** Signed-out, or the session ended (revoked, or GitHub refused to refresh it): the shell shows signed-out. */
export const SIGNED_OUT = "shell:signedOut";

// The storage names predate the shared client: kept, so a browser signed in before it stays signed in.
const client = createClient({ "api": API, "clientId": "editor", "redirectUri": site, "tokensKey": "shell:session", "pendingKey": "shell:signIn", "database": "editor-session", "signedOutEvent": SIGNED_OUT });

export const { isSignedIn, signIn, completeSignIn, signOut } = client;

/** A `fetch` for the API: our token and a proof on every request, refreshed when stale (util/auth/client). */
export const dpopFetch = client.fetch;

export function canSignIn(): boolean {
	return PAGES.includes(site());
}

// ── Your sessions and your account (packages/api/src/account.ts) ────────────────────────────────────────────────

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
	await client.forget();
}

/** Delete the account: at GitHub too (the app's authorization), every session, and everything that points at you. */
export async function deleteAccount(): Promise<{ "githubAuthorizationRevoked": boolean }> {
	const answer = await client.json<{ "githubAuthorizationRevoked": boolean }>("/account/delete", { "confirm": "delete" });

	await client.forget();

	return answer;
}
