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
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { boot, ExtensionHostKind, registerExtension, registerFileSystemOverlay, setTerminalProcessFactory } from "@brianjenkins94/monaco-vscode-api/main";
import { render } from "preact";
// The hello extension: its package.json manifest + its bundled CJS code (from the `hello:extension`
// virtual module in entry.config.ts).
import type { PodBridge } from "./extensions/worker-pod/extension";
import type { WorkspaceFs } from "./workspace-fs";
import capabilitiesExtensionCode from "capabilities:extension";
import eslintExtensionCode from "eslint:extension";
import helloExtensionCode from "hello:extension";
import workerPodExtensionCode from "worker-pod:extension";
import { installTypeAcquisition } from "./ata";
import { installDebugBridge, markBridgeReady } from "./debug-bridge";
import { installDebugPreview } from "./debug-preview-view";
import { createCosmeticClassifier } from "./cosmetic-classifier";
import { installEditHistory } from "./edit-history";
import { installCommentAnnotations } from "./git-comments";
import { installGitScm } from "./git-scm";
import { installGitService } from "./git-service";
import capabilitiesManifest from "./extensions/capabilities/package.json";
import eslintManifest from "./extensions/eslint/package.json";
import helloManifest from "./extensions/hello/package.json";
import workerPodManifest from "./extensions/worker-pod/package.json";
import { createNodeModulesProvider } from "./node-modules-provider";
import { createNodeRunner } from "./node-runner";
import { windowClientTransport } from "./pane-link";
import { relayLoggerToHub, tapConsoleAndErrors } from "./telemetry";
import { createBashProcess } from "./terminal";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";
import { installWorkspaceFs } from "./workspace-fs";

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string; "moduleVersions"?: Record<string, string> }

// The host page we report to: our parent when nested in its iframe (in-page window), or our opener when
// we've been popped out into our own standalone tab/window. One hub link (below) to it carries the boot
// handshake AND our structured logs. Identity from the URL (`?pane=`), so a popped-out reload re-pairs on the
// same pane-link channel.
const host = window.opener ?? window.parent;
const paneId = new URLSearchParams(location.search).get("pane") ?? "editor";

// The workbench manages its own internal scrolling; the HOST document must never scroll. Monaco keeps huge
// off-screen editor elements (`.lines-content` at ~16M px, a wide `.region`) that make the body horizontally
// scrollable even under `overflow:hidden`, and focusing/revealing a document programmatically scrolls the body —
// which shifts the WHOLE workbench left and clips it (dead space on the right). Most visible when the editor fills
// the shell's middle space (fill mode); harmless otherwise. Pin the document scroll to 0 — capture phase so it
// catches the body's own scroll event, and body/documentElement directly since the body is the scroller here.
window.addEventListener("scroll", () => {
	if (document.body.scrollLeft !== 0 || document.body.scrollTop !== 0) {
		document.body.scrollLeft = 0;
		document.body.scrollTop = 0;
	}

	if (document.documentElement.scrollLeft !== 0 || document.documentElement.scrollTop !== 0) {
		document.documentElement.scrollLeft = 0;
		document.documentElement.scrollTop = 0;
	}
}, true);

// The workbench-iframe hub — links UP to the page's root hub over the pane-link window transport (ONE link for the
// boot handshake below AND the pod/worker span federation), and bridges the extension pod into that same hub
// (wireWorkbenchHub, once the ext host is up). The link's `hello` handshake recovers the lossy-window race the old
// MessagePort was guarding, so no port is needed.
const workbenchHub = createHub({ "id": "workbench" });

workbenchHub.link(windowClientTransport(paneId, host));

// The pane's logger — its spans/records now ride the workbench hub to the root collector (converging the old
// bespoke window log relay onto the hub). Uncaught errors/rejections go through the same logger so they reach
// the collector too. Records published before the port links simply don't federate (the boot span may be an
// early casualty); everything after — saves, diagnostics, errors — arrives.
const paneLog = relayLoggerToHub(workbenchHub, "workbench");

tapConsoleAndErrors(workbenchHub, "workbench"); // raw uncaught error/rejection → the plane, beside the structured logs

window.addEventListener("error", (event) => {
	// A benign ResizeObserver notice monaco triggers constantly — not a real fault; don't relay it as an error.
	if (!event.message.includes("ResizeObserver loop")) {
		paneLog.error("uncaught error", { "message": event.message, "file": event.filename, "line": event.lineno });
	}
});
window.addEventListener("unhandledrejection", (event) => {
	const { reason } = event;

	// Capture the STACK, not just the message — a bare message is rarely enough to place a boot-time rejection.
	// Relays to the $sys.log.> collector (debug-mcp). (This is how the workspace-fs fake-URI `e.with` was traced.)
	paneLog.error("unhandled rejection", {
		"reason": reason instanceof Error ? reason.message : String(reason),
		"stack": reason instanceof Error ? reason.stack : undefined
	});
});

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

