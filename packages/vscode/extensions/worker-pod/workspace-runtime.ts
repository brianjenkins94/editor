/**
 * almostnode on the shared workspace, set up one way for both its hosts (MODULES.md, step 4): the script worker
 * (node-worker.ts, a run) and the debug worker (debug-worker.ts, a debug run). The same filesystem — the workspace's
 * zen-fs — the same deploy base, cwd and built-ins; a listening server answered the same way, the preview's taps put in
 * what it serves. What differs is passed in: the fs policy (a run's calls asked about, a debug run's packages refused
 * writes), where output goes, and — for a debug run — the evaluator of the program's own files and its stand-ins.
 */
import type { RuntimeOptions, VirtualFS } from "@brianjenkins94/almostnode";
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import pageTap from "worker-pod:page-tap";
import workerTap from "worker-pod:worker-tap";

/** A preview's request for a port (relayed by the service worker, then the tab's root). Its body crosses as a
 *  Uint8Array (structured-clone over the worker port). */
export interface VirtualRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array; /** A worker's entry script (the service worker tells: destination worker, mode same-origin). */ "entry"?: "worker" | "sharedworker" }
export interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }
interface ServerResponse { "statusCode": number; "statusMessage": string; "headers": Record<string, string>; "body": ArrayLike<number> }
/** What answers a port: a dev server, or a program's own http server (almostnode's). */
export type RequestHandler = { "handleRequest": (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<ServerResponse> };

/** The deploy base (this worker's served URL minus the "/__vscode__/…" tail), so a program's `file://` dynamic import
 *  resolves under the base-scoped service worker. Same computation as server-host. */
const here = new URL(import.meta.url);
const cut = here.pathname.indexOf("/__vscode__/");

export const DEPLOY_BASE = here.origin + (cut === -1 ? "/" : here.pathname.slice(0, cut + 1));

/** A runtime on `vfs` (the workspace's, createZenfsVFS): cwd `/workspace`, the deploy base, and the host's own options. */
export function workspaceRuntime(vfs: VirtualFS, options: Omit<RuntimeOptions, "base"> = {}): Runtime {
	return new Runtime(vfs, { "cwd": "/workspace", "env": {}, ...options, "base": DEPLOY_BASE });
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
	const depth = url.split(/[?#]/u)[0]!.split("/").length - 2;
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

/** `server`'s answer to `request`, as the preview gets it: an HTML document with the page tap first in it, a worker's
 *  entry script with the worker tap; anything else as it was. `observed` hears the request and its response (the
 *  architecture's record of the server's traffic). */
export async function answerServer(server: RequestHandler, request: VirtualRequest, observed?: (direction: "request" | "reply" | "error", label: string, bytes: number) => void): Promise<VirtualResponse> {
	const { method, url, headers, body, entry } = request;
	const path = url.split("?")[0]!;

	observed?.("request", method + " " + path, body?.byteLength ?? 0);

	const response = await server.handleRequest(method, url, headers, body);

	observed?.(response.statusCode >= 400 ? "error" : "reply", String(response.statusCode) + " " + path, response.body.length);

	// Re-encoded, with its content-length fixed; only HTML and a worker's entry are touched.
	const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
	const rewritten = (text: string): VirtualResponse => {
		const bytes = new TextEncoder().encode(text);
		const nextHeaders = { ...response.headers };

		delete nextHeaders["content-length"];
		delete nextHeaders["Content-Length"];
		nextHeaders["content-length"] = String(bytes.byteLength);

		return { "status": response.statusCode, "statusText": response.statusMessage, "headers": nextHeaders, "body": bytes };
	};

	if (entry !== undefined && response.statusCode < 300 && /javascript|typescript/u.test(contentType)) {
		return rewritten(injectWorkerTap(new TextDecoder().decode(new Uint8Array(response.body)), url));
	}

	if (contentType.includes("text/html")) {
		return rewritten(injectObsTap(new TextDecoder().decode(new Uint8Array(response.body))));
	}

	return { "status": response.statusCode, "statusText": response.statusMessage, "headers": response.headers, "body": response.body };
}
