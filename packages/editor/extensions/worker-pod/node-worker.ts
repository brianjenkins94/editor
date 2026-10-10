/**
 * The dev-server worker — almostnode's preview dev servers, off the workbench main thread and in their own globalThis:
 * started for the first preview, never stopped, so its servers outlive any run. It answers the service worker's
 * preview requests (`/__virtual__/<tab>/<port>/…`) from a dev server here, or relays them to a debug run that serves the
 * port (extensions/tsval/debug-worker.ts). (Programs run in the debugger, always — RUNNING.md; there's no plain-runtime script runner.)
 *
 * Same almostnode-on-zen-fs pattern as the debug worker: it runs on the SHARED workspace zen-fs (the SAB arrives over the
 * hub, `workspace.buffer`), so a dev server sees exactly the files the editor, type-checker and debugger see — one
 * filesystem — and every change it makes is reported back as `workspace.changed` (persisted + announced by the
 * workbench; see workspace-changes.ts).
 */
import { createHub, createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { installWorkerProbe, observe } from "@brianjenkins94/observability";

import { NETWORK_PROBES } from "../../architecture";
import { identifyWorker } from "../../architecture-model";
import { ZENFS_NODE } from "../../architecture-zenfs";
import type { WorkspaceChange } from "../../workspace-changes";
import { WORKSPACE_CHANGED } from "../../workspace-changes";

import type { RequestHandler, VirtualRequest, VirtualResponse } from "./workspace-runtime";
import { answerServer, workerTapResponse } from "./workspace-runtime";
import { attachSharedWorkspace, connectWorkspace, createZenfsVFS, getSharedWorkspaceBuffer } from "./zenfs-vfs.js";

const hub = createHub({ "id": "node" });

hub.link(portTransport(globalThis));
// Its logs, its uncaught errors, and its hub + own requests on $sys.arch — plus its workspace mount and the workers it
// spawns (the provoke child).
const { log, architecture } = observe(hub, { "network": NETWORK_PROBES });

installWorkerProbe(architecture, identifyWorker);

// The workspace: the shared buffer comes from the workbench over the hub, and every change this worker makes to it
// (a dev server's writes, an install) goes back as `workspace.changed` — the workbench persists and announces it.
connectWorkspace({ "architecture": architecture, "onChanges": (changes) => { hub.publish(WORKSPACE_CHANGED, changes); } });
const rpc = createRpcClient(hub);
const workspaceReady = rpc.request("workspace.buffer", undefined, { "timeoutMs": 10000, "waitForResponderMs": 10000 })
	.then(attachSharedWorkspace, (error: unknown) => { log.warn("no shared workspace — running on this worker's own filesystem", { "error": String(error) }); });

let vfsPromise: ReturnType<typeof createZenfsVFS> | undefined;
const getVfs = (): ReturnType<typeof createZenfsVFS> => (vfsPromise ??= workspaceReady.then(createZenfsVFS));


// Preview bridge relay (M0): the service worker's `/__virtual__/<tab>/<port>/…` request arrives here (relayed by
// the tab's root); we drive the dev server on that port (M1, below) and return its response — or relay it to a debug run
// serving the port. Body crosses as a Uint8Array (structured-clone over the worker port).
type PreviewServer = RequestHandler & { "start": () => void; "setInstrumentation": (level: "full" | "coverage" | "off") => void; "versionSource": (oid: string) => { "file": string; "source": string } | undefined; "setHMRTarget": (target: { "postMessage": (message: unknown, origin?: string) => void }) => void; "setTransformErrorReporter": (reporter: (info: { "url": string; "name": string; "message": string; "stack"?: string }) => void) => void; "notifyChange": (path: string) => void; "setStops": (stops: Record<string, number[]>) => string[]; "stop": () => void };


// Dev servers started in this worker (M1), keyed by their virtual port — checked before the raw http registry —
// and the workspace root each serves.
const previewServers = new Map<number, PreviewServer>();
const previewRoots = new Map<number, string>();
/** The recorded stops (RUNNING.md: a breakpoint in a page), by file: every dev server's, a new one's from its start. */
let previewStops: Record<string, number[]> = {};

/** `server` (on `port`) given the recorded stops; the files whose stops changed hot-updated, re-instrumented. */
function applyStops(port: number, server: PreviewServer): void {
	const root = previewRoots.get(port);

	for (const file of server.setStops(previewStops)) {
		if (root !== undefined && file.startsWith(root + "/")) {
			server.notifyChange(file.slice(root.length));
		}
	}
}

// The last preview.start config, so preview.provoke (the debug affordance below) can cold-restart on the same
// port/root without the caller having to know them.
let lastPreviewConfig: { "port": number; "root": string } | undefined;

/** A 503 for a port nobody here listens on. */
function notListening(port: number): VirtualResponse {
	return { "status": 503, "statusText": "Service Unavailable", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`No server listening on port ${port}`) };
}

