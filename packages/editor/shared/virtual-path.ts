/**
 * A dev server's address, built and parsed only here: `<base>/__virtual__/<tab>/<port>/<path>`, this origin. The service
 * worker answers it by calling that tab's server on `port`. Found anywhere in a path, never anchored: under Pages the
 * editor, and so every address, is below `/editor/`.
 *
 * Dependency-free: the service worker bundles it.
 */

/** An address in a path: groups `tab`, `port`, and the rest of the path (from its `/`, or empty). */
const VIRTUAL_RE = /\/__virtual__\/([^/]+)\/(\d+)(\/[^?#]*|$)/u;

/** The address of `tab`'s server on `port`, under the deploy `base` (which ends in `/`). */
export function virtualUrl(base: string, tab: string, port: number): string {
	return `${base}__virtual__/${tab}/${String(port)}/`;
}

export interface VirtualPath {
	"tab": string;
	"port": number;
	/** The path on the server (`/…`), or "" for the bare `…/<port>`. */
	"rest": string;
	/** Everything up to and including the port (`<base>/__virtual__/<tab>/<port>`), for redirects. */
	"prefix": string;
}

/** The server a path addresses, if it does. */
export function parseVirtual(pathname: string): VirtualPath | undefined {
	const match = VIRTUAL_RE.exec(pathname);

	if (match === null) {
		return undefined;
	}

	const [whole, tab, port, rest] = match as unknown as [string, string, string, string];

	return { "tab": tab, "port": Number(port), "rest": rest, "prefix": pathname.slice(0, match.index + whole.length - rest.length) };
}
