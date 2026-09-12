/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the <Workbench/> shell, then boots monaco into the resolved part containers once the host
 * page has sent the workspace (files/openEditors) over postMessage. On save, it posts the edited path
 * + contents back to the host. `boot`/`registerExtension`/`registerFileSystemOverlay` come from the
 * pre-built monaco-vscode-api bundle, kept external and mapped to the sibling `./main.js`.
 *
 * The hello extension (extensions/hello) is the product extension: registered as browser CJS via a
 * data: URL, it is also the default API context, so the activity bar can execute `workbench.view.*`
 * commands through its `vscode` API. Filesystem overlays (CDN node_modules now, real-disk FSA later) layer UNDER the seeded snapshot —
 * they answer only paths the in-memory FS misses, falling through on FileNotFound.
 */
import type { WorkbenchFile, WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";
import { boot, ExtensionHostKind, registerExtension, registerFileSystemOverlay } from "@brianjenkins94/monaco-vscode-api/main";
import { render } from "preact";
// The hello extension: its package.json manifest + its bundled CJS code (from the `hello:extension`
// virtual module in entry.config.ts).
import helloExtensionCode from "hello:extension";
import workerPodExtensionCode from "worker-pod:extension";
import helloManifest from "./extensions/hello/package.json";
import workerPodManifest from "./extensions/worker-pod/package.json";
import { installDebugBridge, markBridgeReady } from "./debug-bridge";
import { installLogRelay } from "./logging";
import { createNodeModulesProvider } from "./node-modules-provider";
import { connectAsPane } from "./pane-bus";
import { vfsPutAll } from "./vfs";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string; "moduleVersions"?: Record<string, string> }

// The host page we report to: our parent when nested in its iframe (in-page window), or our opener when
// we've been popped out into our own standalone tab/window. The pane bus carries the workbench handshake;
// the log relay funnels our structured logs to that same host (its own message channel).
const host = window.opener ?? window.parent;
const bus = connectAsPane("editor");
const paneLog = installLogRelay(host, "editor");

/** Readable text for a caught `unknown` — Error message when it is one, a string as-is, else JSON (avoids
 *  the `[object Object]` a bare `String(error)` gives, and keeps relayed log attrs meaningful). */
function errText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}

let parts: WorkbenchParts | undefined;
let init: Init | undefined;
let booted = false;

// The per-extension VS Code API, captured once the hello extension resolves. The activity bar drives
// the workbench through it (view-switch commands); `runCommand` reads the latest api so the bar —
// rendered before boot — works on clicks made after boot.
// eslint-disable-next-line ts/no-explicit-any
let vscodeApi: any = null;

function runCommand(command: string): void {
	const pending = vscodeApi?.commands?.executeCommand(command) as Promise<unknown> | undefined;

	pending?.catch((error: unknown) => {
		console.error("[vscode] command failed", command, error);
	});
}

/** Boot even with no viewport. When the workbench is mounted into a document that currently has no
 *  layout box — a closed/hidden preview pane, a background tab, a display:none host — the window,
 *  <html> and <body> all measure 0×0, and monaco's layout throws "Unable to figure out browser width
 *  and height". Instead of WAITING for a real size (which stalls the whole boot until the pane opens),
 *  we give <html> a temporary fallback box so boot proceeds now, then drop it the instant a real
 *  viewport arrives — monaco's own resize handling relayouts to the true size. A sized tab (production,
 *  and the pane-open case) never has the fallback applied, so this is a pure no-op there. */
function bootWithFallbackViewport(root: HTMLElement): void {
	if (root.clientWidth > 0 && root.clientHeight > 0) {
		return;
	}

	root.style.width = "1280px";
	root.style.height = "720px";

	const restore = (): void => {
		if (window.innerWidth === 0 || window.innerHeight === 0) {
			return;
		}

		root.style.removeProperty("width");
		root.style.removeProperty("height");
		window.removeEventListener("resize", restore);
	};

	window.addEventListener("resize", restore);
}

