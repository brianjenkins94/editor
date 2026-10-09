/**
 * The two formats a preview is known by — built and parsed only here:
 *
 * - **Its address:** `<base>/__virtual__/<tab>/<port>/<path>`, this origin. The service worker answers it by calling
 *   that tab's dev server for `port`. Found ANYWHERE in a path, never anchored: under Pages the editor (and so every
 *   preview) is served below `/editor/`.
 * - **Its window's id:** `preview:<port>` for a server's first window, `preview:<port>~<n>` for its n-th — the shell's
 *   name for a window, and the scope its app's hubs are filed under (`preview:<port>/<hub>`; architecture-model's
 *   isAppNode reads that shape and stays import-free for its node tests).
 *
 * Dependency-free: the service worker bundles it, and the preview's injected taps interpolate VIRTUAL_RE's source.
 */

export const VIRTUAL_MARKER = "/__virtual__/";

/** A preview address in a path: groups `tab`, `port`, and the rest of the path (from its `/`, or empty). */
export const VIRTUAL_RE = /\/__virtual__\/([^/]+)\/(\d+)(\/[^?#]*|$)/u;

/** The address of `tab`'s server on `port`, under the deploy `base` (which ends in `/`). */
export function virtualUrl(base: string, tab: string, port: number): string {
	return base + VIRTUAL_MARKER.slice(1) + tab + "/" + port + "/";
}

export interface VirtualPath {
	"tab": string;
	"port": number;
	/** The path on the dev server (`/…`), or "" for the bare `…/<port>`. */
	"rest": string;
	/** Everything up to and including the port (`<base>/__virtual__/<tab>/<port>`), for redirects. */
	"prefix": string;
}

/** The preview a path addresses, if it does. */
export function parseVirtual(pathname: string): VirtualPath | undefined {
	const match = VIRTUAL_RE.exec(pathname);

	if (match === null) {
		return undefined;
	}

	const [whole, tab, port, rest] = match as unknown as [string, string, string, string];

	return { "tab": tab, "port": Number(port), "rest": rest, "prefix": pathname.slice(0, match.index + whole.length - rest.length) };
}

/** A page of a server this editor runs: an address of this origin under a preview address. */
export function previewPageOf(url: string): { "url": string; "port": number } | undefined {
	try {
		const parsed = new URL(url, location.href);
		const virtual = parsed.origin === location.origin ? parseVirtual(parsed.pathname) : undefined;

		return virtual === undefined ? undefined : { "url": parsed.href, "port": virtual.port };
	} catch {
		return undefined;
	}
}

export const PREVIEW_WINDOW_PREFIX = "preview:";

/** Marks the window hosting the preview windows (the shell: `window[PREVIEW_HOST_MARK] === true`) — a preview's tap
 *  links to it, wherever above the preview's frame it is (its parent in the dock, further up in a VS Code editor). */
export const PREVIEW_HOST_MARK = "__previewHost";

/** A worker's preview window, in its URL's hash (`#preview-window=<id>`): set by its page's tap as it starts it (the
 *  page knows its window from its frame's name), read by the worker's tap — so its logs and capability requests go to
 *  the window it runs in. */
export const WINDOW_PARAM = "preview-window";

/** The id of `port`'s `index`-th preview window (counted from 1) — no dots: ids become subject tokens (`$sys.log.<id>`). */
export function windowId(port: number, index: number): string {
	return PREVIEW_WINDOW_PREFIX + port + (index === 1 ? "" : "~" + index);
}

/** `preview:5173` → "Preview :5173"; `preview:5173~2` → "Preview :5173 (2)". */
export function windowTitle(id: string): string {
	const [port, index] = id.slice(PREVIEW_WINDOW_PREFIX.length).split("~");

	return "Preview :" + port + (index === undefined ? "" : " (" + index + ")");
}
