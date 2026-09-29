/**
 * Live preview BACKEND — runs the workspace as a real app through an in-browser Vite dev server, no backend server.
 *
 * The dev server (almostnode's ViteDevServer) runs IN THE NODE WORKER on the shared workspace zen-fs (see
 * extensions/worker-pod/node-worker.ts) — off the main thread, and on the same filesystem the editor writes, so
 * there's no separate VFS and no file mirroring. This module starts it (`preview.start` over the hub) and hands back
 * the `/__virtual__/<tab>/<port>/` URL; the service worker answers that URL's requests by calling the dev server over
 * the hub (`virtual.request.<tab>`, which this tab's root relays to its node worker), and the dev server hot-reloads on its own from the workspace's change events
 * (`workspace.changed`) — so nothing here relays requests or saves. It runs in the APP realm and is display-free: the
 * movable preview WINDOW + iframe live in the SHELL (shell-preview.ts) so the preview can roam beyond the editor's
 * bounds; HMR (`preview.hmr.<port>`) and the injected console tap ride the hub / postMessage up to the shell. The
 * service worker can't be registered in the in-app Browser pane, so the preview only works in a real browser tab.
 *
 * TRUST: the preview iframe is same-origin with the editor and NOT sandboxed — deliberately, because a sandboxed
 * (opaque-origin) frame isn't controlled by the service worker, so `/__virtual__/` would never reach the dev server,
 * and it would lose cross-origin isolation (SharedArrayBuffer). The cost: a previewed app can reach `window.parent`,
 * so the capability gate is a guard against accidents, not a boundary against hostile code. See ARCHITECTURE.md.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";

/** The default virtual port when none is given (single-preview back-compat); the value only namespaces the URL. */
const DEFAULT_PREVIEW_PORT = 5173;

export interface Preview {
	/** The virtual port this preview is registered on (keys the shell window + the decider's port→run attribution). */
	"port": number;
	/** The `/__virtual__/<tab>/<port>/` URL the shell points its preview iframe at (answered by the service worker). */
	"url": string;
}

export interface PreviewOptions {
	/** URL of the shared service worker (coi-serviceworker.js); the preview is served under its scope. */
	"swUrl": string;
	/** The hub whose tree reaches the node worker (the page root hub). */
	"hub": Hub;
	/** The explorer root the app lives under in the shared workspace (default "/workspace"). */
	"workspaceFolder"?: string;
	/** The virtual port to register this preview on — pass a distinct one per concurrent preview (default 5173). */
	"port"?: number;
	/** This tab's id: the service worker is shared by every tab, so the URL names the tab whose dev server answers. */
	"tab": string;
}

export async function createPreview(options: PreviewOptions): Promise<Preview> {
	const { swUrl, hub } = options;
	const port = options.port ?? DEFAULT_PREVIEW_PORT;

	// Start the dev server in the node worker, rooted at the workspace on the shared zen-fs.
	await createRpcClient(hub).request("preview.start", { "port": port, "root": options.workspaceFolder ?? "/workspace" }, { "timeoutMs": 30000 });

	// Serve UNDER the deploy base (e.g. /editor/__virtual__/…), not root — the SW is scoped to the base, so a
	// root-absolute /__virtual__/ URL would fall outside its scope and never be intercepted.
	const base = swUrl.slice(0, swUrl.lastIndexOf("/") + 1);

	return { "port": port, "url": base + "__virtual__/" + options.tab + "/" + port + "/" };
}
