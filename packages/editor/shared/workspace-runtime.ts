/**
 * almostnode on the shared workspace, as a run has it (MODULES.md, step 4): the debug worker's (extensions/tsval/debug-worker.ts) — the
 * workspace's zen-fs, the deploy base, cwd and built-ins, the program's globals; a listening server answered one way
 * (`answerServer`, the dev-server worker's for its dev servers too). What's passed in: the fs policy, where output goes,
 * the evaluator of the program's own files and its stand-ins. tsval's privilege (EXTENSION-POINTS 2: the workspace's
 * buffer, mounted with zen-fs), with zenfs-vfs.
 *
 * And the preview's taps, which the dev-server worker puts in whatever a preview is answered — a dev server's or any
 * debugger's server (`withTap`) — so a run's server serves its pages as it wrote them.
 */
import type { RuntimeOptions, VirtualFS } from "@brianjenkins94/almostnode";
import type { RuntimeRequest, RuntimeResponse } from "@brianjenkins94/editor-api/runtime";
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import { drain } from "@brianjenkins94/editor-api/runtime";
import pageTap from "previews:page-tap";
import workerTap from "previews:worker-tap";

/** A preview's request for a port (relayed by the service worker, then the tab's root), and its answer — each body whole
 *  or a stream (editor-api's exchanges carry them in pieces). `entry`: a worker's entry script (the service worker
 *  tells: destination worker, mode same-origin). */
export type VirtualRequest = RuntimeRequest;
export type VirtualResponse = RuntimeResponse;
interface ServerResponse { "statusCode": number; "statusMessage": string; "headers": Record<string, string>; "body": ArrayLike<number> | ReadableStream<Uint8Array> }
/** What answers a port: a dev server (whole bodies), or a program's own http server (almostnode's, which also `serve`s
 *  with both bodies streamed). */
