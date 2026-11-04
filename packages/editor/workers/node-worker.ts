/**
 * The dev-server worker: almostnode's in-browser Vite dev servers, off the workbench's main thread and in a global of
 * their own, on the shared workspace filesystem (the buffer arrives over the hub, `workspace.buffer`), so a dev server
 * sees exactly the files the editor, the type checker and the debugger do. Started for the first server and never stopped
 * (workbench/node-runner.ts), so its servers outlive any run.
 *
 * It answers what the service worker relays (`virtual.request`, `/__virtual__/<tab>/<port>/…`) from the dev server on that
 * port, or from a debug run that serves it (`virtual.debug.<port>`, editor-api's runtime link), or says nobody's there.
 * Every call of an exchange (a body in pieces) names its port, so each goes where its request went.
 */
import type { ExchangeCall, WireResponse } from "@brianjenkins94/editor-api/runtime";
import type { WorkspaceChange } from "../shared/workspace-changes";
import type { RequestHandler, VirtualRequest, VirtualResponse } from "../shared/workspace-runtime";
import { exchanges } from "@brianjenkins94/editor-api/runtime";
import { createHub, createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { NETWORK_PROBES } from "../shared/architecture";
import { WORKSPACE_CHANGED } from "../shared/workspace-changes";
import { answerServer } from "../shared/workspace-runtime";
import { attachSharedWorkspace, connectWorkspace, createZenfsVFS } from "../shared/zenfs-vfs.js";

/** The exact version a preview loads of each package: the editor's shared resolver's (workbench/versions.ts).
 *  (util/silo/layout's versionsPath, not imported: util/env wants a `process` this worker hasn't.) */
const VERSIONS_FILE = "/workspace/.silo/versions.json";

const hub = createHub({ "id": "node" });

hub.link(portTransport(globalThis));

const { log, architecture } = observe(hub, { "network": NETWORK_PROBES });

// (every change a dev server makes goes back as `workspace.changed`: the workbench persists and announces it)
connectWorkspace({
	"architecture": architecture,
	"onChanges": (changes: WorkspaceChange[]) => {
		hub.publish(WORKSPACE_CHANGED, changes);
	}
});

const rpc = createRpcClient(hub);
const workspaceReady = rpc.request("workspace.buffer", undefined, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 }).then(attachSharedWorkspace, (error: unknown) => {
	log.warn("no shared workspace: running on this worker's own filesystem", { "error": String(error) });
});

let vfs: ReturnType<typeof createZenfsVFS> | undefined;

type DevServer = RequestHandler & { "start": () => void; "stop": () => void; "setHMRTarget": (target: { "postMessage": (message: unknown) => void }) => void; "setTransformErrorReporter": (report: (info: Record<string, unknown>) => void) => void; "notifyChange": (path: string) => void };

/** The dev servers started here, by port, and the folder each serves. */
const servers = new Map<number, DevServer>();
const roots = new Map<number, string>();

/** What a change under a server's folder doesn't update it for: as Vite's own watcher ignores them, so an install or a
 *  commit isn't a storm of hot updates. */
const UNWATCHED = /\/(?:\.git|node_modules|\.silo)(?:\/|$)/u;

function nobody(port: number): WireResponse {
	return { "status": 503, "statusText": "Service Unavailable", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`No server listening on port ${String(port)}`) };
}

/** A request answered by the dev server on its port. */
async function answered(request: VirtualRequest): Promise<VirtualResponse> {
	const server = servers.get(request.port);

	if (server === undefined) {
		return nobody(request.port);
	}

	const node = `vite:${String(request.port)}`;

	return log.span("editor.workers.node-worker.answer", { "port": request.port, "method": request.method, "path": request.url }, async (span) => {
		const response = await answerServer(server, request, (direction, label, bytes) => {
			if (direction === "request") {
				architecture.record(architecture.self, node, "request", label, bytes);
			} else {
				architecture.record(node, architecture.self, direction, label, bytes);
			}
		});

		span.end({ "status": response.status });

		return response;
	});
}

const devServerExchanges = exchanges(answered);

serve(hub, "virtual.request", async (raw) => {
	const call = raw as ExchangeCall;
	const { port } = call;

	if (servers.has(port)) {
		return devServerExchanges(call);
	}

	// (not a dev server's: a debug run's, asked only when one serves the port — `$rpc.call.` is the hub's call prefix)
	return hub.interested(`$rpc.call.virtual.debug.${String(port)}`) ? rpc.request(`virtual.debug.${String(port)}`, call, { "timeoutMs": 60_000 }).catch(() => nobody(port)) : nobody(port);
});

serve(hub, "preview.start", async (raw): Promise<{ "port": number }> => {
	const { port, root } = raw as { "port": number; "root": string };

	return log.span("editor.workers.node-worker.start", { "port": port, "path": root }, async () => {
		await workspaceReady;

		// (dynamically: it pulls in `typescript`, its transpiler, which lands in a lazy chunk)
		const { ViteDevServer } = await import("@brianjenkins94/almostnode");
		const server = new ViteDevServer(await (vfs ??= createZenfsVFS()), { "port": port, "root": root, "versionsFile": VERSIONS_FILE }) as unknown as DevServer;

		server.start();
		// (a worker has no window to post a hot update to: it goes over the hub, for whatever shows the page)
		server.setHMRTarget({
			"postMessage": (message) => {
				architecture.record(`vite:${String(port)}`, architecture.self, "event", `hmr ${(message as { "type"?: string } | null)?.type ?? "update"}`);
				hub.publish(`preview.hmr.${String(port)}`, message);
			}
		});
		server.setTransformErrorReporter((info) => {
			log.warn("a dev server's transform failed: served 500, recovers on reload", info);
		});
		servers.set(port, server);
		roots.set(port, root.replace(/\/+$/u, ""));
		architecture.spawn({ "id": `vite:${String(port)}`, "label": `Vite dev server :${String(port)}`, "container": "workers", "detail": root, "dynamic": true });

		return { "port": port };
	});
});

serve(hub, "preview.stop", (raw) => {
	const { port } = raw as { "port": number };

	if (servers.has(port)) {
		architecture.terminate(`vite:${String(port)}`);
	}

	servers.get(port)?.stop();
	roots.delete(port);

	return servers.delete(port);
});

// A change anywhere in the workspace, however it was made (a save, a checkout, a script), arrives here: each server
// under whose folder it is re-reads it and sends its hot update (notifyChange takes a path from its root).
hub.subscribe(WORKSPACE_CHANGED, (data) => {
	for (const [port, root] of roots) {
		for (const change of data as WorkspaceChange[]) {
			if (change.path.startsWith(root + "/") && !UNWATCHED.test(change.path.slice(root.length))) {
				architecture.record(architecture.self, `vite:${String(port)}`, "event", `file ${change.type}`);
				servers.get(port)?.notifyChange(change.path.slice(root.length));
			}
		}
	}
});