// Resolves once `vscodeApi` is captured — an `openProject` message (from the shell's picker, over the pane bus)
// may arrive right after "online" but before getApi()'s promise settles, so its handler awaits this.
let markApiReady: () => void;
const apiReady = new Promise<void>((resolve) => { markApiReady = resolve; });

function runCommand(command: string): void {
	const pending = vscodeApi?.commands?.executeCommand(command) as Promise<unknown> | undefined;

	pending?.catch((error: unknown) => {
		console.error("[vscode] command failed", command, error);
	});
}

/**
 * Open a project into the LIVE workbench (the LHS picker → shell hub → app → pane bus → here): write each file
 * through the vscode FS API (creating parent dirs first, since the zen-fs provider won't auto-create them) so it
 * lands in the workspace + shows in the explorer, then open + focus each entry. No reboot — one booted workbench.
 */
async function openProject(files: { "path": string; "contents": string }[], openEditors: string[]): Promise<void> {
	await apiReady;

	const vscode = vscodeApi;
	const encoder = new TextEncoder();
	const madeDirs = new Set<string>();

	for (const file of files) {
		const dir = file.path.slice(0, file.path.lastIndexOf("/"));

		if (dir.length > 0 && !madeDirs.has(dir)) {
			madeDirs.add(dir);
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)).then(undefined, () => { /* exists */ });
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.file(file.path), encoder.encode(file.contents));
	}

	for (const path of openEditors) {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));

			await vscode.window.showTextDocument(document, { "preview": false });
		} catch (error) {
			paneLog.error("openProject: show failed", { "path": path, "error": errText(error) });
		}
	}

	runCommand("workbench.view.explorer");
	paneLog.info("openProject wrote sample", { "files": files.length });
}

/**
 * Uplink the extension pod's hub to the page's root hub. The ext host is an isolated `extension-file://` realm
 * with no window path out, so the pod rides the worker-pod extension's EXPORTED bridge (a marshaled event +
 * function, see extension.ts PodBridge). A workbench hub links that bridge to the pod and windowTransport(host)
 * to the top page (workbench-entry HAS window access) — so pod/worker spans reach the page's $sys.log.>
 * collector. No-op if the extension exposes no bridge (the pod then stays a standalone root).
 */
