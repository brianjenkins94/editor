/**
 * Live preview BACKEND — runs the workspace as a real app through an in-browser Vite dev server, no backend server.
 *
 * The dev server (almostnode's ViteDevServer) runs IN THE NODE WORKER on the shared workspace zen-fs (see
 * extensions/worker-pod/node-worker.ts) — off the main thread, and on the same filesystem the editor writes, so
 * there's no separate VFS and no file mirroring. This module is the bridge END: it drives the worker over the hub
 * (`preview.start` / `virtual.request` / `preview.fileChanged`) and registers a virtual server with the ServerBridge
 * so `/__virtual__/<port>/` requests (routed by coi-serviceworker) relay to the worker. It runs in the APP realm
 * (2-hop to the worker), and is display-free: the movable preview WINDOW + iframe live in the SHELL/top frame
 * (shell-preview.ts) so the preview can roam beyond the editor's bounds. The service-worker URL it exposes is the
 * only handoff — the shell points its iframe there; HMR (`preview.hmr.<port>`) and the injected console tap ride the
 * hub / postMessage up to the shell, which applies them. `typescript` (the transpiler) lives in the worker, so this
 * stays out of the host bundle. The service worker can't be registered in the in-app Browser pane, so the preview
 * only works in a real browser tab.
 */
import type { Hub } from "@brianjenkins94/hub";
// Import the bridge from the NARROW subpath, not the barrel — the barrel re-exports ViteDevServer, which pulls
// `typescript` (~7MB); this host-page module only needs the ServerBridge, so the narrow path keeps ts out of the
// main-thread bundle (the dev server + its ts live in the node worker).
import { getServerBridge } from "@brianjenkins94/almostnode/bridge";
import { createRpcClient } from "@brianjenkins94/hub";

/** The virtual port the dev server is registered on (any value; it only namespaces the `/__virtual__/` URL). */
const PREVIEW_PORT = 5173;

export interface Preview {
	/** The `/__virtual__/<port>/` URL the shell points its preview iframe at (served by the SW → this bridge). */
	"url": string;
	/** Tell the worker's dev server a workspace file changed (workspace-absolute path), triggering HMR. */
	"update": (path: string, contents: string) => void;
	/** Tear the preview down: unregister the bridge server (Ctrl-C on `vite`). */
	"close": () => void;
}

export interface PreviewOptions {
	/** URL of the shared service worker (coi-serviceworker.js) that routes `/__virtual__/` to the bridge. */
	"swUrl": string;
	/** The hub whose tree reaches the node worker (the page root hub). */
	"hub": Hub;
	/** The explorer root the app lives under in the shared workspace (default "/workspace"). */
	"workspaceFolder"?: string;
}

/** The worker's relayed response to a virtual request (see node-runner.ts / node-worker.ts). */
interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": Uint8Array }

export async function createPreview(options: PreviewOptions): Promise<Preview> {
	const { swUrl, hub } = options;
	const workspaceFolder = options.workspaceFolder ?? "/workspace";
	const rpc = createRpcClient(hub);

	// Start the dev server in the node worker, rooted at the workspace on the shared zen-fs.
	await rpc.request("preview.start", { "port": PREVIEW_PORT, "root": workspaceFolder }, { "timeoutMs": 30000 });

	// The ServerBridge wants an http-server-shaped `{listening, address, handleRequest}`; each request relays to
	// the worker's dev server over the hub and comes back as status/headers/body.
	const virtualServer = {
		"listening": true,
		"address": () => ({ "port": PREVIEW_PORT, "address": "0.0.0.0", "family": "IPv4" }),
		"handleRequest": async (method: string, url: string, headers: Record<string, string>, body?: ArrayBufferLike) => {
			const response = await rpc.request("virtual.request", {
				"port": PREVIEW_PORT,
				"method": method,
				"url": url,
				"headers": headers,
				"body": body === undefined ? undefined : new Uint8Array(body)
			}, { "timeoutMs": 30000 }) as VirtualResponse;

			return { "statusCode": response.status, "statusMessage": response.statusText, "headers": response.headers, "body": response.body };
		}
	};

	const bridge = getServerBridge();

	await bridge.initServiceWorker({ "swUrl": swUrl });
	bridge.registerServer(virtualServer as never, PREVIEW_PORT);

	// The iframe lives in the SHELL now, so HMR and the injected console tap are applied there (shell-preview.ts):
	// the worker publishes `preview.hmr.<port>` on the hub (the shell subscribes and posts it into its iframe), and
	// the tap's messages arrive in the shell window. This backend just serves assets over the bridge.

	// Serve UNDER the deploy base (e.g. /editor/__virtual__/…), not root — the SW is scoped to the base, so a
	// root-absolute /__virtual__/ URL would fall outside its scope and never be intercepted.
	const base = swUrl.slice(0, swUrl.lastIndexOf("/") + 1);
	const url = base + "__virtual__/" + PREVIEW_PORT + "/";
	const prefix = workspaceFolder.replace(/\/$/u, "");

	return {
		"url": url,
		// The editor already wrote the file into the shared workspace zen-fs the worker reads — we only tell the
		// worker which (root-relative) path changed so it re-reads and emits the HMR update. Content isn't sent.
		"update": (path) => {
			const relative = path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;

			hub.publish("preview.fileChanged", { "port": PREVIEW_PORT, "path": relative.startsWith("/") ? relative : "/" + relative });
		},
		"close": () => {
			bridge.unregisterServer(PREVIEW_PORT);
		}
	};
}
