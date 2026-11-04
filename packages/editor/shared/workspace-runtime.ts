/**
 * almostnode on the shared workspace, as a run has it (packages/tsval/README.md, *Modules*): the debug worker's (extensions/tsval/debug-worker.ts) — the
 * workspace's zen-fs, the deploy base, cwd and built-ins, the program's globals; a listening server answered one way
 * (`answerServer`). What's passed in: the fs policy, where output goes,
 * the evaluator of the program's own files and its stand-ins. tsval's privilege (ARCHITECTURE.md, *Extension points* 2: the workspace's
 * buffer, mounted with zen-fs), with zenfs-vfs.
 */
import type { RuntimeOptions, VirtualFS } from "@brianjenkins94/almostnode";
import type { RuntimeRequest, RuntimeResponse } from "@brianjenkins94/editor-api/runtime";
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import { drain } from "@brianjenkins94/editor-api/runtime";

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
const NODE_WEB_GLOBALS = ["URL", "URLSearchParams", "TextEncoder", "TextDecoder", "structuredClone", "AbortController", "AbortSignal", "atob", "btoa", "Blob", "Event", "EventTarget", "Headers", "Request", "Response", "FormData", "DOMException", "WebAssembly", "CustomEvent", "ReadableStream", "WritableStream", "TransformStream", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextDecoderStream", "TextEncoderStream", "CompressionStream", "DecompressionStream", "MessageChannel", "MessagePort", "MessageEvent", "navigator"];

/** The globals a program has on Node beyond ECMAScript's — the web's Node has, and `Buffer` (almostnode's) — for a host
 *  evaluating the program's files itself (the debug worker: tsval's own are ECMAScript's alone), so a program has the
 *  same globals however it runs (RUNNING.md). Not what varies run to run (`performance`, `crypto`): a run's clock and
 *  randomness are its event loop's, which has those two itself. Nor `BroadcastChannel`, Node's being a process's and this one
 *  reaching every tab of the origin, the editor's own included. */
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
