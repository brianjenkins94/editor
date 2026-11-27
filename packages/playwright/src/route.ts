/**
 * Playwright's `page.route`: a page's requests that a route's URL matches are held — by whoever drives the page, its
 * service worker in the editor — until the route's handler answers them: fulfilled with a response of its own,
 * continued to where they were going, aborted, or passed to the route before it (`fallback`). A route's URL crosses
 * to the driver (a glob, a RegExp) so only what it matches is held; a predicate's is decided here, so with one, every
 * request is.
 */

/** A route's URL as it crosses: a glob, a RegExp's source and flags, or any (a predicate's, decided by the page). */
export type RouteMatch = { "glob": string } | { "regex": { "source": string; "flags": string } } | { "any": true };

/** A request the page made, held until it's answered. Its body, base64. */
export interface Routed {
	"id": string;
	"url": string;
	"method": string;
	"headers": Record<string, string>;
	"body"?: string;
	"resourceType": string;
}

/** How a held request is answered. A fulfilled body, base64. */
export type RouteAnswer = { "continue": true } | { "abort": string } | { "fulfill": { "status": number; "headers": Record<string, string>; "body": string } };

export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

/** A glob as Playwright reads one: `**` anything, `*` anything but `/`, `{a,b}` either, `\` escapes; `?` is itself. */
export function globSource(glob: string): string {
	let source = "^";
	let inGroup = false;

	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index];

		if (character === "\\" && index + 1 < glob.length) {
			index += 1;
			source += `\\${glob[index]}`;
		} else if (character === "*") {
			const many = glob[index + 1] === "*";

			if (many) {
				index += 1;
			}

			source += many ? ".*" : "[^/]*";
		} else if (character === "{") {
			inGroup = true;
			source += "(";
		} else if (character === "}" && inGroup) {
			inGroup = false;
			source += ")";
		} else if (character === "," && inGroup) {
			source += "|";
		} else {
			source += /[$^+.()|?[\]{}/]/u.test(character) ? `\\${character}` : character;
		}
	}

	return `${source}$`;
}

/** A URL matcher as it crosses to the driver. */
export function crossing(url: UrlMatcher, base?: string): RouteMatch {
	if (typeof url === "function") {
		return { "any": true };
	}

	if (url instanceof RegExp) {
		return { "regex": { "source": url.source, "flags": url.flags } };
	}

	return { "glob": resolved(url, base) };
}

/** A glob relative to the page's base URL, as Playwright resolves one; one starting with `*` or a scheme as given. */
function resolved(glob: string, base: string | undefined): string {
	if (base === undefined || glob.startsWith("*") || /^[a-z][\w+.-]*:/iu.test(glob)) {
		return glob;
	}

	try {
		return new URL(glob, base).href;
	} catch {
		return glob;
	}
}

/** Whether a crossed matcher matches `url`: what the driver holds. */
export function matchesCrossed(match: RouteMatch, url: string): boolean {
	if ("any" in match) {
		return true;
	}

	if ("regex" in match) {
		return new RegExp(match.regex.source, match.regex.flags.replaceAll("g", "")).test(url);
	}

	return new RegExp(globSource(match.glob), "u").test(url);
}

/** Whether `url` matches, as the route's URL was given. */
export function matches(url: UrlMatcher, request: string, base?: string): boolean {
	if (typeof url === "function") {
		try {
			return url(new URL(request));
		} catch {
			return false;
		}
	}

	return matchesCrossed(crossing(url, base), request);
}

const toBase64 = (bytes: Uint8Array): string => {
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);

/** A held request, as a handler reads it (Playwright's Request). */
export class Request {
	private readonly held: Routed;

	public constructor(held: Routed) {
		this.held = held;
	}

	public url(): string {
		return this.held.url;
	}

	public method(): string {
		return this.held.method;
	}

	public headers(): Record<string, string> {
		return { ...this.held.headers };
	}

	public resourceType(): string {
		return this.held.resourceType;
	}

	public postDataBuffer(): Uint8Array | null {
		return this.held.body === undefined ? null : fromBase64(this.held.body);
	}

	public postData(): string | null {
		const bytes = this.postDataBuffer();

		return bytes === null ? null : new TextDecoder().decode(bytes);
	}

	public postDataJSON(): unknown {
		const text = this.postData();

		return text === null ? null : JSON.parse(text);
	}
}

export interface FulfillOptions {
	"status"?: number;
	"headers"?: Record<string, string>;
	"contentType"?: string;
	"body"?: string | Uint8Array;
	"json"?: unknown;
}

/** What a handler does with a held request (Playwright's Route): one answer, or `fallback` to the route before. */
export class Route {
	private outcome: RouteAnswer | "fallback" | undefined;
	private settle: (() => void) | undefined;
	/** Answered, or passed on. */
	public readonly settled = new Promise<void>((resolve) => {
		this.settle = resolve;
	});

	private readonly held: Routed;

	public constructor(held: Routed) {
		this.held = held;
	}

	public request(): Request {
		return new Request(this.held);
	}

	/** How it was answered: an answer, `fallback`, or nothing yet. */
	public answer(): RouteAnswer | "fallback" | undefined {
		return this.outcome;
	}

	private handled(outcome: RouteAnswer | "fallback"): void {
		if (this.outcome !== undefined) {
			throw new Error("Route is already handled!");
		}

		this.outcome = outcome;
		this.settle?.();
	}

	public async fulfill(options: FulfillOptions = {}): Promise<void> {
		const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
		let body: Uint8Array;

		if (options.json !== undefined) {
			body = new TextEncoder().encode(JSON.stringify(options.json));
			headers["content-type"] ??= "application/json";
		} else {
			body = typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body ?? new Uint8Array();
		}

		if (options.contentType !== undefined) {
			headers["content-type"] = options.contentType;
		}

		this.handled({ "fulfill": { "status": options.status ?? 200, "headers": headers, "body": toBase64(body) } });
	}

	public async continue(overrides?: Record<string, unknown>): Promise<void> {
		if (overrides !== undefined && Object.keys(overrides).length > 0) {
			throw new Error("route.continue: changing the request (url, method, headers, postData) isn't here: fulfill it instead");
		}

		this.handled({ "continue": true });
	}

	public async abort(errorCode = "failed"): Promise<void> {
		this.handled({ "abort": errorCode });
	}

	public async fallback(overrides?: Record<string, unknown>): Promise<void> {
		if (overrides !== undefined && Object.keys(overrides).length > 0) {
			throw new Error("route.fallback: changing the request isn't here");
		}

		this.handled("fallback");
	}
}

export interface RouteEntry {
	"url": UrlMatcher;
	"handler": (route: Route, request: Request) => unknown;
	/** How many more requests it handles (`times`), or for ever. */
	"left": number;
}

/**
 * A held request handled by the page's routes, the newest first, as Playwright's: each matching handler until one
 * answers rather than falls back; none left, it goes where it was going. A handler that throws aborts it.
 */
export async function handle(routes: RouteEntry[], held: Routed, base?: string): Promise<RouteAnswer> {
	for (const entry of routes.toReversed()) {
		if (entry.left <= 0 || !matches(entry.url, held.url, base)) {
			continue;
		}

		const route = new Route(held);

		entry.left -= 1;

		try {
			await Promise.all([entry.handler(route, route.request()), route.settled]);
		} catch (error) {
			if (route.answer() === undefined) {
				return { "abort": `the route's handler threw: ${error instanceof Error ? error.message : String(error)}` };
			}
		}

		const answer = route.answer();

		if (answer !== "fallback" && answer !== undefined) {
			return answer;
		}
	}

	return { "continue": true };
}
