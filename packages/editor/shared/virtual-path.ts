const VIRTUAL_RE = /\/__virtual__\/([^/]+)\/(\d+)(\/[^?#]*|$)/u;

export function virtualUrl(base: string, tab: string, port: number): string {
	return `${base}__virtual__/${tab}/${String(port)}/`;
}

export interface VirtualPath {
	"tab": string;
	"port": number;
	"rest": string;
	"prefix": string;
}

export function parseVirtual(pathname: string): VirtualPath | undefined {
	const match = VIRTUAL_RE.exec(pathname);

	if (match === null) {
		return undefined;
	}

	const [whole, tab, port, rest] = match as unknown as [string, string, string, string];

	return { "tab": tab, "port": Number(port), "rest": rest, "prefix": pathname.slice(0, match.index + whole.length - rest.length) };
}