export interface RequestHandler {
	"handleRequest": (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<ServerResponse>;
	"serve"?: (method: string, url: string, headers: Record<string, string>, body?: Uint8Array | ReadableStream<Uint8Array>) => Promise<ServerResponse>;
}

/** The deploy base (this worker's served URL minus the "/__vscode__/…" tail), so a program's `file://` dynamic import
 *  resolves under the base-scoped service worker. Same computation as server-host. */
const here = new URL(import.meta.url);
const cut = here.pathname.indexOf("/__vscode__/");

export const DEPLOY_BASE = here.origin + (cut === -1 ? "/" : here.pathname.slice(0, cut + 1));

/** A runtime on `vfs` (the workspace's, createZenfsVFS): cwd `/workspace`, the deploy base, and the host's own options. */
export function workspaceRuntime(vfs: VirtualFS, options: Omit<RuntimeOptions, "base"> = {}): Runtime {
	return new Runtime(vfs, { "cwd": "/workspace", "env": {}, ...options, "base": DEPLOY_BASE });
}

/** The web's globals Node has too (a program run natively sees the worker's, which has them). */
const NODE_WEB_GLOBALS = ["URL", "URLSearchParams", "TextEncoder", "TextDecoder", "structuredClone", "AbortController", "AbortSignal", "atob", "btoa", "Blob", "Event", "EventTarget", "Headers", "Request", "Response", "FormData", "DOMException", "WebAssembly"];

/** The globals a program has on Node beyond ECMAScript's — the web's Node has, and `Buffer` (almostnode's) — for a host
 *  evaluating the program's files itself (the debug worker: tsval's own are ECMAScript's alone), so a program has the
 *  same globals however it runs (RUNNING.md). Not what varies run to run (`performance`, `crypto`): a run's clock and
 *  randomness are its event loop's. */
export function programGlobals(runtime: Runtime): Record<string, unknown> {
	const host = globalThis as unknown as Record<string, unknown>;
	const web = Object.fromEntries(NODE_WEB_GLOBALS.filter((name) => name in host).map((name) => [name, host[name]]));

	// eslint-disable-next-line ts/naming-convention -- node's buffer module exports Buffer
	return { ...web, "Buffer": (runtime.require("buffer", "/workspace", "package") as { "Buffer": unknown }).Buffer };
}

/** The program's own http server listening on `port` (almostnode's port registry), if one is. */
export function serverOn(port: number): RequestHandler | undefined {
	return getServer(port) as unknown as RequestHandler | undefined;
}

// The preview taps (page-tap.ts, worker-tap.ts — bundled to script text at build time): a server here puts one first
// in every page it serves (inline, so it runs before the app's own code — the errors thrown during the app's module
// eval are exactly the ones we'd otherwise miss) and in every worker's entry script.
/** Where a server here serves the worker tap as a module: under the preview's own address. */
export const WORKER_TAP_PATH = "/@editor/worker-tap.js";
// (Inlined in a <script>: nothing in it may close the element early.)
// eslint-disable-next-line webawesome/no-html-in-strings -- the page tap SCRIPT injected into a preview page as text, not app chrome
const PAGE_TAP_SCRIPT = "<script>" + pageTap.replaceAll("</script", "<\\/script") + "</script>";

/** A worker's entry script (`body`, served at `url`) with the worker tap put first — on its FIRST LINE, no newline added,
 *  so the script's own lines (and its inline source map) don't move: a module worker imports it (the first import runs
 *  first; a relative path, so it stays under the preview's address), a classic one evaluates it inline. After a leading
 *  "use strict" directive, which must stay the script's first statement. */
function injectWorkerTap(body: string, url: string): string {
	const isModule = /^\s*(?:import\b|export\b)/mu.test(body);
	const depth = url.split(/[?#]/u)[0].split("/").length - 2;
	const tap = isModule ? `import "./${"../".repeat(Math.max(0, depth))}${WORKER_TAP_PATH.slice(1)}";` : `(0, eval)(${JSON.stringify(workerTap)});`;
	const directive = /^\s*(["'])use strict\1;?/u.exec(body)?.[0] ?? "";

	return directive + tap + body.slice(directive.length);
}

/** Inject the observability tap as the first thing inside <head> (fallback: after <html>, else prepend). */
function injectObsTap(html: string): string {
	const headMatch = /<head[^>]*>/iu.exec(html);

	if (headMatch !== null) {
		const at = headMatch.index + headMatch[0].length;

		return html.slice(0, at) + "\n" + PAGE_TAP_SCRIPT + html.slice(at);
	}

	const htmlMatch = /<html[^>]*>/iu.exec(html);

	if (htmlMatch !== null) {
		const at = htmlMatch.index + htmlMatch[0].length;

		return html.slice(0, at) + "\n" + PAGE_TAP_SCRIPT + html.slice(at);
	}

	return PAGE_TAP_SCRIPT + html;
}

/** The worker tap, asked for as a module (injectWorkerTap imports it from a worker's entry) — undefined for any other URL. */
export function workerTapResponse(url: string): VirtualResponse | undefined {
	return url.split("?")[0] === WORKER_TAP_PATH ? { "status": 200, "statusText": "OK", "headers": { "content-type": "text/javascript", "cache-control": "no-cache" }, "body": new TextEncoder().encode(workerTap) } : undefined;
}

/** Whether `response` to `request` gets a tap — an HTML document, or a worker's entry script — and so is wanted whole. */
export function tapsInto(request: { "entry"?: VirtualRequest["entry"] }, response: { "status": number; "headers": Record<string, string> }): boolean {
	const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";

	return contentType.includes("text/html") || (request.entry !== undefined && response.status < 300 && /javascript|typescript/u.test(contentType));
}

/** `response` (its body whole) as the preview gets it: an HTML document with the page tap first in it, a worker's entry
 *  script with the worker tap — re-encoded, its content-length fixed; anything else as it was. */
export function withTap(request: { "url": string; "entry"?: VirtualRequest["entry"] }, response: { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }): VirtualResponse {
	if (!tapsInto(request, response)) {
		return response;
	}

	const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
	const text = new TextDecoder().decode(new Uint8Array(response.body));
	const bytes = new TextEncoder().encode(contentType.includes("text/html") ? injectObsTap(text) : injectWorkerTap(text, request.url));
	const headers = { ...response.headers };

	delete headers["content-length"];
	delete headers["Content-Length"];
	headers["content-length"] = String(bytes.byteLength);

	return { "status": response.status, "statusText": response.statusText, "headers": headers, "body": bytes };
}

/** `server`'s answer to `request`, as it wrote it (its body whole, or streamed). `observed` hears the request and its
 *  response (the architecture's record of the server's traffic). */
export async function answerServer(server: RequestHandler, request: VirtualRequest, observed?: (direction: "request" | "reply" | "error", label: string, bytes: number) => void): Promise<VirtualResponse> {
	const { method, url, headers, body } = request;
	const [path] = url.split("?");
	const streamed = body instanceof ReadableStream;

	observed?.("request", method + " " + path, streamed ? 0 : body?.byteLength ?? 0);

	// A program's own server streams both ways; a dev server takes and answers whole bodies.
	const response = server.serve === undefined ? await server.handleRequest(method, url, headers, streamed ? await drain(body) : body) : await server.serve(method, url, headers, body);

	observed?.(response.statusCode >= 400 ? "error" : "reply", String(response.statusCode) + " " + path, response.body instanceof ReadableStream ? 0 : response.body.length);

	return { "status": response.statusCode, "statusText": response.statusMessage, "headers": response.headers, "body": response.body };
}
