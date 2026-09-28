/**
 * The auth-provider seam — the ONE layer between "who am I to GitHub" and everything that talks to GitHub.
 *
 * A provider is nothing more than a `fetch` that guarantees a valid `Authorization: Bearer`. That's the whole
 * contract, and it's the shape the problem forces regardless of library: `@octokit/*` calls it an `authStrategy`,
 * `@badgateway/oauth2-client` ships `OAuth2Fetch` (which already IS such a fetch), and `fido` consumes it as its
 * `fetch` option. So the PAT→App swap later (see the deferred `appProvider` note) is a one-liner — github.ts
 * downstream only ever knows "a fetch".
 *
 * Lives SHELL-side on purpose: the token stays in the top frame. The workbench iframe and any (sandboxed) game
 * iframe never receive a GitHub client — they traffic in files (zen-fs), not tokens.
 */

/** A provider is a fetch that attaches a valid credential. Both `PastedPAT` and the future `AppOAuth` are this. */
export type AuthProvider = typeof fetch;

const PAT_KEY = "shell:githubPat";

/** The stored PAT, or undefined. localStorage can throw (private mode) — treated as "no token". */
export function getPat(): string | undefined {
	try {
		return localStorage.getItem(PAT_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Store (or, with undefined, clear) the PAT. Never echoed back through any channel. */
export function setPat(token: string | undefined): void {
	try {
		if (token !== undefined && token !== "") {
			localStorage.setItem(PAT_KEY, token);
		} else {
			localStorage.removeItem(PAT_KEY);
		}
	} catch {
		/* private mode / storage disabled — the token just isn't persisted */
	}
}

export function hasPat(): boolean {
	return getPat() !== undefined;
}

const REPO_KEY = "shell:githubRepo";

/** The repo the workspace was loaded from — so a commit knows where to push. */
export interface RepoBinding { "owner": string; "repo": string; "branch": string }

export function getRepoBinding(): RepoBinding | undefined {
	try {
		const raw = localStorage.getItem(REPO_KEY);

		return raw !== null ? JSON.parse(raw) as RepoBinding : undefined;
	} catch {
		return undefined;
	}
}

export function setRepoBinding(binding: RepoBinding | undefined): void {
	try {
		if (binding !== undefined) {
			localStorage.setItem(REPO_KEY, JSON.stringify(binding));
		} else {
			localStorage.removeItem(REPO_KEY);
		}
	} catch {
		/* private mode / storage disabled */
	}
}

/**
 * The PAT provider (you, now). Resolves the token FRESH on every request via `getToken`, so changing the stored
 * PAT takes effect without rebuilding the GitHub client — this is the "hand out tokens, don't read storage once"
 * discipline that keeps the App's refresh from breaking the data layer later.
 *
 * No refresh: a 401 means the PAT is bad or expired, which callers surface as "re-enter your token" rather than
 * retrying. An explicit `Authorization` already on the request is left untouched.
 */
export function patProvider(getToken: () => string | undefined = getPat): AuthProvider {
	return async (input, init = {}) => {
		const headers = new Headers(init.headers);
		const token = getToken();

		if (token !== undefined && !headers.has("Authorization")) {
			headers.set("Authorization", "Bearer " + token);
		}

		return fetch(input, { ...init, "headers": headers });
	};
}

// appProvider (kids, later) — the ONLY thing that changes for the "proper app". The Worker holds the client
// secret and does the code↔token exchange; badgateway does refresh; the result is still just a fetch handed to
// github.ts unchanged:
//
//   import { OAuth2Client, OAuth2Fetch } from "@badgateway/oauth2-client";
//   const client = new OAuth2Client({ "server": "https://github.com", "clientId": APP_CLIENT_ID, "tokenEndpoint": WORKER_URL + "/token" });
//   const oauth = new OAuth2Fetch({ client, getStoredToken, storeToken, onError });
//   export const appProvider: AuthProvider = oauth.fetch.bind(oauth);
