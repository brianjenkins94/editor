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
import { isProduction, PRODUCTION } from "./address";

/** A provider is a fetch that attaches a valid credential (or, signed out, none). */
export type AuthProvider = typeof fetch;

/** Where a signed-in user chooses the repositories the editor's GitHub App (production's, or the dev one) may reach. */
export const GITHUB_APP_INSTALL = `https://github.com/apps/${isProduction() ? PRODUCTION.app : "editor-dev-brianjenkins94"}/installations/new`;

/** Where the retired pasted PAT was kept: deleted on load, so none outlives the PAT path (session.ts replaced it). */
const PAT_KEY = "shell:githubPat";

export function forgetPat(): void {
	try {
		localStorage.removeItem(PAT_KEY);
	} catch {
		/* storage off: nothing was kept */
	}
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
