/** @jsxImportSource preact */
import type { Preview } from "./preview";
import { createHub, serve, windowTransport } from "@brianjenkins94/hub";
import types from "editor:types";
import moduleVersions from "editor:versions";
import workspace from "editor:workspace";
import { ensureCrossOriginIsolated } from "./coi";
import { hostLog } from "./logging";
import { consoleCollector, installHubCollector, linkDebugMcp, linkServiceWorkerHub, servePageTools } from "./telemetry";
import { sampleById, sampleList } from "./samples";
import { renderShell } from "./shell";
import { createVscodeWindow } from "./vscode";
import { createPaneWindow } from "./window";

// Gain cross-origin isolation (SharedArrayBuffer) before booting. A dev server already sends the COOP/COEP
// headers; on a static host (GitHub Pages) the coi service worker supplies them after one reload. On the
// un-isolated first load this returns false and schedules that reload, so we skip booting until the page
// comes back isolated.
const isolated = ensureCrossOriginIsolated();

if (isolated && window.parent === window) {
	// TOP LEVEL: render the outer shell — the app's main layout (chrome + LHS project picker + RHS history). It
	// iframes THIS same page back in; that nested instance sees `window.parent !== window` and takes the app
	// branch below, booting the workbench into the middle (fill mode). One entry, one bundle, one COI bootstrap.
	renderShell();
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
	linkServiceWorkerHub(rootHub);
	linkDebugMcp(rootHub); // dev-only: federate the tree to a running @brianjenkins94/debug-mcp for MCP querying
	servePageTools(rootHub); // dev-only: host live MCP tools (page_eval/page_query) the debug-mcp relay forwards to

	// The live preview: runs the demo (a Vite React app) through an in-browser dev server and hot-reloads on
	// save. Created lazily (dynamic import) so `typescript` — the preview's transpiler — stays out of the
	// initial host bundle. Saves that arrive before it's ready are already covered by the initial seed.
	let preview: Preview | undefined;

	const previewWindow = createPaneWindow({
		"title": "Preview",
		"storageKey": "preview",
		"width": Math.min(520, window.innerWidth - 80),
		"height": Math.min(600, window.innerHeight - 120)
	});
	const previewFrame = document.createElement("iframe");

	previewWindow.body.appendChild(previewFrame);

	// The preview is EXPLICIT (M3): the pane opens when the workspace's dev script runs — `npm run dev` invokes
	// the terminal's `vite` command, which publishes `preview.open` — not at boot, so the pane stays hidden until
	// then (fewer things on screen you didn't ask for). The dev server is almostnode's ViteDevServer in the node
	// worker (preview.ts); loading is lazy — with `typescript` now in the worker, this only pulls the small host
	// bridge module. Ctrl-C on `vite` publishes `preview.close`, which tears the preview down and hides the pane.
	let previewOpen = false;

	rootHub.subscribe("preview.open", (data) => {
		if (previewOpen) {
			previewWindow.show(); // already running — just resurface the pane
			return;
		}

		previewOpen = true;
		previewWindow.show();

		import("./preview").then(({ createPreview }) => createPreview({
			"workspaceFolder": (data as { "root"?: string }).root ?? "/workspace",
			"iframe": previewFrame,
			"swUrl": base + "coi-serviceworker.js",
			"hub": rootHub
		})).then((handle) => {
			preview = handle;
			hostLog.info("preview ready");
		}).catch((error: unknown) => {
			hostLog.error("preview failed", { "error": error instanceof Error ? error.message : String(error) });
		});
	});

	rootHub.subscribe("preview.close", () => {
		previewOpen = false;
		preview?.close();
		preview = undefined;
		previewWindow.element.remove(); // hidden until the next `npm run dev`
	});

	// Embedded in the outer shell (shell.html iframes this page) → the editor fills the shell's middle space
	// (no draggable window). Standalone (top-level /) keeps the poppable WebAwesome window it has today.
	const embedded = window.parent !== window;

	const vscodeWindow = createVscodeWindow({
		"workspaceFolder": "/workspace",
		"files": files,
		"moduleVersions": moduleVersions,
		"rootHub": rootHub,
		"fill": embedded,
		"openEditors": ["/workspace/src/App.tsx"],
		"onSave": (path: string, contents: string) => {
			hostLog.info("saved", { "path": path, "bytes": contents.length });
			preview?.update(path, contents);
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
