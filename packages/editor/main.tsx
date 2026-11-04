/** @jsxImportSource preact */
// (first, before anything takes the realm's own: an instance's storage apart, a hidden tab's timers kept)
import { isEditorTop } from "./shared/instance";
import "./shared/hidden-timers";
import { createHub, createRpcClient, serve, windowTransport } from "@brianjenkins94/hub";
import { consoleCollector, installHubCollector, installWindowMessageProbe, linkDebugMcp, linkServiceWorkerHub, servePageTools, tapConsoleAndErrors } from "@brianjenkins94/observability";
import moduleVersions from "editor:versions";
import { ensureCrossOriginIsolated } from "./app/coi";
import { hostLog } from "./app/logging";
import { createVscodeWindow } from "./app/vscode";
import { reportArchitecture } from "./shared/architecture";
import { reportSpanMetrics } from "./shared/editor-metrics";
import { followResets, resetAsked, resetEditor, waitForReset } from "./shell/reset";

// Gain cross-origin isolation (SharedArrayBuffer) before booting. A dev server already sends the COOP/COEP
// headers; on a static host (GitHub Pages) the coi service worker supplies them after one reload. On the
// un-isolated first load this returns false and schedules that reload, so we skip booting until the page
// comes back isolated.
// `?reset` (shell/reset.ts): before any of that — the service worker and the workbench would hold what it deletes.
const reset = isEditorTop() ? resetAsked() : undefined;
const isolated = reset === undefined && ensureCrossOriginIsolated();

if (reset === "wait") {
	waitForReset();
} else if (reset !== undefined) {
	void resetEditor((import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/", reset === "all");
} else if (isolated && isEditorTop()) {
	followResets();
	// TOP LEVEL: render the outer shell — the app's main layout (chrome + RHS review panel). It
	// iframes THIS same page back in; that nested instance sees `window.parent !== window` and takes the app
	// branch below, booting the workbench into the middle (fill mode). One entry, one bundle, one COI bootstrap.
	// DYNAMIC import so the shell's WebAwesome chrome (wa-page, wa-button, the theme) lands in a shell-only chunk and
	// never loads in the app iframe — the editor realm stays WA-free.
	performance.mark("shell/import");
	void import("./shell/shell.tsx").then(({ renderShell }) => {
		renderShell();
	});
} else if (isolated) {
	// The workbench opens on the bundled demo workspace (snapshot.ts bakes `demo/` in at build time as
	// `editor:workspace`). The dependency type surface (`editor:types`) is seeded alongside so the
	// in-browser TS server resolves the demo's imports, and `editor:versions` drives the CDN node_modules
	// overlay for go-to-definition into real dependency source. A real on-disk folder (File System Access)
	// becomes an additional source mode later. Both load DYNAMICALLY: the type surface is ~480KB the shell (top
	// level) never uses, and the app only needs them to answer the workbench's `workbench.init`, well after it
	// creates the workbench iframe — so neither is on the path to that.
	const files = Promise.all([import("editor:workspace"), import("editor:types")]).then(([workspace, types]) => [...workspace.default, ...types.default]);

	// The root hub — top of the composable-hub tree. A collector renders every context's spans/records off the
	// `$sys.log.>` observability plane (the service worker now, the pod + workers next); the SW links in over a
	// dedicated port. See @brianjenkins94/observability / @brianjenkins94/hub.
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
	// Every context's records arrive here: to the console, and — their spans — onto the metrics plane as rates, errors and
	// latencies (editor-metrics.ts).
	const spans = reportSpanMetrics(rootHub);

	installHubCollector(rootHub, (record) => {
		consoleCollector(record);
		spans.record(record);
	});

	tapConsoleAndErrors(rootHub, "host"); // raw uncaught error/rejection on the page → the plane (errors-only: loop-safe on the collector context)
	// This tab's id: debug-mcp addresses this tab's page tools by it, apart from every other tab's.
	const tab = crypto.randomUUID().slice(0, 8);

	linkServiceWorkerHub(rootHub);
	// What the service worker relays for this tab (it serves every tab: `/__virtual__/<tab>/<port>/` names which) to its
	// dev-server worker, below this root; and which tab this is, for an address (workbench/node-runner.ts).
	const tabRpc = createRpcClient(rootHub);

	serve(rootHub, `virtual.request.${tab}`, async (args) => tabRpc.request("virtual.request", args, { "timeoutMs": 30_000, "waitForResponderMs": 10_000 }));
	serve(rootHub, "virtual.tab", () => tab);
	linkDebugMcp(rootHub); // dev-only: federate the tree to a running @brianjenkins94/debug-mcp for MCP querying
	// Dev-only: this tab's MCP tools, which debug-mcp registers while it's connected — under this tab's id, so it can
	// address one tab of several: every page's page_eval / page_query, and the editor's own (the debugger, the preview's
	// cold-start provoke, a preview page's Chrome DevTools Protocol — see tools/).
	// (tools/: a folder per family, each util/mcp's own tools — loaded after boot, so the MCP SDK and zod stay off its path)
	void import("./app/tools").then(({ editorTools }) => {
		servePageTools(rootHub, { "tab": tab, "tools": editorTools(rootHub) });
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
		"onSave": (path: string, contents: string) => {
			hostLog.info("saved", { "path": path, "bytes": contents.length });
		}
	});

	// When embedded in the outer shell (shell.html), link the root hub UP to the shell over the window boundary
	// and take the projects it loads. Standalone (top-level) load is unchanged — no parent to link, so none of this runs.
	if (embedded) {
		rootHub.link(windowTransport(window.parent));
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
		hostLog.info("shell link established");
	}
}
