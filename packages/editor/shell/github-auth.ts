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
export const GITHUB_APP_INSTALL = `https://github.com/apps/${isProduction() ? PRODUCTION.app : "unusually-good-editor-dev"}/installations/new`;

/** Where the retired pasted PAT was kept, and the retired record of the repo the workspace was loaded from (the
 *  workspace's own origin says that now: `git.origin`): deleted on load, so neither outlives what replaced it. */
const RETIRED_KEYS = ["shell:githubPat", "shell:githubRepo"];

export function forgetRetired(): void {
	try {
		for (const key of RETIRED_KEYS) {
			localStorage.removeItem(key);
		}
	} catch {
		/* storage off: nothing was kept */
	}
}

/** The GitHub repository the workspace is a clone of, and the branch it's on: where a commit pushes. */
export interface RepoBinding { "owner": string; "repo": string; "branch": string }