/** Answer a preview's request from the dev server on its port in this worker — or undefined when there's none here. */
async function answerVirtual(raw: unknown): Promise<VirtualResponse | undefined> {
	const request = raw as VirtualRequest;
	const server = previewServers.get(request.port);
	const tap = workerTapResponse(request.url);

	if (tap !== undefined) {
		return tap;
	}

	if (server === undefined) {
		return undefined;
	}

	const serverNode = "vite:" + request.port;

	return answerServer(server, request, (direction, label, bytes) => {
		if (direction === "request") {
			architecture.record(architecture.self, serverNode, "request", label, bytes);
		} else {
			architecture.record(serverNode, architecture.self, direction, label, bytes);
		}
	});
}

serve(hub, "virtual.request", async (raw): Promise<VirtualResponse> => {
	const answered = await answerVirtual(raw);

	if (answered !== undefined) {
		return answered;
	}

	// Not a dev server's port: a debug run's server (extensions/tsval/debug-worker.ts — asked only when one serves the port: `$rpc.call.`
	// is the hub's call prefix) — or nobody's.
	const { port } = raw as VirtualRequest;

	return hub.interested(`$rpc.call.virtual.debug.${port}`) ? rpc.request(`virtual.debug.${port}`, raw, { "timeoutMs": 60_000 }).then((reply) => reply as VirtualResponse, () => notListening(port)) : notListening(port);
});

// M1: start almostnode's ViteDevServer in THIS worker on the shared workspace zen-fs, so the preview runs off
// the main thread and shares the editor's filesystem (no separate VFS / save mirroring). `ViteDevServer` pulls
// in `typescript` (its transpiler), so it's DYNAMICALLY imported — ts lands in a lazy chunk, off the node path.
serve(hub, "preview.start", async (raw): Promise<{ "ok": boolean; "port": number }> => {
	const { port, root } = raw as { "port": number; "root": string };
	const { ViteDevServer } = await import("@brianjenkins94/almostnode");
	const vfs = await getVfs();
	const server = new ViteDevServer(vfs, { "port": port, "root": root }) as unknown as PreviewServer;

	server.start();
	// HMR delivery (M2): the worker has no Window to post updates to, so give the server a stand-in whose
	// postMessage publishes the update over the hub; the main thread relays it to the preview iframe.
	server.setHMRTarget({
		"postMessage": (message) => {
			architecture.record("vite:" + port, architecture.self, "event", "hmr " + ((message as { "type"?: string } | null)?.type ?? "update"));
			hub.publish(`preview.hmr.${port}`, message);
		}
	});
	// Surface a cold-start transform failure on the observability plane so it's queryable via debug-mcp — not just a
	// worker console.warn we can't read. The server now returns a 500 (self-healing) instead of retrying, so if this
	// fires the preview may show a one-load error that recovers on reload; a recurrence means the race is still live.
	server.setTransformErrorReporter((info) => { log.warn("preview transform failed (served 500, recovers on reload)", info); });
	// The workspace's modules, instrumented for runtime evidence (RUNTIME-EVIDENCE.md, the third slice) as far as the
	// `silo.evidence.previews` setting says (core answers; `full` when it can't): the page runtime the tap carries
	// counts what they report.
	const level = await rpc.request("evidence.level", undefined, { "timeoutMs": 2_000, "waitForResponderMs": 2_000 }).catch(() => "full");

	server.setInstrumentation(level === "coverage" || level === "off" ? level : "full");
	previewServers.set(port, server);
	previewRoots.set(port, root.replace(/\/$/u, ""));
	applyStops(port, server);
	architecture.spawn({ "id": "vite:" + port, "label": "Vite dev server :" + port, "container": "workers", "detail": root, "dynamic": true });
	lastPreviewConfig = { "port": port, "root": root };

	return { "ok": true, "port": port };
});

