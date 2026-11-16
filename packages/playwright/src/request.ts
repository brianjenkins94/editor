/**
 * Playwright's APIRequestContext (`page.request`, the `request` fixture) and APIResponse: a test's own HTTP requests, as a
 * client makes them — not the page's, nor the program's — over its driver's `fetch`, which makes them where the page's
 * origin is (the shell, for a test in the debugger: a preview's server answered through the service worker, as any client
 * of it is). What's here: `fetch`, `get`, `post`, `put`, `patch`, `delete`, `head`, with `headers`, `params`, `data`,
 * `method` and `failOnStatusCode`; the response's `status`, `statusText`, `ok`, `url`, `headers`, `headersArray`, `text`,
 * `json`, `body`. Not here: `form`, `multipart`, `maxRedirects`, `storageState`, a context of its own (`request.newContext`).
 */

/** A request as it crosses to where it's made: its body as base64, so bytes cross as they are. */
export interface FetchInit { "method": string; "headers": Record<string, string>; "body"?: string }

/** A response as it crosses back: its headers in order, its body as base64. */
export interface Fetched { "url": string; "status": number; "statusText": string; "headers": [string, string][]; "body": string }

/** Playwright's options for a request (the ones here). */
export interface RequestOptions {
	"method"?: string;
	"headers"?: Record<string, string>;
	"params"?: Record<string, string | number | boolean> | URLSearchParams | string;
	"data"?: string | Uint8Array | ArrayBuffer | Record<string, unknown> | unknown[];
	"failOnStatusCode"?: boolean;
	"form"?: unknown;
	"multipart"?: unknown;
}

const toBase64 = (bytes: Uint8Array): string => {
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.codePointAt(0)!);

/** A fetch's response, made from where it ran: a page's window, or this realm. */
export async function fetched(response: Response): Promise<Fetched> {
	return { "url": response.url, "status": response.status, "statusText": response.statusText, "headers": [...response.headers], "body": toBase64(new Uint8Array(await response.arrayBuffer())) };
}

/** Playwright's APIResponse. */
export class APIResponse {
	private readonly answer: Fetched;

	public constructor(answer: Fetched) {
		this.answer = answer;
	}

	public status(): number {
		return this.answer.status;
	}

	public statusText(): string {
		return this.answer.statusText;
	}

	public ok(): boolean {
		return this.answer.status >= 200 && this.answer.status <= 299;
	}

	public url(): string {
		return this.answer.url;
	}

	/** Each header by its lowercase name (several of one name joined, as Playwright's are). */
	public headers(): Record<string, string> {
		const headers: Record<string, string> = {};

		for (const [name, value] of this.answer.headers) {
			const key = name.toLowerCase();

			headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
		}

		return headers;
	}

	public headersArray(): { "name": string; "value": string }[] {
		return this.answer.headers.map(([name, value]) => ({ "name": name, "value": value }));
	}

	/** Its bytes (a Buffer where there is one, as Playwright's are). */
	public async body(): Promise<Uint8Array> {
		const bytes = fromBase64(this.answer.body);
		const buffer = (globalThis as { "Buffer"?: { "from": (bytes: Uint8Array) => Uint8Array } }).Buffer;

		return buffer === undefined ? bytes : buffer.from(bytes);
	}

	public async text(): Promise<string> {
		return new TextDecoder().decode(fromBase64(this.answer.body));
	}

	public async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}

	/** Nothing to let go: the body came whole. */
	public async dispose(): Promise<void> {
		// (Playwright's frees what the browser holds; here it's already ours)
	}
}

/** Playwright's APIRequestContext, over `make` (a driver's `fetch`), relative addresses from `base` (the page's address). */
export class APIRequestContext {
	private readonly make: (url: string, init: FetchInit) => Promise<Fetched>;
	private readonly base: () => Promise<string>;

	public constructor(make: (url: string, init: FetchInit) => Promise<Fetched>, base: () => Promise<string>) {
		this.make = make;
		this.base = base;
	}

	public async fetch(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		if (options.form !== undefined || options.multipart !== undefined) {
			throw new Error("request: `form` and `multipart` aren't here — send `data` (a string, bytes, or JSON) with its content-type");
		}

		const base = await this.base();
		const address = new URL(url, base === "" || base === "about:blank" ? undefined : base);

		if (options.params !== undefined) {
			const params = typeof options.params === "string" || options.params instanceof URLSearchParams
				? new URLSearchParams(options.params)
				: new URLSearchParams(Object.entries(options.params).map(([name, value]) => [name, String(value)]));

			for (const [name, value] of params) {
				address.searchParams.append(name, value);
			}
		}

		const headers = { ...options.headers };
		const named = (name: string): boolean => Object.keys(headers).some((key) => key.toLowerCase() === name);
		let body: string | undefined;
		const { data } = options;

		// (as Playwright's: an object or array sent as JSON, anything else as it is, octet-stream unless it's said otherwise)
		if (data !== undefined) {
			const json = typeof data !== "string" && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer);

			body = toBase64(typeof data === "string" || json ? new TextEncoder().encode(json ? JSON.stringify(data) : data as string) : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));

			if (!named("content-type")) {
				headers["content-type"] = json ? "application/json" : "application/octet-stream";
			}
		}

		const method = (options.method ?? "GET").toUpperCase();
		const response = new APIResponse(await this.make(address.href, { "method": method, "headers": headers, ...body === undefined ? {} : { "body": body } }));

		if (options.failOnStatusCode === true && !response.ok()) {
			throw new Error(`request.${method.toLowerCase()}: ${String(response.status())} ${response.statusText()} from ${address.href}`);
		}

		return response;
	}

	public async get(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "GET" });
	}

	public async head(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "HEAD" });
	}

	public async post(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "POST" });
	}

	public async put(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "PUT" });
	}

	public async patch(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "PATCH" });
	}

	public async delete(url: string, options: RequestOptions = {}): Promise<APIResponse> {
		return this.fetch(url, { ...options, "method": "DELETE" });
	}

	/** Nothing to let go. */
	public async dispose(): Promise<void> {
		// (Playwright's closes its own connections; these are the driver's)
	}
}

/** How a FetchInit is made into a fetch's: its body back to bytes. */
export function requestInit(init: FetchInit): RequestInit {
	return { "method": init.method, "headers": init.headers, ...init.body === undefined ? {} : { "body": fromBase64(init.body) as BodyInit } };
}
