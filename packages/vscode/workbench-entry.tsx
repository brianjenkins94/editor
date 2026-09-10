/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the <Workbench/> shell, then boots monaco into the resolved part containers once the host
 * page has sent the workspace (files/openEditors) over postMessage. On save, it posts the edited path
 * + contents back to the host. `boot`/`registerExtension`/`registerFileSystemOverlay` come from the
 * pre-built monaco-vscode-api bundle, kept external and mapped to the sibling `./main.js`.
 *
 * Foundation only: no product extension yet. A minimal, code-less default extension is registered
 * purely to obtain the `vscode` API so the activity bar can execute `workbench.view.*` commands.
 * Filesystem overlays (CDN node_modules now, real-disk FSA later) layer UNDER the seeded snapshot —
 * they answer only paths the in-memory FS misses, falling through on FileNotFound.
 */
import type { WorkbenchFile, WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";
import { boot, ExtensionHostKind, registerExtension, registerFileSystemOverlay } from "@brianjenkins94/monaco-vscode-api/main";
import { render } from "preact";
import { createNodeModulesProvider } from "./node-modules-provider";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string; "moduleVersions"?: Record<string, string> }

// The host page we report to: our parent when nested in its iframe (in-page window), or our opener
// when we've been popped out into our own standalone tab/window.
const host = window.opener ?? window.parent;

let parts: WorkbenchParts | undefined;
let init: Init | undefined;
let booted = false;

// The per-extension VS Code API, captured once the default extension resolves. The activity bar drives
// the workbench through it (view-switch commands); `runCommand` reads the latest api so the bar —
// rendered before boot — works on clicks made after boot.
// eslint-disable-next-line ts/no-explicit-any
let vscodeApi: any = null;

function runCommand(command: string): void { void vscodeApi?.commands?.executeCommand(command); }

/** Boot even with no viewport. When the workbench is mounted into a document that currently has no
 *  layout box — a closed/hidden preview pane, a background tab, a display:none host — the window,
 *  <html> and <body> all measure 0×0, and monaco's layout throws "Unable to figure out browser width
 *  and height". Instead of WAITING for a real size (which stalls the whole boot until the pane opens),
 *  we give <html> a temporary fallback box so boot proceeds now, then drop it the instant a real
 *  viewport arrives — monaco's own resize handling relayouts to the true size. A sized tab (production,
 *  and the pane-open case) never has the fallback applied, so this is a pure no-op there. */
function bootWithFallbackViewport(root: HTMLElement): void {
	if (root.clientWidth > 0 && root.clientHeight > 0) { return; }

	root.style.width = "1280px";
	root.style.height = "720px";

	const restore = (): void => {
		if (window.innerWidth === 0 || window.innerHeight === 0) { return; }
		root.style.removeProperty("width");
		root.style.removeProperty("height");
		window.removeEventListener("resize", restore);
	};

	window.addEventListener("resize", restore);
}

function maybeBoot(): void {
	if (booted || parts === undefined || init === undefined) { return; }
	booted = true;
	const { files, openEditors, workspaceFolder, moduleVersions } = init;

	bootWithFallbackViewport(document.documentElement);

	boot({
		"parts": parts,
		"files": files,
		"openEditors": openEditors,
		"workspaceFolder": workspaceFolder,
		"configuration": configuration,
		"keybindings": keybindings,
		"onSave": (path, contents) => {
			host.postMessage({ "source": "vscode", "type": "save", "path": path, "contents": contents }, "*");
		}
	})
		.then(() => {
			// Filesystem overlays, layered UNDER the seeded snapshot (they only answer paths the in-memory
			// FS misses, falling through on FileNotFound). Registered after boot so the file service is up.
			// The CDN node_modules overlay is the first; a real-disk File System Access overlay will be its
			// sibling here. Priority 0 = below the snapshot.
			if (moduleVersions !== undefined && Object.keys(moduleVersions).length > 0) {
				registerFileSystemOverlay(0, createNodeModulesProvider(workspaceFolder ?? "/workspace", moduleVersions));
			}

			// A minimal, code-less default extension — registered only to obtain the `vscode` API so the
			// activity bar's view-switch commands work. The product extension will replace this later.
			const ext = registerExtension({ "name": "editor", "publisher": "brianjenkins94", "version": "0.0.0", "engines": { "vscode": "*" } }, ExtensionHostKind.LocalProcess);

			ext.setAsDefaultApi();
			ext.getApi().then((api: unknown) => {
				vscodeApi = api;
				// Boot into the Explorer viewlet (matching the activity bar's default). Deferred so it runs
				// AFTER the workbench restores its last-active viewlet (which would otherwise win).
				setTimeout(runCommand, 0, "workbench.view.explorer");
			}).catch((error: unknown) => { console.error("[vscode] default extension setup failed", error); });

			// Tell the host the workbench is up (readiness gating).
			host.postMessage({ "source": "vscode", "type": "online" }, "*");
		})
		.catch((error: unknown) => {
			console.error("[vscode] workbench boot failed", error);
		});
}

window.addEventListener("message", (event) => {
	if (event.source !== host) { return; }
	const data = event.data as { "source"?: string; "type"?: string } & Partial<Init> | null;

	if (data?.source === "vscode-host" && data.type === "init") {
		init = { "files": data.files ?? [], "openEditors": data.openEditors ?? [], "workspaceFolder": data.workspaceFolder, "moduleVersions": data.moduleVersions };
		maybeBoot();
	}
});

render(<Workbench onReady={(resolved) => { parts = resolved; maybeBoot(); }} runCommand={runCommand} />, document.body);

// Tell the host we're ready to receive the workspace.
host.postMessage({ "source": "vscode", "type": "ready" }, "*");
