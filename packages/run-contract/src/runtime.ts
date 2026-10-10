/**
 * The workspace runtime, as a debugger reaches it (EXTENSION-POINTS.md, 2): the workspace's own files, read and written
 * synchronously as a program's `require` and `readFileSync` need them, and the preview's requests to a server the
 * program starts. Any debugger may have it — tsval's, and an interpreter plugged in as `run.debugger`.
 *
 * - The extension asks worker-pod for it: `(await vscode.extensions.getExtension("brianjenkins94.worker-pod")
 *   .activate()).workspaceRuntime()` — a `WorkspaceRuntime`. Its `buffer` is the workspace (zen-fs's SingleBuffer over a
 *   SharedArrayBuffer — absent without cross-origin isolation); `connect()` gives a port into the editor's runtime, for
 *   the debugger's worker.
 * - The worker connects with `connectRuntime(port, { "name": … })` and answers the preview for a port its program
 *   listens on with `serve(port, request => response)`. Its log, its spans and each server's traffic are the editor's
 *   to see, as its own (debug-mcp, the architecture view).
 *
 * The extension's own code never joins the editor's hub: only its worker's runtime link does, through this.
 */
import type { Observed, ObserveOptions } from "@brianjenkins94/observability";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";

/** What worker-pod's `workspaceRuntime()` gives a debugger's extension. */
export interface WorkspaceRuntime {
	/** The workspace, for the worker to mount at /workspace — absent without cross-origin isolation. */
	readonly "buffer": SharedArrayBuffer | undefined;
	/** A port into the editor's runtime, for one worker (transfer it there, and `connectRuntime` it); `dispose` when the
	 *  worker's gone. */
	"connect": () => { "port": MessagePort; "dispose": () => void };
}

/** A request the preview makes of a server the program listens with, on `port`. `entry`: a worker's entry script. */
export interface RuntimeRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array; "entry"?: "worker" | "sharedworker" }

/** The server's answer. */
export interface RuntimeResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }

/** A worker's link into the editor's runtime. */
export interface RuntimeConnection {
	/** Answer the preview's requests to `port` with `handler` until the returned disposer runs. */
	"serve": (port: number, handler: (request: RuntimeRequest) => Promise<RuntimeResponse>) => () => void;
	/** The worker's logger: its records and spans are the editor's, as this worker's. */
	"log": Observed["log"];
}

/** Connect a debugger's worker to the editor's runtime through `port` (`WorkspaceRuntime.connect()`'s), as `name` — what
 *  the editor knows it by. `network`: probes for the worker's own requests, as observability's `observe` takes them. */
export function connectRuntime(port: MessagePort, { name, network = false }: { "name": string; "network"?: ObserveOptions["network"] }): RuntimeConnection {
	const hub = createHub({ "id": name });

	hub.link(portTransport(port));

	const { log, architecture } = observe(hub, { "network": network });

	// (a membership line in worker-pod's log, once it's listening)
	void hub.whenInterested("pod.ready", 30_000).then((wanted) => {
		if (wanted) {
			hub.publish("pod.ready", { "worker": hub.id });
		}
	});

	return {
		"log": log,
		"serve": (listening, handler) => serve(hub, `virtual.debug.${listening}`, async (raw) => {
			const request = raw as RuntimeRequest;
			const path = request.url.split("?")[0]!;

			// Each server's traffic, as its own: the architecture view's `server:<port>`.
			architecture.record(architecture.self, `server:${listening}`, "request", `${request.method} ${path}`, request.body?.byteLength ?? 0);

			const response = await handler(request);

			architecture.record(`server:${listening}`, architecture.self, response.status >= 400 ? "error" : "reply", `${response.status} ${path}`, response.body.length);

			return response;
		})
	};
}
