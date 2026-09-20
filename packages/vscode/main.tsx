/** @jsxImportSource preact */
import type { Preview } from "./preview";
import { createHub, serve, windowTransport } from "@brianjenkins94/hub";
import types from "editor:types";
import moduleVersions from "editor:versions";
import workspace from "editor:workspace";
import { ensureCrossOriginIsolated } from "./coi";
import { hostLog } from "./logging";
import { consoleCollector, installHubCollector, linkDebugMcp, linkServiceWorkerHub, servePageTools, tapConsoleAndErrors } from "./telemetry";
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
	void import("./shell.tsx").then(({ renderShell }) => { renderShell(); });
} else if (isolated) {
	// The workbench opens on the bundled demo workspace (snapshot.ts bakes `demo/` in at build time as
	// `editor:workspace`). The dependency type surface (`editor:types`) is seeded alongside so the
	// in-browser TS server resolves the demo's imports, and `editor:versions` drives the CDN node_modules
	// overlay for go-to-definition into real dependency source. A real on-disk folder (File System Access)
	// becomes an additional source mode later.
	const files = [...workspace, ...types];
	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

	// The root hub — top of the composable-hub tree. A collector renders every context's spans/records off the
	// `$sys.log.>` observability plane (the service worker now, the pod + workers next); the SW links in over a
	// dedicated port. See telemetry.ts / @brianjenkins94/hub.
	const rootHub = createHub({ "id": "root" });

	installHubCollector(rootHub, consoleCollector);
	tapConsoleAndErrors(rootHub, "host"); // raw uncaught error/rejection on the page → the plane (errors-only: loop-safe on the collector context)
	linkServiceWorkerHub(rootHub);
	linkDebugMcp(rootHub); // dev-only: federate the tree to a running @brianjenkins94/debug-mcp for MCP querying
	servePageTools(rootHub); // dev-only: host live MCP tools (page_eval/page_query) the debug-mcp relay forwards to

	// The live preview BACKEND: runs the demo (a Vite React app) through an in-browser dev server and hot-reloads on
	// save. Display-free — the movable window + iframe live in the shell (top frame); this realm runs the dev server +
	// ServerBridge and hands the shell the SW URL. Created lazily (dynamic import) so `typescript` — the preview's
	// transpiler — stays out of the initial host bundle. Saves that arrive before it's ready are covered by the seed.
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

		previews.get(port)?.close();
		previews.delete(port);
	});

	// The app branch only runs inside the shell's iframe (top-level / renders the shell), so we're always embedded:
	// the editor fills the shell's middle space and links its root hub UP to the shell.
	const embedded = window.parent !== window;

	const vscodeWindow = createVscodeWindow({
		"workspaceFolder": "/workspace",
		"files": files,
		"moduleVersions": moduleVersions,
		"rootHub": rootHub,
		"openEditors": ["/workspace/src/App.tsx"],
		"onSave": (path: string, contents: string) => {
			hostLog.info("saved", { "path": path, "bytes": contents.length });
			for (const preview of previews.values()) {
				preview.update(path, contents); // every live preview re-reads the changed file (they share the zen-fs)
			}
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
		hostLog.info("shell link established");
	}
}