function maybeBoot(): void {
	if (booted || parts === undefined || init === undefined) {
		return;
	}

	booted = true;
	const { files, openEditors, workspaceFolder, moduleVersions } = init;

	// Mirror the workspace files into the same-origin VFS store (IndexedDB) so a service worker can serve them
	// at their real paths for the in-browser module resolver (see vfs.ts). Fire-and-forget — independent of and
	// non-blocking to the workbench boot, which seeds monaco's own in-memory FS from `files` as before.
	vfsPutAll(files).then(() => {
		paneLog.info("vfs store populated", { "files": files.length });
	}).catch((error: unknown) => {
		paneLog.error("vfs store populate failed", { "error": errText(error) });
	});

	// One timed span for the whole boot; its child logs (relayed to the host) read as an indented tree of
	// what booting the workbench did and how long it took. Ended once monaco is online.
	const bootSpan = paneLog.span("workbench-boot", { "files": files.length, "openEditors": openEditors.length });

	bootWithFallbackViewport(document.documentElement);

	boot({
		"parts": parts,
		"files": files,
		"openEditors": openEditors,
		"workspaceFolder": workspaceFolder,
		"configuration": configuration,
		"keybindings": keybindings,
		"onSave": (path, contents) => {
			bus.post({ "type": "save", "path": path, "contents": contents });
			paneLog.info("saved", { "path": path, "bytes": contents.length });
		}
	})
		.then(() => {
			bootSpan.info("monaco booted");
			// Filesystem overlays, layered UNDER the seeded snapshot (they only answer paths the in-memory
			// FS misses, falling through on FileNotFound). Registered after boot so the file service is up.
			// The CDN node_modules overlay is the first; a real-disk File System Access overlay will be its
			// sibling here. Priority 0 = below the snapshot.
			if (moduleVersions !== undefined && Object.keys(moduleVersions).length > 0) {
				registerFileSystemOverlay(0, createNodeModulesProvider(workspaceFolder ?? "/workspace", moduleVersions));
			}

			// The hello extension — the default API context (so getApi()/runCommand work) + the hello world
			// command. Registered as CJS via a data: URL (the bundled code from entry.config.ts).
			const ext = registerExtension(helloManifest, ExtensionHostKind.LocalProcess);

			ext.registerFileUrl("./extension.js", "data:text/javascript;base64," + window.btoa(helloExtensionCode));
			ext.setAsDefaultApi().catch((error: unknown) => {
				bootSpan.error("setAsDefaultApi failed", { "error": errText(error) });
			});
			ext.getApi().then((api: unknown) => {
				vscodeApi = api;
				// Unblock the debug bridge (window.__editor.ready / .api). See debug-bridge.ts.
				markBridgeReady();
				bootSpan.info("hello extension api captured");
				// Boot into the Explorer viewlet (matching the activity bar's default). Deferred so it runs
				// AFTER the workbench restores its last-active viewlet (which would otherwise win).
				setTimeout(runCommand, 0, "workbench.view.explorer");
			}).catch((error: unknown) => { bootSpan.error("hello extension setup failed", { "error": errText(error) }); });

			// The LSP host — the manager extension that runs language servers in workers (LSP spine). Registered
			// on the main-thread (LocalProcess) host so it spawns top-level, non-throttled server workers; the
			// server ships inside its own bundle and starts as a Blob-URL module worker (see its extension.ts).
			const workerPodExt = registerExtension(workerPodManifest, ExtensionHostKind.LocalProcess);

			workerPodExt.registerFileUrl("./extension.js", "data:text/javascript," + encodeURIComponent(workerPodExtensionCode));

			bootSpan.info("extensions registered", { "extensions": ["hello", "worker-pod"] });
			// Tell the host the workbench is up (readiness gating), then close the boot span (its duration
			// is the time-to-online, relayed to the host console).
			bus.post({ "type": "online" });
			bootSpan.end();
		})
		.catch((error: unknown) => {
			bootSpan.error("workbench boot failed", { "error": errText(error) });
			bootSpan.end();
		});
}

// Workspace from the host, over the pane bus. Doubles as the pane announcing its window to the host, so a
// popped-out reload re-pairs by re-sending "ready" (below) with no special-casing here.
bus.on((payload) => {
	const data = payload as { "type"?: string } & Partial<Init>;

	if (data.type === "init") {
		init = { "files": data.files ?? [], "openEditors": data.openEditors ?? [], "workspaceFolder": data.workspaceFolder, "moduleVersions": data.moduleVersions };
		maybeBoot();
	}
});

// Dev-only host-page debug bridge (window.__editor). Reads the captured API lazily; no-op off localhost.
installDebugBridge(() => vscodeApi);

render(
	<Workbench
		onReady={(resolved) => {
			parts = resolved;
			maybeBoot();
		}}
		runCommand={runCommand}
	/>,
	document.body
);

// Tell the host we're ready to receive the workspace (also registers this window with the host bus).
paneLog.info("pane ready", { "pane": bus.id });
bus.post({ "type": "ready" });
