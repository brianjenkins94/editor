/**
 * A push from the workspace's git (workbench/git-engine.ts), through the API's proxy (packages/api/README.md, *The
 * proxy*). The workbench's isomorphic-git makes the requests — it has the repository — and the shell sends them, as only
 * the shell holds the sign-in (its DPoP key, session.ts): each comes over the hub as `git.remote`, for a github.com
 * repository, and goes to the proxy, which adds GitHub's token. The bytes cross; no credential does. Signed out, or
 * signed in without GitHub, there's no push, and the answer says so.
 *
 * And who a commit is by (`git.identity`): the signed-in GitHub user, with GitHub's no-reply address — what the
 * workspace's commits are authored as, so a pushed one is theirs.
 */
import type { RemoteRequest, RemoteResponse } from "../shared/git-remote";
import { API, dpopFetch, viaProxy } from "./session";

/** `https://github.com/<owner>/<repo>[.git]/<rest>` → the repository and the rest. */
const GITHUB = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(\/.*)$/u;

const NOT_SIGNED_IN = "pushing needs you signed in with GitHub (the GitHub button, top right)";

/** `git.remote`: one request of a push, sent through the proxy. */
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

/** `git.identity`: who the workspace's commits are by — null signed out. */
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
