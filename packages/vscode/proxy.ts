/**
 * `__proxy__` — a same-origin CDN proxy convention (the editor's cousin of almostnode's `__virtual__`).
 *
 * The node_modules overlay (node-modules-provider.ts) fetches full package source from unpkg for
 * go-to-definition into real dependency source. That fetch is cross-origin, and under the cross-origin
 * isolation Pages needs it's fragile: unpkg's unversioned 302s carry no CORS header, and every request
 * is re-fetched by the COI service worker. Routing it through a same-origin `__proxy__` URL sidesteps all
 * of that — the page fetches `<dir>/__proxy__/<host>/<path>` (same origin, no COEP concern), and the
 * server side (the SW in prod, a vite middleware in dev) fetches the real CDN URL and hands it back as a
 * same-origin resource. Crucially the SW's own fetch isn't bound by the document's COEP and follows
 * redirects internally, so the unversioned-302 problem disappears.
 *
 * Unlike `__virtual__`, which is a scattered string literal across almostnode, this convention is one
 * exported constant. The matchers deliberately use `indexOf` (not an anchored regex) so a proxy URL is
 * recognised under ANY prefix — the deploy base subpath AND the `/__vscode__/` iframe mount it's built
 * relative to. The plain-JS service worker (public/coi-serviceworker.js) can't import this module, so it
 * inlines the same segment + reconstruction logic with a pointer back here — keep the two in sync.
 */

/** The path segment marking a same-origin proxy request: `…/__proxy__/<host>/<path>`. */
export const PROXY_SEGMENT = "__proxy__";

/**
 * Rewrite an absolute cross-origin URL to a same-origin proxy URL, resolved against `at` (the page/iframe
 * location). `https://unpkg.com/preact@10/x.js?meta` → `<at-dir>/__proxy__/unpkg.com/preact@10/x.js?meta`.
 * The protocol is dropped (always restored as https on the way back — CDNs are https), so only host +
 * path + query travel.
 */
export function toProxyUrl(realUrl: string, at: { "href": string }): string {
	const parsed = new URL(realUrl);
	const rest = parsed.host + parsed.pathname + parsed.search;

	return new URL(PROXY_SEGMENT + "/" + rest, at.href).href;
}

/**
 * Reverse of {@link toProxyUrl}: given a request path (pathname + optional query), return the real https
 * URL it proxies, or undefined if it isn't a proxy path. Used by the dev middleware; the SW mirrors this.
 */
export function fromProxyPath(pathAndQuery: string): string | undefined {
	const marker = "/" + PROXY_SEGMENT + "/";
	const index = pathAndQuery.indexOf(marker);

	if (index === -1) {
		return undefined;
	}

	return "https://" + pathAndQuery.slice(index + marker.length);
}
