/**
 * Live preview pane — runs the workspace as a real app through an in-browser Vite dev server, no backend.
 *
 * Path B ("almostnode as WebContainer"): a {@link ViteDevServer} runs HERE in the host page over an almostnode
 * {@link VirtualFS} seeded with the workspace files. It transpiles JSX/TS with the browser TypeScript
 * (`ts.transpileModule`) and does React-Fast-Refresh HMR. The preview <iframe> reaches it over ordinary HTTP
 * at `/__virtual__/<port>/`, routed by the one service worker (coi-serviceworker.js, which also provides COI +
 * the module resolver) through the ServerBridge MessageChannel. When a file is saved in the editor we mirror
 * it into the VFS; the dev server watches the VFS and pushes an HMR update to the iframe — component state
 * survives the edit.
 *
 * This module is LAZY-loaded (dynamic import) because it pulls in `typescript` (the transpiler); keeping it out
 * of the initial host bundle means that cost is paid only when the preview is actually opened. The service
 * worker can't be registered in the in-app Browser pane, so the preview only works in a real browser tab.
 */
import { getServerBridge, VirtualFS, ViteDevServer } from "almostnode";

/** The virtual port the dev server is registered on (any value; it only namespaces the `/__virtual__/` URL). */
const PREVIEW_PORT = 5173;

export interface Preview {
	/** Mirror an edited workspace file into the preview's VFS, triggering HMR. Path is workspace-absolute. */
	"update": (path: string, contents: string) => void;
}

export interface PreviewOptions {
	/** The workspace files to seed (workspace-absolute paths, e.g. "/workspace/src/App.tsx"). */
	"files": { "path": string; "contents": string }[];
	/** The explorer root the files live under (stripped so the dev server sees "/index.html", "/src/…"). */
	"workspaceFolder": string;
	/** The iframe the preview renders into. */
	"iframe": HTMLIFrameElement;
	/** URL of the shared service worker (coi-serviceworker.js) that routes `/__virtual__/` to the bridge. */
	"swUrl": string;
}

/** ViteDevServer isn't an http.Server; the bridge wants {listening, address, handleRequest}. Thin adapter. */
function httpWrapper(server: ViteDevServer): unknown {
	return {
		"listening": true,
		"address": () => ({ "port": server.getPort(), "address": "0.0.0.0", "family": "IPv4" }),
		"handleRequest": (method: string, url: string, headers: Record<string, string>, body?: unknown) => server.handleRequest(method, url, headers, body as never)
	};
}

export async function createPreview(options: PreviewOptions): Promise<Preview> {
	const { files, workspaceFolder, iframe, swUrl } = options;
	const prefix = workspaceFolder.replace(/\/$/u, "");

	// Workspace-absolute path → VFS path (dev-server root is "/"): "/workspace/src/App.tsx" → "/src/App.tsx".
	const toVfsPath = (path: string): string => {
		const stripped = path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;

		return stripped.startsWith("/") ? stripped : "/" + stripped;
	};

	const vfs = new VirtualFS();

	const write = (path: string, contents: string): void => {
		const vfsPath = toVfsPath(path);
		const dir = vfsPath.slice(0, vfsPath.lastIndexOf("/"));

		if (dir !== "" && !vfs.existsSync(dir)) {
			vfs.mkdirSync(dir, { "recursive": true });
		}

		vfs.writeFileSync(vfsPath, contents);
	};

	// Seed the app files. Skip the seeded type surface (node_modules/*.d.ts) — that's for the editor's TS
	// server, not part of the running app (which resolves react from the CDN import map the dev server injects).
	for (const file of files) {
		const vfsPath = toVfsPath(file.path);

		if (vfsPath.startsWith("/node_modules/") || vfsPath.endsWith(".d.ts")) {
			continue;
		}

		write(file.path, file.contents);
	}

	const server = new ViteDevServer(vfs, { "port": PREVIEW_PORT, "root": "/" });
	const bridge = getServerBridge();

	// Attach to the already-registered service worker and open the MessageChannel (idempotent re-register).
	await bridge.initServiceWorker({ "swUrl": swUrl });
	bridge.registerServer(httpWrapper(server) as never, PREVIEW_PORT);
	server.start();

	// Point the iframe at the dev server; (re)set the HMR target each time it loads so pushed updates land.
	iframe.addEventListener("load", () => {
		if (iframe.contentWindow !== null) {
			server.setHMRTarget(iframe.contentWindow);
		}
	});
	// Serve UNDER the deploy base (e.g. /editor/__virtual__/…), not root — the SW is scoped to the base, so a
	// root-absolute /__virtual__/ URL would fall outside its scope and never be intercepted. Base = the SW
	// script's own directory. (bridge.getServerUrl returns a root-absolute URL, so we build it ourselves.)
	const base = swUrl.slice(0, swUrl.lastIndexOf("/") + 1);

	iframe.src = base + "__virtual__/" + PREVIEW_PORT + "/";

	return {
		"update": (path, contents) => { write(path, contents); }
	};
}
