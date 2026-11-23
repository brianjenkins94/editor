import type { RuntimeRequest, RuntimeResponse } from "@brianjenkins94/editor-api/runtime";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const NO_BODY = new Set([101, 204, 205, 304]);

export interface Local { "listening": (port: number) => boolean; "answer": (request: RuntimeRequest) => Promise<RuntimeResponse> }

export function answerLocally(input: unknown, init: RequestInit | undefined, local: Local): Promise<Response> | undefined {
	const given = input instanceof Request ? input : undefined;
	const url = new URL(given?.url ?? String(input instanceof URL ? input.href : input));

	if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname)) {
		return undefined;
	}

	const port = Number(url.port === "" ? (url.protocol === "https:" ? 443 : 80) : url.port);

	if (!local.listening(port)) {
		return undefined;
	}

	const headers = new Headers(given?.headers);

	for (const [name, value] of new Headers(init?.headers)) {
		headers.set(name, value);
	}

	return (async () => {
		const source = init?.body ?? (given === undefined || given.body === null ? undefined : await given.arrayBuffer());
		const body = source === undefined || source === null ? undefined : new Uint8Array(await new Response(source as BodyInit).arrayBuffer());
		const answered = await local.answer({ "port": port, "method": (init?.method ?? given?.method ?? "GET").toUpperCase(), "url": url.pathname + url.search, "headers": Object.fromEntries(headers), ...body === undefined ? {} : { "body": body } });
		const payload = NO_BODY.has(answered.status) ? null : answered.body instanceof ReadableStream ? answered.body : new Uint8Array(Array.from(answered.body));

		return new Response(payload, { "status": answered.status, "statusText": answered.statusText, "headers": answered.headers });
	})();
}