// Run ONE hardReset round in a freshly-spawned child worker (provoke-worker.ts): a cold module realm where
// almostnode + typescript are imported for the first time, so the FIRST transform reproduces the true cold-start
// window that a warm in-process restart can't. Its hub links into ours; we hand it the workspace SAB in one
// `provoke.round` call, await the reply, then terminate it.
async function provokeColdChild(buffer: SharedArrayBuffer, root: string, port: number, urls: string[], timeoutMs: number): Promise<{ "failures": Array<{ "url": string; "status": number }>; "transformErrors": Array<{ "url": string; "name": string; "message": string }>; "error"?: string }> {
	const worker = new Worker(new URL("./provoke-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	// One deadline for the whole round (the child's boot + its cold transforms), and a worker that fails ends it now.
	const round = new AbortController();
	const timer = setTimeout(() => { round.abort(new Error("provoke child timed out after " + timeoutMs + "ms")); }, timeoutMs);

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		round.abort(new Error(event.message || "provoke child worker error"));
	});

	try {
		architecture.record("provoke", ZENFS_NODE, "lifecycle", "mount /workspace (shared " + Math.round(buffer.byteLength / 1048576) + " MB)");

		return await rpc.request("provoke.round", { "buffer": buffer, "root": root, "port": port, "modules": urls }, { "timeoutMs": Infinity, "waitForResponderMs": timeoutMs, "signal": round.signal }) as { "failures": Array<{ "url": string; "status": number }>; "transformErrors": Array<{ "url": string; "name": string; "message": string }>; "error"?: string };
	} finally {
		clearTimeout(timer);
		unlink();
		worker.terminate();
	}
}

// Debug affordance: provoke the cold-start transform race on demand, so an agent can loop it via debug-mcp
// (provoke_transform) instead of hand-driving full-page cold boots. Two modes:
//   • default (warm): each round tears down the in-process dev server (→ a fresh, EMPTY transform cache) and fires
//     the whole src/ graph's transforms CONCURRENTLY. Fast, but the worker's typescript stays hot across rounds.
//   • hardReset: each round spawns a fresh CHILD worker (cold almostnode + ts) that does one concurrent transform
//     burst. Slower (a cold ts chunk per round) but reproduces the true first-load window. Needs the workspace SAB
//     (cross-origin isolation); without it there's nothing to hand the child, so it errors.
// A transform that loses the race returns 500 (we removed the masking retry), so we count 500s and surface the
// reporter's error shape.
interface ProvokeResult { "rounds": number; "modules": string[]; "hardReset": boolean; "provoked": boolean; "failures": Array<{ "round": number; "url": string; "status": number }>; "transformErrors": Array<{ "round": number; "url": string; "name": string; "message": string }> }
// A version of a module a dev server instrumented, by its source's blob oid: runtime evidence reads a version's counts
// against its own text (evidence.ts asks as soon as a page reports a version — a hot update may have replaced it).
serve(hub, "preview.version", (raw) => {
	const { port, oid } = (raw ?? {}) as { "port"?: unknown; "oid"?: unknown };

	return typeof port === "number" && typeof oid === "string" ? previewServers.get(port)?.versionSource(oid) ?? {} : {};
});

// The recorded stops, from the editor's breakpoints (recorded-stops.ts): every dev server's from now on.
serve(hub, "preview.stops", (raw) => {
	const { stops } = (raw ?? {}) as { "stops"?: unknown };

	previewStops = typeof stops === "object" && stops !== null ? stops as Record<string, number[]> : {};

	for (const [port, server] of previewServers) {
		applyStops(port, server);
	}

	return true;
});

