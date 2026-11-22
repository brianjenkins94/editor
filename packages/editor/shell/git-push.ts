import type { RemoteRequest, RemoteResponse } from "../shared/git-remote";
import { API, dpopFetch, viaProxy } from "./session";

const GITHUB = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(\/.*)$/u;

const NOT_SIGNED_IN = "pushing needs you signed in with GitHub (the GitHub button, top right)";

export async function remote(request: RemoteRequest): Promise<RemoteResponse> {
	const { url, method, headers, body } = request;
	const match = GITHUB.exec(url);

	if (match === null) {
		throw new Error(`a push goes to a github.com repository, not ${url}`);
	}

	if (!await viaProxy()) {
		throw new Error(NOT_SIGNED_IN);
	}

	const response = await dpopFetch(`${API}/github/git/${match[1]}.git${match[2]}`, { "method": method, "headers": headers, ...body === undefined || body.length === 0 ? {} : { "body": new Uint8Array(body) } });

	return { "status": response.status, "statusText": response.statusText, "headers": Object.fromEntries(response.headers), "body": new Uint8Array(await response.arrayBuffer()) };
}

let known: Promise<{ "name": string; "email": string }> | undefined;

export async function identity(): Promise<{ "name": string; "email": string } | null> {
	if (!await viaProxy()) {
		known = undefined;

		return null;
	}

	known ??= (async () => {
		const { connectGitHub } = await import("./github");
		const user = await (await connectGitHub()).viewer() as { "login": string; "id": number; "name"?: string | null };

		return { "name": user.name ?? user.login, "email": `${user.id}+${user.login}@users.noreply.github.com` };
	})().catch((error: unknown) => {
		known = undefined;

		throw error;
	});

	return known;
}
