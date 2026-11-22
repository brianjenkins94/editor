import type { RuntimeOptions, VirtualFS } from "@brianjenkins94/almostnode";
import type { RuntimeRequest, RuntimeResponse } from "@brianjenkins94/editor-api/runtime";
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import { drain } from "@brianjenkins94/editor-api/runtime";

export type VirtualRequest = RuntimeRequest;
export type VirtualResponse = RuntimeResponse;
interface ServerResponse { "statusCode": number; "statusMessage": string; "headers": Record<string, string>; "body": ArrayLike<number> | ReadableStream<Uint8Array> }
export interface RequestHandler {
	"handleRequest": (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<ServerResponse>;
	"serve"?: (method: string, url: string, headers: Record<string, string>, body?: Uint8Array | ReadableStream<Uint8Array>) => Promise<ServerResponse>;
}

const here = new URL(import.meta.url);
const cut = here.pathname.indexOf("/__vscode__/");

export const DEPLOY_BASE = here.origin + (cut === -1 ? "/" : here.pathname.slice(0, cut + 1));

export function workspaceRuntime(vfs: VirtualFS, options: Omit<RuntimeOptions, "base"> = {}): Runtime {
	return new Runtime(vfs, { "cwd": "/workspace", "env": {}, ...options, "base": DEPLOY_BASE });
}

const NODE_WEB_GLOBALS = ["URL", "URLSearchParams", "TextEncoder", "TextDecoder", "structuredClone", "AbortController", "AbortSignal", "atob", "btoa", "Blob", "Event", "EventTarget", "Headers", "Request", "Response", "FormData", "DOMException", "WebAssembly", "CustomEvent", "ReadableStream", "WritableStream", "TransformStream", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextDecoderStream", "TextEncoderStream", "CompressionStream", "DecompressionStream", "MessageChannel", "MessagePort", "MessageEvent", "navigator"];

export function programGlobals(runtime: Runtime): Record<string, unknown> {
	const host = globalThis as unknown as Record<string, unknown>;
	const web = Object.fromEntries(NODE_WEB_GLOBALS.filter((name) => name in host).map((name) => [name, host[name]]));

	// eslint-disable-next-line ts/naming-convention -- node's buffer module exports Buffer
	return { ...web, "Buffer": (runtime.require("buffer", "/workspace", "package") as { "Buffer": unknown }).Buffer };
}

export function serverOn(port: number): RequestHandler | undefined {
	return getServer(port) as unknown as RequestHandler | undefined;
}

export async function answerServer(server: RequestHandler, request: VirtualRequest, observed?: (direction: "request" | "reply" | "error", label: string, bytes: number) => void): Promise<VirtualResponse> {
	const { method, url, headers, body } = request;
	const [path] = url.split("?");
	const streamed = body instanceof ReadableStream;

	observed?.("request", method + " " + path, streamed ? 0 : body?.byteLength ?? 0);

	const response = server.serve === undefined ? await server.handleRequest(method, url, headers, streamed ? await drain(body) : body) : await server.serve(method, url, headers, body);

	observed?.(response.statusCode >= 400 ? "error" : "reply", String(response.statusCode) + " " + path, response.body instanceof ReadableStream ? 0 : response.body.length);

	return { "status": response.statusCode, "statusText": response.statusMessage, "headers": response.headers, "body": response.body };
}