serve(hub, "preview.provoke", async (raw): Promise<ProvokeResult> => {
	const { rounds = 10, modules, hardReset = false, port: portArg, root: rootArg } = (raw ?? {}) as { "rounds"?: number; "modules"?: string[]; "hardReset"?: boolean; "port"?: number; "root"?: string };
	const port = portArg ?? lastPreviewConfig?.port;
	const root = rootArg ?? lastPreviewConfig?.root;

	if (port === undefined || root === undefined) {
		throw new Error("preview.provoke: no preview started yet (run the terminal `vite` command first, or pass port + root)");
	}

	const { ViteDevServer } = await import("@brianjenkins94/almostnode");
	const vfs = await getVfs();

	// The module set to hammer: caller-supplied, else the whole src/ graph (what a cold boot fetches at once).
	let urls = modules;

	if (urls === undefined) {
		try {
			const srcDir = root.replace(/\/$/, "") + "/src";

			urls = (vfs.readdirSync(srcDir) as string[]).filter((name) => /\.[jt]sx?$/.test(name)).map((name) => "/src/" + name);
		} catch {
			urls = ["/src/main.tsx", "/src/App.tsx"];
		}
	}

	const failures: ProvokeResult["failures"] = [];
	const transformErrors: ProvokeResult["transformErrors"] = [];
	const span = log.span("preview.provoke", { "rounds": rounds, "modules": urls.length, "hardReset": hardReset });

	if (hardReset) {
		const buffer = getSharedWorkspaceBuffer();

		if (buffer === undefined) {
			span.end({ "failures": 0, "error": "no shared workspace buffer" });

			throw new Error("preview.provoke hardReset: no workspace SharedArrayBuffer (needs cross-origin isolation) — use the default (warm) mode instead");
		}

		for (let round = 0; round < rounds; round += 1) {
			const outcome = await provokeColdChild(buffer, root, port, urls, 30000);

			for (const failure of outcome.failures) {
				failures.push({ "round": round, "url": failure.url, "status": failure.status });
			}

			for (const info of outcome.transformErrors) {
				transformErrors.push({ "round": round, "url": info.url, "name": info.name, "message": info.message });
			}

			if (outcome.error !== undefined) {
				log.warn("preview.provoke child error (round " + round + ")", { "error": outcome.error });
			}
		}
	} else {
		for (let round = 0; round < rounds; round += 1) {
			previewServers.get(port)?.stop();

			const server = new ViteDevServer(vfs, { "port": port, "root": root }) as unknown as PreviewServer;

			server.start();
			server.setHMRTarget({ "postMessage": (message) => { hub.publish(`preview.hmr.${port}`, message); } });
			server.setTransformErrorReporter((info) => { log.warn("preview transform failed (provoke round " + round + ")", info); transformErrors.push({ "round": round, "url": info.url, "name": info.name, "message": info.message }); });
			previewServers.set(port, server);
			lastPreviewConfig = { "port": port, "root": root };

			// Fire the whole graph at once — losing the cold-start race is the thing we're trying to catch.
			const results = await Promise.all(urls.map(async (url) => {
				const response = await server.handleRequest("GET", url, {});

				return { "url": url, "status": response.statusCode };
			}));

			for (const result of results) {
				if (result.status >= 500) {
					failures.push({ "round": round, "url": result.url, "status": result.status });
				}
			}
		}
	}

	span.end({ "failures": failures.length });
	log.info("preview.provoke done", { "rounds": rounds, "hardReset": hardReset, "failures": failures.length });

	return { "rounds": rounds, "modules": urls, "hardReset": hardReset, "provoked": failures.length > 0, "failures": failures, "transformErrors": transformErrors };
});

// Hot reload: every change to the workspace — an editor save, a git checkout, a run's write, from any realm —
// arrives as `workspace.changed` (see workspace-changes.ts); each dev server re-reads the files under its root and
// emits the HMR update (notifyChange takes a root-relative path, e.g. /src/App.tsx). Like Vite's own watcher, it
// ignores .git and node_modules (and the editor's .silo): the dev server full-reloads the page for any file outside
// its module graph, and those change on nearly every save (the git index, acquired types, the capability ledger).
const UNWATCHED = /\/(?:\.git|node_modules|\.silo)(?:\/|$)/u;

hub.subscribe(WORKSPACE_CHANGED, (data) => {
	for (const [port, root] of previewRoots) {
		const server = previewServers.get(port);

		for (const change of data as WorkspaceChange[]) {
			if (server !== undefined && change.path.startsWith(root + "/") && !UNWATCHED.test(change.path.slice(root.length))) {
				architecture.record(architecture.self, "vite:" + port, "event", "file " + change.type);
				server.notifyChange(change.path.slice(root.length));
			}
		}
	}
});

// Ctrl-C on the terminal's `vite` command: stop that port's dev server so it's really gone (a later `npm run dev`
// starts a fresh one). With no port (legacy single-preview teardown), stop every server.
hub.subscribe("preview.close", (data) => {
	const port = (data as { "port"?: number } | null)?.port;

	if (typeof port === "number") {
		if (previewServers.has(port)) {
			architecture.terminate("vite:" + port);
		}

		previewServers.get(port)?.stop();
		previewServers.delete(port);
		previewRoots.delete(port);

		return;
	}

	for (const [running, server] of previewServers) {
		server.stop();
		architecture.terminate("vite:" + running);
	}

	previewServers.clear();
	previewRoots.clear();
});
