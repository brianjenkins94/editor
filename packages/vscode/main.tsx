/** @jsxImportSource preact */
import type { Preview } from "./preview";
import { createHub, createRpcClient, serve, windowTransport } from "@brianjenkins94/hub";
import { installWindowMessageProbe } from "@brianjenkins94/observability";
import moduleVersions from "editor:versions";
import { ensureCrossOriginIsolated } from "./coi";
import { hostLog } from "./logging";
import { consoleCollector, installHubCollector, linkDebugMcp, linkServiceWorkerHub, servePageTools, tapConsoleAndErrors } from "./telemetry";
import { reportArchitecture } from "./architecture";
import { sampleById, sampleList } from "./samples";
import { createVscodeWindow } from "./vscode";

// Gain cross-origin isolation (SharedArrayBuffer) before booting. A dev server already sends the COOP/COEP
// headers; on a static host (GitHub Pages) the coi service worker supplies them after one reload. On the
// un-isolated first load this returns false and schedules that reload, so we skip booting until the page
// comes back isolated.
const isolated = ensureCrossOriginIsolated();

if (isolated && window.parent === window) {
	// TOP LEVEL: render the outer shell — the app's main layout (chrome + LHS project picker + RHS history). It
	// iframes THIS same page back in; that nested instance sees `window.parent !== window` and takes the app
	// branch below, booting the workbench into the middle (fill mode). One entry, one bundle, one COI bootstrap.
	// DYNAMIC import so the shell's WebAwesome chrome (wa-page, wa-button, the theme) lands in a shell-only chunk and
	// never loads in the app iframe — the editor realm stays WA-free.
	performance.mark("shell/import");
	void import("./shell.tsx").then(({ renderShell }) => { renderShell(); });
} else if (isolated) {
	// The workbench opens on the bundled demo workspace (snapshot.ts bakes `demo/` in at build time as
	// `editor:workspace`). The dependency type surface (`editor:types`) is seeded alongside so the
	// in-browser TS server resolves the demo's imports, and `editor:versions` drives the CDN node_modules
	// overlay for go-to-definition into real dependency source. A real on-disk folder (File System Access)
	// becomes an additional source mode later. Both load DYNAMICALLY: the type surface is ~480KB the shell (top
	// level) never uses, and the app only needs them to answer the workbench's `workbench.init`, well after it
	// creates the workbench iframe — so neither is on the path to that.
	const files = Promise.all([import("editor:workspace"), import("editor:types")]).then(([workspace, types]) => [...workspace.default, ...types.default]);
	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

	// The root hub — top of the composable-hub tree. A collector renders every context's spans/records off the
	// `$sys.log.>` observability plane (the service worker now, the pod + workers next); the SW links in over a
	// dedicated port. See telemetry.ts / @brianjenkins94/hub.
	const rootHub = createHub({ "id": "root" });

	// This realm's hub + network on $sys.arch, for the live architecture view — plus every message another frame posts
	// here that isn't hub traffic (the shell above, the workbench iframe below), so a new channel can't hide.
	const architecture = reportArchitecture(rootHub);

	installWindowMessageProbe(architecture, (source) => {
		if (source === window.parent) {
			return "shell";
		}

		return [...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === source && frame.src.includes("/__vscode__/host.html")) ? "workbench" : undefined;
	});
	installHubCollector(rootHub, consoleCollector);
	tapConsoleAndErrors(rootHub, "host"); // raw uncaught error/rejection on the page → the plane (errors-only: loop-safe on the collector context)
	// This tab's id. The service worker is shared by every tab of the origin and links each tab's root separately, so
	// what it asks on a tab's behalf is addressed to that tab: a preview's requests and capability decisions (its URL
	// carries the tab, /__virtual__/<tab>/<port>/) and a node script's decisions (the node worker is told its tab).
	// This root answers its tab's addresses by asking its own tree — never another tab's.
	const tab = crypto.randomUUID().slice(0, 8);
	const tabRpc = createRpcClient(rootHub);

	serve(rootHub, "virtual.request." + tab, (args) => tabRpc.request("virtual.request", args, { "timeoutMs": 30000, "waitForResponderMs": 10000 }));
	serve(rootHub, "capability.decide." + tab, (args) => tabRpc.request("capability.decide", args, { "timeoutMs": 300000, "waitForResponderMs": 10000 }));
	linkServiceWorkerHub(rootHub);
	linkDebugMcp(rootHub); // dev-only: federate the tree to a running @brianjenkins94/debug-mcp for MCP querying
	// Dev-only: the live MCP tools debug-mcp forwards to, under this tab's id so it can address one tab of several —
	// page_eval/page_query, plus calls into this tab's tree: the preview's cold-start provoke, a preview page's Chrome
	// DevTools Protocol (the shell's preview.cdp — see preview-devtools.ts) and the debugger's pod-level calls (a
	// session's own calls are already addressed by its id).
	servePageTools(rootHub, {
		"tab": tab,
		"forward": { "preview_provoke": "preview.provoke", "preview_cdp": "preview.cdp", "debug.sessions": "debug.sessions", "debug.start": "debug.start", "debug.breakpoints": "debug.breakpoints" }
	});

	// The live preview BACKEND: runs the demo (a Vite React app) through an in-browser dev server in the node worker,
	// which hot-reloads on workspace changes. Display-free — the movable window + iframe live in the shell (top
	// frame); this realm starts the dev server and hands the shell the URL the service worker answers. Created lazily
	// (dynamic import).
	// Keyed by virtual port, so several previews (a multi-server app, a multiplayer game) run concurrently, each with
	// its own dev server + shell window. The single-preview path is just the map with one entry on the default port.
	const previews = new Map<number, Preview>();
	const DEFAULT_PREVIEW_PORT = 5173;

	// EXPLICIT (M3): the backend starts when the workspace's dev script runs — `npm run dev` invokes the terminal's
	// `vite` command, which publishes `preview.open` — not at boot. On success we publish `preview.ready` with the SW
	// URL; the SHELL shows its movable window on `preview.open` and points the iframe there on `preview.ready`, so the
	// preview can roam beyond the editor. A repeat open on the same port just re-announces the URL for the shell to
	// resurface. Ctrl-C on `vite` publishes `preview.close` (backend teardown here; the shell hides its window too).
	rootHub.subscribe("preview.open", (data) => {
		const request = data as { "root"?: string; "port"?: number } | null;
		const port = typeof request?.port === "number" ? request.port : DEFAULT_PREVIEW_PORT;
		const existing = previews.get(port);

		if (existing !== undefined) {
			rootHub.publish("preview.ready", { "url": existing.url, "port": port }); // already running — resurface
			return;
		}

		import("./preview").then(({ createPreview }) => createPreview({
			"workspaceFolder": request?.root ?? "/workspace",
			"swUrl": base + "coi-serviceworker.js",
			"tab": tab,
			"hub": rootHub,
			"port": port
		})).then((handle) => {
			previews.set(handle.port, handle);
			rootHub.publish("preview.ready", { "url": handle.url, "port": handle.port });
			hostLog.info("preview ready", { "url": handle.url, "port": handle.port });
		}).catch((error: unknown) => {
			hostLog.error("preview failed", { "error": error instanceof Error ? error.message : String(error) });
		});
	});

	rootHub.subscribe("preview.close", (data) => {
		const port = typeof (data as { "port"?: number } | null)?.port === "number" ? (data as { "port": number }).port : DEFAULT_PREVIEW_PORT;

		previews.delete(port); // the node worker stops the dev server on the same message
	});

	// The app branch only runs inside the shell's iframe (top-level / renders the shell), so we're always embedded:
	// the editor fills the shell's middle space and links its root hub UP to the shell.
	const embedded = window.parent !== window;

	const vscodeWindow = createVscodeWindow({
		"workspaceFolder": "/workspace",
		"files": files,
		"moduleVersions": moduleVersions,
		"rootHub": rootHub,
		"tab": tab,
		"openEditors": ["/workspace/src/index.ts"],
		// Previews hot-reload from the workspace's own change events (workspace.changed), not from saves.
		"onSave": (path: string, contents: string) => {
			hostLog.info("saved", { "path": path, "bytes": contents.length });
		}
	});

	// When embedded in the outer shell (shell.html), link the root hub UP to the shell over the window boundary
	// and expose the project surface: the shell's LHS picker pulls `project.list` and publishes `project.open`
	// with a sample id, which we resolve to files and open in the live workbench. Standalone (top-level) load is
	// unchanged — no parent to link, so none of this runs.
	if (embedded) {
		rootHub.link(windowTransport(window.parent));
		serve(rootHub, "project.list", () => sampleList());
		rootHub.subscribe("project.open", (data) => {
			const id = (data as { "id"?: string } | null)?.id;
			const sample = typeof id === "string" ? sampleById(id) : undefined;

			if (sample !== undefined) {
				vscodeWindow.openProject(sample.files, sample.openEditors);
				hostLog.info("project.open", { "id": sample.id });
			}
		});
		// A GitHub repo loaded by the shell (which holds the token): the shell fetches the files and sends them here
		// (files cross the boundary, the token never does), and we write them straight into the workspace. Binary
		// files arrive as `bytes`; text as `contents`.
		rootHub.subscribe("project.openFiles", (data) => {
			const request = data as { "files"?: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[]; "openEditors"?: string[] } | null;

			if (Array.isArray(request?.files) && request.files.length > 0) {
				// Replace: the loaded repo becomes the workspace (clears the demo first).
				vscodeWindow.replaceProject(request.files, request.openEditors ?? []);
				hostLog.info("project.openFiles", { "files": request.files.length });
			}
		});
		// The shell asks for the current workspace to commit it back to GitHub; the workbench pane holds the FS, so we
		// relay its file list up (bytes and all — the token never comes down here).
		serve(rootHub, "workspace.files", () => vscodeWindow.readWorkspaceFiles());
		hostLog.info("shell link established");
	}
}
