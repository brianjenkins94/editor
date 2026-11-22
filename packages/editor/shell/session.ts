import { createClient } from "@brianjenkins94/util/auth/client";
import { isProduction, PRODUCTION, site } from "./address";

export const API = isProduction() ? PRODUCTION.api : "https://editor-api-dev.brianjenkins94.workers.dev";

const PAGES = [`${PRODUCTION.site}/`, "https://brianjenkins94.github.io/editor/", "http://localhost:5173/", "http://editor.localhost:5173/"];

export const SIGNED_OUT = "shell:signedOut";

const client = createClient({ "api": API, "clientId": "editor", "redirectUri": site, "par": true, "tokensKey": "shell:session", "pendingKey": "shell:signIn", "database": "editor-session", "signedOutEvent": SIGNED_OUT });

export const { isSignedIn, signIn, completeSignIn } = client;

export const dpopFetch = client.fetch;

export function canSignIn(): boolean {
	return PAGES.includes(site());
}

export interface Me { "user": string; "githubId": number | null; "email": { "address": string } | null }

let me: Promise<Me> | undefined;

export function account(): Promise<Me> {
	me ??= client.json<Me>("/account").catch((error: unknown) => {
		me = undefined;

		throw error;
	});

	return me;
}

export async function signOut(): Promise<void> {
	me = undefined;
	await client.signOut();
}

async function status(): Promise<{ "maintenance": boolean; "paused": string[] }> {
	const answer = await fetch(`${API}/status`).catch(() => undefined);
	const read = answer?.ok === true ? await answer.json().catch(() => ({})) as { "maintenance"?: boolean; "paused"?: string[] } : {};

	return { "maintenance": read.maintenance === true, "paused": Array.isArray(read.paused) ? read.paused : [] };
}

export async function viaProxy(): Promise<boolean> {
	try {
		return isSignedIn() && (await account()).githubId !== null && !(await status()).paused.includes("github-proxy");
	} catch {
		return false;
	}
}

export async function apiDown(): Promise<boolean> {
	return (await status()).maintenance;
}

export async function postEvents(events: { "name": string; "detail"?: string; "at": number }[]): Promise<void> {
	await client.fetch(`${API}/session/events`, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify({ "events": events }) }).catch(() => undefined);
}

export async function reportError(report: { "name": string; "message": string; "stack"?: string; "source": string; "release": string; "breadcrumbs": string[] }): Promise<string | undefined> {
	const send = isSignedIn() ? client.fetch : fetch;
	const answer = await send(`${API}/errors`, { "method": "POST", "headers": { "content-type": "application/json" }, "body": JSON.stringify(report) }).catch(() => undefined);

	return answer?.ok === true ? (await answer.json() as { "id"?: string }).id : undefined;
}

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

export async function sessions(): Promise<Session[]> {
	return (await client.json<{ "sessions": Session[] }>("/sessions")).sessions;
}

export async function endSession(id: string): Promise<void> {
	await client.json(`/sessions/${id}/revoke`, {});
}

export async function signOutEverywhere(): Promise<void> {
	await client.json("/sessions/revoke-all", {});
	me = undefined;
	await client.forget();
}

export async function deleteAccount(): Promise<{ "githubAuthorizationRevoked": boolean }> {
	const answer = await client.json<{ "githubAuthorizationRevoked": boolean }>("/account/delete", { "confirm": "delete" });

	me = undefined;
	await client.forget();

	return answer;
}
