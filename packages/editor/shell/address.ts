export const PRODUCTION = { "site": "https://editor.unusuallygood.dev", "api": "https://api.unusuallygood.dev", "app": "unusually-good-editor" };

export const isProduction = (): boolean => globalThis.location?.origin === PRODUCTION.site;

export const site = (): string => new URL(".", document.baseURI).href;

export function envRepo(): { "owner": string; "repo": string } | undefined {
	const path = location.href.startsWith(site()) ? new URL(location.href).pathname.slice(new URL(site()).pathname.length) : "";
	const match = /^env\/([^/]+)\/([^/]+?)\/?$/u.exec(path);

	return match === null ? undefined : { "owner": decodeURIComponent(match[1]), "repo": decodeURIComponent(match[2]) };
}

export function showRepo(repo: { "owner": string; "repo": string } | undefined): void {
	const url = (repo === undefined ? site() : `${site()}env/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`) + location.search + location.hash;

	if (url !== location.href) {
		history.replaceState(history.state, "", url);
	}
}
