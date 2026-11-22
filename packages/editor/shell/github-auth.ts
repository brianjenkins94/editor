import { isProduction, PRODUCTION } from "./address";

export type AuthProvider = typeof fetch;

export const GITHUB_APP_INSTALL = `https://github.com/apps/${isProduction() ? PRODUCTION.app : "unusually-good-editor-dev"}/installations/new`;

const RETIRED_KEYS = ["shell:githubPat", "shell:githubRepo"];

export function forgetRetired(): void {
	try {
		for (const key of RETIRED_KEYS) {
			localStorage.removeItem(key);
		}
	} catch {
	}
}

export interface RepoBinding { "owner": string; "repo": string; "branch": string }
