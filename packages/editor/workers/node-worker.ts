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
import pageScript from "previews:page-evidence";
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

type DevServer = RequestHandler & { "start": () => void; "stop": () => void; "setInstrumentation": (level: "full" | "coverage" | "off") => void; "versionSource": (oid: string) => { "file": string; "source": string } | undefined; "setHMRTarget": (target: { "postMessage": (message: unknown) => void }) => void; "setTransformErrorReporter": (report: (info: Record<string, unknown>) => void) => void; "notifyChange": (path: string) => void; "setStops": (stops: Record<string, number[]>) => string[] };

/** The dev servers started here, by port, and the folder each serves. */
const servers = new Map<number, DevServer>();
const roots = new Map<number, string>();

/** What a change under a server's folder doesn't update it for: as Vite's own watcher ignores them, so an install or a
 *  commit isn't a storm of hot updates. */
const UNWATCHED = /\/(?:\.git|node_modules|\.silo)(?:\/|$)/u;

/** A stopped dev server, by its port, until another starts there: what its pages ran is read after it stops (their last
 *  report comes as its run ends), against the versions it served (`preview.version`). */
const stopped = new Map<number, DevServer>();

/** The ports whose dev server instruments what it serves (runtime evidence: page-evidence.ts counts in the page). */
const instrumenting = new Set<number>();

/** The recorded stops (RUNNING.md: a breakpoint in a page), by file: every dev server's, a new one's from its start. */
let stops: Record<string, number[]> = {};

/** `server` (on `port`) given the recorded stops: the files whose stops changed are hot-updated, re-instrumented. */
function applyStops(port: number, server: DevServer): void {
	const root = roots.get(port);

	for (const file of server.setStops(stops)) {
		if (root !== undefined && file.startsWith(`${root}/`)) {
			server.notifyChange(file.slice(root.length));
		}
	}
}

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

		// How much of what it serves it instruments for runtime evidence (`silo.evidence.previews`, the core's to say).
		const level = await rpc.request("evidence.level", {}, { "timeoutMs": 5000, "waitForResponderMs": 5000 }).catch(() => "off") as "full" | "coverage" | "off";

		// (with the page runtime the instrumented modules tell what they observe: previews/page-script.ts)
		server.setInstrumentation(level, pageScript);

		if (level !== "off") {
			instrumenting.add(port);
		}

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
		stopped.delete(port);
		roots.set(port, root.replace(/\/+$/u, ""));
		applyStops(port, server);
		architecture.spawn({ "id": `vite:${String(port)}`, "label": `Vite dev server :${String(port)}`, "container": "workers", "detail": root, "dynamic": true });

		return { "port": port };
	});
});

// A version of a module a dev server instrumented, by its source's blob oid: what it was when it ran (the evidence of a
// version a hot update has since replaced is read against it).
serve(hub, "preview.version", (raw) => {
	const { port, oid } = raw as { "port": number; "oid": string };

	return (servers.get(port) ?? stopped.get(port))?.versionSource(oid) ?? {};
});

// The recorded stops, from the editor's breakpoints (extensions/bridge/recorded-stops.ts): every dev server's from now on.
serve(hub, "preview.stops", (raw) => {
	const { "stops": given } = (raw ?? {}) as { "stops"?: unknown };

	stops = typeof given === "object" && given !== null ? given as Record<string, number[]> : {};

	for (const [port, server] of servers) {
		applyStops(port, server);
	}

	return true;
});

serve(hub, "preview.stop", (raw) => {
	const { port } = raw as { "port": number };

	if (servers.has(port)) {
		architecture.terminate(`vite:${String(port)}`);
	}

	servers.get(port)?.stop();

	if (instrumenting.has(port) && servers.has(port)) {
		stopped.set(port, servers.get(port)!);
	}

	roots.delete(port);
	instrumenting.delete(port);

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