function wireWorkbenchHub(workspaceBuffer?: SharedArrayBuffer): void {
	const workerPod = vscodeApi?.extensions?.getExtension("brianjenkins94.worker-pod");

	if (workerPod === undefined) {
		return;
	}

	(workerPod.activate() as Promise<PodBridge | undefined>).then((bridge) => {
		if (bridge?.toWorkbench === undefined || bridge.fromWorkbench === undefined) {
			return;
		}

		// M3b: hand the pod the shared workspace SharedArrayBuffer, so the cspell worker mounts the SAME
		// zen-fs the editor + type-checker use (at /workspace). No-op when there's no SAB (no cross-origin isolation).
		if (workspaceBuffer !== undefined) {
			(bridge as PodBridge & { "attachWorkspaceBuffer"?: (b: unknown) => void }).attachWorkspaceBuffer?.(workspaceBuffer);
		}

		// pod (ext host) <-> workbench, over the extension's exported event/function bridge. (The workbench <->
		// top-page link is the transferred MessagePort wired above.)
		workbenchHub.link({
			"send": (message) => { bridge.fromWorkbench(message); },
			"listen": (onMessage) => {
				const subscription = bridge.toWorkbench(onMessage);

				return () => { subscription.dispose(); };
			}
		});
	}).catch((error: unknown) => { paneLog.error("workbench hub uplink failed", { "error": errText(error) }); });
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

	// One timed span for the whole boot; its child logs (relayed to the host) read as an indented tree of
	// what booting the workbench did and how long it took. Ended once monaco is online.
	const bootSpan = paneLog.span("workbench-boot", { "files": files.length, "openEditors": openEditors.length });
	// The zen-fs workspace store, mounted after boot; its `has` probe lets ATA skip already-present files.
	let workspaceFs: WorkspaceFs | undefined;

	bootWithFallbackViewport(document.documentElement);

	boot({
		"parts": parts,
		"files": files,
		"openEditors": openEditors,
		"workspaceFolder": workspaceFolder,
		"configuration": configuration,
		"keybindings": keybindings,
		"onSave": (path, contents) => {
			workbenchHub.publish("workbench.save", { "path": path, "contents": contents });
			paneLog.info("saved", { "path": path, "bytes": contents.length });
		}
	})
		.then(async () => {
			bootSpan.info("monaco booted");
			// zen-fs unification (M0): back the workspace with a zen-fs-backed FileSystemProvider the type-checker
			// reads through (priority 2, above the boot seed). Additive for now — proves the mechanism; later
			// milestones make it the sole store. See workspace-fs.ts.
			workspaceFs = await installWorkspaceFs(files, paneLog).catch((error: unknown) => {
				bootSpan.error("workspace zen-fs failed", { "error": errText(error) });

				return undefined;
			});
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

			// encodeURIComponent, NOT base64: btoa throws on any non-Latin1 codepoint, which the UNMINIFIED code
			// carries (comments/strings) in a local build — aborting boot before the pod even registers. The other
			// extensions below register the same way; match them.
			ext.registerFileUrl("./extension.js", "data:text/javascript," + encodeURIComponent(helloExtensionCode));
			ext.setAsDefaultApi().catch((error: unknown) => {
				bootSpan.error("setAsDefaultApi failed", { "error": errText(error) });
			});
			ext.getApi().then((api: unknown) => {
				vscodeApi = api;
				// Unblock the debug bridge (window.__editor.ready / .api). See debug-bridge.ts.
				markApiReady(); // let a queued openProject (picker) proceed
				markBridgeReady();
				// The tsval debug preview: a dumb-iframe panel view + the adapter↔surface render bridge. Real DOM
				// (not a webview), so it composites in our coi-serviceworker single-origin harness. See
				// debug-preview-view.ts.
				installDebugPreview(() => vscodeApi);
				// Runtime type acquisition: fetch types for arbitrary imports on demand and write them into the FS,
				// so files beyond the baked demo deps (and later a user-opened folder) type-check. See ata.ts.
				installTypeAcquisition(api as typeof import("vscode"), workspaceFolder ?? "/workspace", moduleVersions ?? {}, (path) => workspaceFs?.has(path) ?? false, paneLog);
				// The workspace terminal — just-bash on the workspace filesystem, registered as the DEFAULT terminal
				// backend's process factory (so every terminal is this one; no fake). `node` runs in a dedicated
				// worker over the SAME zen-fs, dispatched + observed over the hub. See terminal.ts. One node runner
				// (worker) is shared by every terminal.
				const nodeRunner = createNodeRunner(workbenchHub, workspaceFs?.buffer);

				setTerminalProcessFactory((fire, cwd) => createBashProcess(api as typeof import("vscode"), nodeRunner, fire, cwd));

				// Uplink the extension pod to the page: a workbench hub bridges the pod (via the extension's
				// exported event/function channel — the ext host has no window path) to the top page over the
				// window. pod/worker spans then federate to the page's $sys.log.> collector. See wireWorkbenchHub.
				wireWorkbenchHub(workspaceFs?.buffer);
				// Source Control: browser-git (isomorphic-git over the zen-fs workspace). ONE cosmetic classifier is
					// shared by the vscode SCM viewlet (git-scm) AND the hub git service (git-service) the shell's
					// review panel consumes. Wired here in the workbench realm — BOTH zen-fs and the vscode API live
					// here. See git-scm.ts / git-service.ts / git-engine.ts.
					const cosmeticClassifier = createCosmeticClassifier();

					void installGitScm(api as typeof import("vscode"), paneLog, cosmeticClassifier).catch((error: unknown) => {
						bootSpan.error("git SCM install failed", { "error": errText(error) });
					});
					installGitService(api as typeof import("vscode"), workbenchHub, cosmeticClassifier, paneLog);
					// Comment-annotations: the inline UI consumer of the node-id annotation store (VS Code Comments API
					// as the surface, the .git/bablr-annotations store as the move-stable backing). See git-comments.ts.
					installCommentAnnotations(api as typeof import("vscode"), cosmeticClassifier, paneLog);
					// Fine-grained edit history: records edit-bursts per file into a lazily-loaded Automerge doc, so the
					// changes pane can show your uncommitted work as small chunks (the local tier over git). See
					// edit-history.ts.
					installEditHistory(api as typeof import("vscode"), workbenchHub, cosmeticClassifier, paneLog);
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

			// The eslint extension — a TS server plugin that lints inside tsserver, reusing tsserver's own `ts`
			// (no bundled copy). Registered in the WEB-WORKER host (where tsserver runs) so the ext-host worker's
			// patched fetch/importExt resolves the plugin's extension-file:// probe URIs to the data: URLs below —
			// which is what loads it into the in-browser tsserver. Mirrors the retired preflight ts-plugin wiring.
			const eslintExt = registerExtension(eslintManifest, ExtensionHostKind.LocalWebWorker);

			eslintExt.registerFileUrl("./extension.js", "data:text/javascript," + encodeURIComponent(eslintExtensionCode));

			// The plugin files, named by the `typescriptServerPlugins` contribution in eslint's manifest. tsserver
			// discovers `./node_modules/eslint-ts-plugin/` and imports its `browser` entry's default export.
			const eslintPluginPkg = JSON.stringify({ "name": "eslint-ts-plugin", "version": "0.0.1", "browser": "index.js" });

			eslintExt.registerFileUrl("./node_modules/eslint-ts-plugin/package.json", "data:application/json," + encodeURIComponent(eslintPluginPkg));
			// The plugin itself is a SERVED file (built by eslint.engine.config.ts next to the engine), registered
			// by its URL rather than embedded as a data: blob — its code leaves workbench.js, and tsserver imports
			// it from that URL so its import.meta.url self-locates the sibling engine. (package.json stays a tiny
			// data: URL.)
			const eslintPluginUrl = new URL("./lsp/eslint-ts-plugin.js", location.href).href;

			eslintExt.registerFileUrl("./node_modules/eslint-ts-plugin/index.js", eslintPluginUrl);

			// The capabilities extension — two halves, both INSIDE the tsserver plugin. STATIC: util/silo's findReach.
			// DYNAMIC: the tsval canary, reusing tsserver's own `ts` (the plugin self-locates both served engines via
			// import.meta.url, like eslint). Both publish NATIVE ts.Diagnostics (source "capabilities"); extension.ts
			// renders the "Capability calls" panel by READING those diagnostics back — no canary code in the ext host.
			const capabilitiesExt = registerExtension(capabilitiesManifest, ExtensionHostKind.LocalWebWorker);

			capabilitiesExt.registerFileUrl("./extension.js", "data:text/javascript," + encodeURIComponent(capabilitiesExtensionCode));

			const capabilitiesPluginPkg = JSON.stringify({ "name": "capabilities-ts-plugin", "version": "0.0.1", "browser": "index.js" });

			capabilitiesExt.registerFileUrl("./node_modules/capabilities-ts-plugin/package.json", "data:application/json," + encodeURIComponent(capabilitiesPluginPkg));

			const capabilitiesPluginUrl = new URL("./lsp/capabilities-ts-plugin.js", location.href).href;

			capabilitiesExt.registerFileUrl("./node_modules/capabilities-ts-plugin/index.js", capabilitiesPluginUrl);

			bootSpan.info("extensions registered", { "extensions": ["hello", "worker-pod", "eslint", "capabilities"] });
			// Tell the host the workbench is up (readiness gating), then close the boot span (its duration
			// is the time-to-online, relayed to the host console).
			workbenchHub.publish("workbench.online");
			bootSpan.end();
		})
		.catch((error: unknown) => {
			bootSpan.error("workbench boot failed", { "error": errText(error) });
			bootSpan.end();
		});
}

// Workspace from the host: request it over the hub (retried until the serve's interest has settled across the
// freshly-linked window transport), then boot. Linking the hub above is itself the announce — the host retargets to
// this window on the first frame — so there's no separate "ready" ping.
const paneRpc = createRpcClient(workbenchHub);

void (async () => {
	for (;;) {
		try {
			const data = await paneRpc.request("workbench.init", undefined, { "timeoutMs": 1500 }) as Init;

			init = { "files": data.files ?? [], "openEditors": data.openEditors ?? [], "workspaceFolder": data.workspaceFolder, "moduleVersions": data.moduleVersions };
			maybeBoot();

			return;
		} catch {
			await new Promise((resolve) => { setTimeout(resolve, 250); });
		}
	}
})();

// A live project switch (the LHS picker → host) arrives as a publish; write + focus it into the running workbench.
workbenchHub.subscribe("workbench.openProject", (data) => {
	const project = data as { "files"?: { "path": string; "contents": string }[]; "openEditors"?: string[] };

	void openProject(project.files ?? [], project.openEditors ?? []);
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

// The hub link + the `workbench.init` request above are the whole handshake now; nothing else to announce.
paneLog.info("pane ready", { "pane": paneId });
