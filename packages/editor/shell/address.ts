/**
 * The editor's addresses: the site's root, and `env/<owner>/<repo>` under it — the editor opened to that GitHub repo. The
 * host serves the editor's page at every `env/` path (the `_redirects` rewrite build.ts writes, Pages' 404.html), and
 * index.html puts a `<base>` at the root there, so the page and its files resolve as they do at the root.
 */

/**
 * The production site, its API, and its GitHub App (packages/api/README.md, A7). The build is one for every host, so what it
 * talks to is decided by host: production's on the production site, dev's everywhere else (Pages, localhost).
 */
export const PRODUCTION = { "site": "https://editor.unusuallygood.dev", "api": "https://api.unusuallygood.dev", "app": "unusually-good-editor" };

// `globalThis.`: the tests import the shell's GitHub modules in Node, where there's no location (and so, dev).
export const isProduction = (): boolean => globalThis.location?.origin === PRODUCTION.site;

/** The site's root: where index.html is, with no query or fragment, whatever path this page is at. */
export const site = (): string => new URL(".", document.baseURI).href;

/** The repo this address opens, if it's an `env/<owner>/<repo>` one. */
export function envRepo(): { "owner": string; "repo": string } | undefined {
	const path = location.href.startsWith(site()) ? new URL(location.href).pathname.slice(new URL(site()).pathname.length) : "";
	const match = /^env\/([^/]+)\/([^/]+?)\/?$/u.exec(path);

	return match === null ? undefined : { "owner": decodeURIComponent(match[1]), "repo": decodeURIComponent(match[2]) };
}

/**
 * Show the repo the workspace holds in the address bar (or, with none, the root), without a navigation or a history entry.
 * The query (`?debug`) and the fragment stay.
 */
export function showRepo(repo: { "owner": string; "repo": string } | undefined): void {
	const url = (repo === undefined ? site() : `${site()}env/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`) + location.search + location.hash;

	if (url !== location.href) {
		history.replaceState(history.state, "", url);
	}
}
