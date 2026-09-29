/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the <Workbench/> shell, then boots monaco into the resolved part containers once the host
 * page has sent the workspace (files/openEditors) over postMessage. On save, it posts the edited path
 * + contents back to the host. `boot`/`registerExtension`/`registerFileSystemOverlay` come from the
 * pre-built monaco-vscode-api bundle, kept external and mapped to the sibling `./main.js`.
 *
 * The hello extension (extensions/hello) is the product extension: registered as browser CJS by the URL of its served
 * bundle, it is also the default API context, so the activity bar can execute `workbench.view.*`
 * commands through its `vscode` API. Filesystem overlays (CDN node_modules now, real-disk FSA later) layer UNDER the seeded snapshot —
 * they answer only paths the in-memory FS misses, falling through on FileNotFound.
 */
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import { createHub, createRpcClient, serve } from "@brianjenkins94/hub";
import { boot, ExtensionHostKind, installMonacoProbes, registerExtension, OPEN_ARCHITECTURE_COMMAND, registerFileSystemOverlay, registerLiveArchitecture, setTerminalProcessFactory } from "@brianjenkins94/monaco-vscode-api/main";
import { render } from "preact";
// The hello extension: its package.json manifest + its bundled CJS code (from the `hello:extension`
// virtual module in entry.config.ts).
import type { PodBridge } from "./extensions/worker-pod/extension";
import type { WorkspaceFs } from "./workspace-fs";
import capabilitiesExtensionPath from "capabilities:extension";
import settingsDefaults from "editor:settings-defaults";
import eslintExtensionPath from "eslint:extension";
import helloExtensionPath from "hello:extension";
import workerPodExtensionPath from "worker-pod:extension";
import { reportArchitecture } from "./architecture";
import { classifyUrl, identifyWorker } from "./architecture-model";
import { renderArchitectureView } from "./architecture-view";
import { installTypeAcquisition } from "./ata";
import { installDebugBridge, markBridgeReady } from "./debug-bridge";
import { installDebugPreview } from "./debug-preview-view";
import { createEventSheetAugmentation } from "./event-sheet-view";
import { installFileAugmentations } from "./file-augmentations";
import type { VerdictEntry } from "./cosmetic-classifier";
import { createCosmeticClassifier } from "./cosmetic-classifier";
import * as gitEngine from "./git-engine";
import { installEditHistory } from "./edit-history";
import { installGitScm } from "./git-scm";
import { installGitService } from "./git-service";
import { installRunTargets } from "./targets";
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
// Boot milestones on the performance timeline (beside VS Code's own code/* marks), for load investigations.
performance.mark("editor/entry");

interface Init { "files": WorkbenchFile[]; "openEditors": string[]; "workspaceFolder"?: string; "moduleVersions"?: Record<string, string>; "tab"?: string }

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

// The live architecture view: this realm's hub + network, and — installed before boot() creates anything — the
// monaco probes (workers, extension host RPC, webviews). The diagram is the tab a load lands on (opened
// after the initial editors, below), and reopens with "Developer: Open Live Architecture Diagram".
const architecture = reportArchitecture(workbenchHub);

installMonacoProbes(architecture, { "identifyWorker": identifyWorker, "classifyUrl": classifyUrl });
registerLiveArchitecture({ "render": (container) => renderArchitectureView(container, workbenchHub) });

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

// The element VS Code renders its whole workbench into (see Workbench.tsx).
let workbenchContainer: HTMLElement | undefined;
let init: Init | undefined;
let booted = false;

// The per-extension VS Code API, captured once the hello extension resolves. `runCommand` drives the workbench
// through it and reads the latest api, so a command issued early still runs once it's captured.
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
// Editor-owned paths at the workspace root: the shim .d.ts (when the demo needs one), the capability ledger,
// acquired deps, git meta. They survive a `replace` (the editor needs them) and are never sent back to a repo on commit.
const SCAFFOLDING = new Set(["editor-ambient.d.ts", ".silo", "node_modules", ".git"]);

// Root-level managed configs are OVERRIDABLE DEFAULTS (writable in zen-fs; see workspace-fs.ts). A loaded repo's own
// copy always wins — it OVERWRITES in place, because clearWorkspace keeps these (never delete-then-write: the VS Code
// overlay has no copy-up, so once the writable copy is gone the path resolves to the read-only base and a fresh write
// there is rejected). When a repo ships NONE, the reconciliation differs by how the config is read:
//   FALLTHROUGH_DEFAULTS — TS project configs, read by tsserver via the COMPOSITE file service: DELETE the writable
//     copy so the read-only priority-1 base shows through.
//   .gitignore — read straight off zen-fs by isomorphic-git (a priority-1 base would be invisible to it): MATERIALIZE
//     the git default (gitEngine.DEFAULT_GITIGNORE) into zen-fs.
//   ESLINT_CONFIGS — kept overridable so a repo's own is writable; the eslint engine falls back to its BUNDLED flat
//     config (extensions/eslint/engine.ts) when the workspace has none, so there's nothing to materialize; on omit
//     we just drop a stale one. Variants are one concept — a repo providing ANY counts.
// Keep OVERRIDABLE_DEFAULTS in sync with workspace-fs.ts.
const FALLTHROUGH_DEFAULTS = new Set(["tsconfig.json", "jsconfig.json"]);
const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];
const OVERRIDABLE_DEFAULTS = new Set([...FALLTHROUGH_DEFAULTS, ...ESLINT_CONFIGS, ".gitignore"]);

function workspaceRoot(): string {
	return init?.workspaceFolder ?? "/workspace";
}

/** Delete every workspace entry except the editor scaffolding — the "workspace = the repo" reset before a load. */
async function clearWorkspace(root: string): Promise<void> {
	const vscode = vscodeApi;
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));

	for (const [name] of entries) {
		// Keep scaffolding always; keep overridable-default configs so a repo that ships its own can OVERWRITE them
		// in place (openProject prunes the ones the repo omits afterwards, so those fall through to the base).
		if (SCAFFOLDING.has(name) || OVERRIDABLE_DEFAULTS.has(name)) {
			continue;
		}

		await vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": true, "useTrash": false }).then(undefined, () => { /* already gone */ });
	}
}

/** Fire change events for the files in `<workspace>/.vscode/` so the configuration service re-reads them (see the
 *  call site). A no-op when the folder doesn't exist. */
async function announceWorkspaceSettings(vscode: typeof import("vscode"), store: WorkspaceFs | undefined): Promise<void> {
	const dir = workspaceRoot() + "/.vscode";
	const entries: [string, unknown][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)).then((list) => list, () => []);
	// The extension API's Uri IS vscode's URI class in this (local-process) host — the type the provider fires.
	const uris = entries.map(([name]) => vscode.Uri.file(dir + "/" + name)) as unknown as Parameters<WorkspaceFs["announce"]>[0];

	store?.announce(uris);
}

/** Walk the workspace and return every project file (path + bytes), skipping editor scaffolding — the commit source. */
async function collectFiles(root: string): Promise<{ "path": string; "bytes": Uint8Array }[]> {
	const vscode = vscodeApi;
	const out: { "path": string; "bytes": Uint8Array }[] = [];

	const walk = async (dir: string): Promise<void> => {
		for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))) {
			if (dir === root && SCAFFOLDING.has(name)) {
				continue;
			}

			const full = dir + "/" + name;

			if (type === vscode.FileType.Directory) {
				await walk(full);
			} else if (type === vscode.FileType.File) {
				out.push({ "path": full, "bytes": await vscode.workspace.fs.readFile(vscode.Uri.file(full)) });
			}
		}
	};

	await walk(root);

	return out;
}

async function openProject(files: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[], openEditors: string[], replace = false): Promise<void> {
	await apiReady;

	const vscode = vscodeApi;
	const encoder = new TextEncoder();
	const madeDirs = new Set<string>();

	if (replace) {
		await clearWorkspace(workspaceRoot());
	}

	for (const file of files) {
		const dir = file.path.slice(0, file.path.lastIndexOf("/"));

		if (dir.length > 0 && !madeDirs.has(dir)) {
			madeDirs.add(dir);
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)).then(undefined, () => { /* exists */ });
		}

		// Binary files (from a GitHub repo) arrive as bytes; text samples as a string to encode.
		await vscode.workspace.fs.writeFile(vscode.Uri.file(file.path), file.bytes ?? encoder.encode(file.contents ?? ""));
	}

	if (replace) {
		// Reconcile overridable-default configs the loaded repo did NOT provide (the write loop above already
		// overwrote any it DID ship; clearWorkspace kept these so those were in-place overwrites).
		const provided = new Set(files.map((file) => file.path));
		const root = workspaceRoot();
		const providedAtRoot = (name: string): boolean => provided.has(root + "/" + name);
		const dropWritable = (name: string): Promise<void> => vscode.workspace.fs.delete(vscode.Uri.file(root + "/" + name), { "recursive": false, "useTrash": false }).then(undefined, () => { /* not present */ });

		// TS project configs: DELETE so tsserver falls through to the read-only base via the composite file service.
		for (const name of FALLTHROUGH_DEFAULTS) {
			if (!providedAtRoot(name)) {
				await dropWritable(name);
			}
		}

		// .gitignore: isomorphic-git reads zen-fs directly, so MATERIALIZE the git default when the repo omits it
		// (in-place overwrite — clearWorkspace kept it). Matches ensureRepo's first-run default.
		if (!providedAtRoot(".gitignore")) {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(root + "/.gitignore"), encoder.encode(gitEngine.DEFAULT_GITIGNORE));
		}

		// eslint: a repo's own config already overwrote in place; when it ships none, drop any stale variant. Nothing
		// to materialize — the eslint engine falls back to its bundled flat config.
		if (!ESLINT_CONFIGS.some((name) => providedAtRoot(name))) {
			for (const name of ESLINT_CONFIGS) {
				await dropWritable(name);
			}
		}
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

	/* eslint-disable webawesome/no-inline-styles -- fallback viewport dims for an unlaid-out host (0×0), so the workbench can measure at boot; restored below. Intrinsic geometry, not themeable chrome. */
	root.style.width = "1280px";
	root.style.height = "720px";
	/* eslint-enable webawesome/no-inline-styles */

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
	if (booted || workbenchContainer === undefined || init === undefined) {
		return;
	}

	booted = true;
	performance.mark("editor/boot");
	const { files, openEditors, workspaceFolder, moduleVersions, tab } = init;

	// One timed span for the whole boot; its child logs (relayed to the host) read as an indented tree of
	// what booting the workbench did and how long it took. Ended once monaco is online.
	const bootSpan = paneLog.span("workbench-boot", { "files": files.length, "openEditors": openEditors.length });
	// The zen-fs workspace store, mounted after boot; its `has` probe lets ATA skip already-present files.
	let workspaceFs: WorkspaceFs | undefined;

	bootWithFallbackViewport(document.documentElement);

	// SPLIT: boot's priority-1 in-memory overlay carries ONLY the read-only base — managed configs (tsconfig etc.)
	// + the baked type surface (all `readonly`). The writable workspace SOURCE lives solely in the zen-fs overlay
	// (priority 2, installed after boot), so it can be cleared/replaced on a repo load; a priority-1 copy underneath
	// would re-serve files deleted from priority 2 (that was the "demo won't clear on replace" bug). This also makes
	// the base a genuine fall-through DEFAULT layer: a loaded repo that omits its own tsconfig reads the base one.
	// Editors that reference source open POST-boot (in the .then below, after installWorkspaceFs seeds zen-fs) rather
	// than via boot's defaultLayout, which can't read them — the file service isn't up until boot resolves.
	const baseFiles = files.filter((file) => file.readonly === true);

	boot({
		// VS Code lays out the whole workbench — minus the menu bar and title bar: the shell around this iframe is the
		// app's chrome, and the menus are in the command palette (and on Alt).
		"layout": "workbench",
		"container": workbenchContainer,
		"configurationDefaults": {
			"window.menuBarVisibility": "hidden",
			"window.customTitleBarVisibility": "never",
			"window.commandCenter": false,
			"workbench.layoutControl.enabled": false
		},
		// Source Control and Extensions stay off the activity bar: the shell's changes panel is the git UI, and there's no
		// extension management to do. (The Manage menu is hidden too, in Workbench.tsx.)
		"hiddenViewContainers": ["workbench.view.scm", "workbench.view.extensions"],
		// No product name in the status bar's bottom-left corner. The indicator stays, inert: its command stays "" (without
		// one, VS Code would make it a button for a "remote window" menu there's no use for here).
		"windowIndicator": { "label": "", "command": "" },
		"files": baseFiles,
		"openEditors": [],
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
			// The writable workspace: a zen-fs-backed FileSystemProvider the type-checker reads through (priority 2,
			// above boot's now defaults-only priority-1 base). This is the SOLE store for source — it gets the FULL
			// `files` (source + type surface), so the workers/type-checker that attach to this same zen-fs see them,
			// and a repo load can clear/replace it. See workspace-fs.ts.
			workspaceFs = await installWorkspaceFs(files, paneLog, { "hub": workbenchHub, "architecture": architecture }).catch((error: unknown) => {
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

			// Open the initial editors now — deferred from boot's defaultLayout because the source files no longer live
			// in boot's priority-1 seed (that layer now carries only the read-only base). They're in the zen-fs overlay
			// seeded just above, so the editor can read them. Empty `files` = open only, don't rewrite (already seeded).
			// openProject self-gates on the vscode API being ready (apiReady, captured below). Then the live architecture
			// diagram, last, so a fresh load lands on it (the source editors sit beside it).
			void (openEditors.length > 0 ? openProject([], openEditors, false) : apiReady)
				.catch((error: unknown) => { bootSpan.error("initial open failed", { "error": errText(error) }); })
				.then(() => { runCommand(OPEN_ARCHITECTURE_COMMAND); });

			// The editor's settings DEFAULTS — settings-defaults.jsonc, registered as the lowest settings layer (a
			// contributions-only extension: no code, no host). Layers merge per key, so a workspace `.vscode/settings.json`
			// that sets only a theme, or a loaded repo's own, keeps the curated eslint fix-all / format-on-save setup for
			// every key it leaves out, while any key it sets still wins. No `.vscode/` is seeded: it's the user's/repo's.
			registerExtension({
				"name": "editor-defaults",
				"publisher": "brianjenkins94",
				"version": "0.0.1",
				"engines": { "vscode": "*" },
				"contributes": { "configurationDefaults": settingsDefaults }
			});

			// The hello extension — the default API context (so getApi()/runCommand work) + the hello world
			// command. Registered as CJS by the URL of its bundle, served beside this entry (bundledExtension in
			// build.ts), so its code is fetched on activation rather than carried in workbench.js. The other
			// extensions below register the same way.
			const ext = registerExtension(helloManifest, ExtensionHostKind.LocalProcess);

			ext.registerFileUrl("./extension.js", new URL(helloExtensionPath, location.href).href);
			ext.setAsDefaultApi().catch((error: unknown) => {
				bootSpan.error("setAsDefaultApi failed", { "error": errText(error) });
			});
			ext.getApi().then((api: unknown) => {
				vscodeApi = api;
				// Unblock the debug bridge (window.__editor.ready / .api). See debug-bridge.ts.
				markApiReady(); // let a queued openProject (picker) proceed
				markBridgeReady();
				// Workspace settings persisted in the store (a loaded repo's .vscode/, or the user's own) were invisible
				// when the configuration service read them at startup — the store mounts after boot, and restoring it
				// fires no change events. Announce them now so they apply. (Writes after boot fire events themselves.)
				void announceWorkspaceSettings(api as typeof import("vscode"), workspaceFs);
				// The tsval debug preview: a dumb-iframe panel view + the adapter↔surface render bridge. Real DOM
				// (not a webview), so it composites in our coi-serviceworker single-origin harness. See
				// debug-preview-view.ts.
				installDebugPreview(() => vscodeApi, workbenchHub);
					// File augmentations: the auxpane shows a per-file-type projection of the active file. First one is
					// the Event Sheet (a Construct-style projection of the CST) — a 3-column table whose rows jump the
					// editor to the code they map to. See file-augmentations.ts / event-sheet-view.ts.
					installFileAugmentations(() => vscodeApi, [createEventSheetAugmentation(workbenchHub)]);
				// Runtime type acquisition: fetch types for arbitrary imports on demand and write them into the FS,
				// so files beyond the baked demo deps (and later a user-opened folder) type-check. See ata.ts.
				installTypeAcquisition(api as typeof import("vscode"), workspaceFolder ?? "/workspace", moduleVersions ?? {}, (path) => workspaceFs?.has(path) ?? false, paneLog);
				// The workspace terminal — just-bash on the workspace filesystem, registered as the DEFAULT terminal
				// backend's process factory (so every terminal is this one; no fake). `node` runs in a dedicated
				// worker over the SAME zen-fs, dispatched + observed over the hub. See terminal.ts. One node runner
				// (worker) is shared by every terminal.
				const nodeRunner = createNodeRunner(workbenchHub, workspaceFs?.buffer, tab);

				setTerminalProcessFactory((fire, cwd) => createBashProcess(api as typeof import("vscode"), nodeRunner, fire, cwd));

				// Uplink the extension pod to the page: a workbench hub bridges the pod (via the extension's
				// exported event/function channel — the ext host has no window path) to the top page over the
				// window. pod/worker spans then federate to the page's $sys.log.> collector. See wireWorkbenchHub.
				wireWorkbenchHub(workspaceFs?.buffer);
				// Source Control: browser-git (isomorphic-git over the zen-fs workspace). ONE cosmetic classifier is
					// shared by the vscode SCM viewlet (git-scm) AND the hub git service (git-service) the shell's
					// review panel consumes. Wired here in the workbench realm — BOTH zen-fs and the vscode API live
					// here. See git-scm.ts / git-service.ts / git-engine.ts.
					// One classifier, shared by both panes, with its verdict cache persisted through the engine's
					// content-addressed `.git/bablr/` store — so cosmetic/semantic is derived once per content pair and
					// re-read (not re-computed) across refreshes and reloads.
					const cosmeticClassifier = createCosmeticClassifier(workbenchHub, {
						"read": async (before, after) => (await gitEngine.readVerdict(before, after)) as VerdictEntry | null,
						"write": (before, after, entry) => gitEngine.writeVerdict(before, after, entry)
					});

					void installGitScm(api as typeof import("vscode"), paneLog, cosmeticClassifier).catch((error: unknown) => {
						bootSpan.error("git SCM install failed", { "error": errText(error) });
					});
					installGitService(api as typeof import("vscode"), workbenchHub, cosmeticClassifier, paneLog);
					// Run targets: enumerate the repo's runnables (package.json scripts/bins, per package) for the
					// shell's run picker, and run a chosen one in a terminal. See targets.ts.
					installRunTargets(api as typeof import("vscode"), workbenchHub, paneLog);
					// Fine-grained edit history: records edit-bursts per file into a lazily-loaded Automerge doc, so the
					// changes pane can show your uncommitted work as small chunks (the local tier over git). See
					// edit-history.ts.
					installEditHistory(api as typeof import("vscode"), workbenchHub, cosmeticClassifier, paneLog);

					// Editor theme follows the OS, like the shell chrome. `window.autoDetectColorScheme` isn't wired to
					// `prefers-color-scheme` in this monaco-vscode-api build, so drive `workbench.colorTheme` ourselves.
					// The SHELL is the source of truth (it reliably gets prefers-color-scheme changes; an iframe may not),
					// so apply what it publishes on `theme.colorScheme`; also react to this frame's own matchMedia as a
					// real-browser fallback.
					const themeApi = api as typeof import("vscode");
					const applyEditorTheme = (dark: boolean): void => {
						void themeApi.workspace.getConfiguration().update("workbench.colorTheme", dark ? "Default Dark+" : "Default Light+", themeApi.ConfigurationTarget.Global);
					};
					const themeMq = window.matchMedia("(prefers-color-scheme: dark)");

					workbenchHub.subscribe("theme.colorScheme", (data) => { applyEditorTheme((data as { "dark"?: boolean } | null)?.dark ?? themeMq.matches); });
					themeMq.addEventListener("change", () => { applyEditorTheme(themeMq.matches); });
					bootSpan.info("hello extension api captured");
			}).catch((error: unknown) => { bootSpan.error("hello extension setup failed", { "error": errText(error) }); });

			// The LSP host — the manager extension that runs language servers in workers (LSP spine). Registered
			// on the main-thread (LocalProcess) host so it spawns top-level, non-throttled server workers; the
			// server ships inside its own bundle and starts as a Blob-URL module worker (see its extension.ts).
			const workerPodExt = registerExtension(workerPodManifest, ExtensionHostKind.LocalProcess);

			workerPodExt.registerFileUrl("./extension.js", new URL(workerPodExtensionPath, location.href).href);

			// The eslint extension — a TS server plugin that lints inside tsserver, reusing tsserver's own `ts`
			// (no bundled copy). Registered in the WEB-WORKER host (where tsserver runs) so the ext-host worker's
			// patched fetch/importExt resolves the plugin's extension-file:// probe URIs to the data: URLs below —
			// which is what loads it into the in-browser tsserver. Mirrors the retired preflight ts-plugin wiring.
			const eslintExt = registerExtension(eslintManifest, ExtensionHostKind.LocalWebWorker);

			eslintExt.registerFileUrl("./extension.js", new URL(eslintExtensionPath, location.href).href);

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

			capabilitiesExt.registerFileUrl("./extension.js", new URL(capabilitiesExtensionPath, location.href).href);

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

// Workspace from the host: request it over the hub, then boot. The call waits for the host's serve interest to cross
// the freshly-linked window transport (sent before it arrives, a request has nowhere to go and only times out: that
// was 1.5s of every load); the retry is a backstop. Linking the hub above is itself the announce — the host retargets to
// this window on the first frame — so there's no separate "ready" ping.
const paneRpc = createRpcClient(workbenchHub);

void (async () => {
	for (;;) {
		try {
			performance.mark("editor/init-request");
			const data = await paneRpc.request("workbench.init", undefined, { "timeoutMs": 1500, "waitForResponderMs": 10_000 }) as Init;
			performance.mark("editor/init-received");

			init = { "files": data.files ?? [], "openEditors": data.openEditors ?? [], "workspaceFolder": data.workspaceFolder, "moduleVersions": data.moduleVersions, "tab": data.tab };
			maybeBoot();

			return;
		} catch (error) {
			performance.mark("editor/init-retry", { "detail": String(error) });
			await new Promise((resolve) => { setTimeout(resolve, 250); });
		}
	}
})();

// A live project switch (the LHS picker → host) arrives as a publish; write + focus it into the running workbench.
// `replace` (a GitHub repo load) clears the workspace first — the workspace becomes the repo.
//
// COALESCED: the hub delivers a single load as a burst of identical publishes. That's harmless for a plain write
// (idempotent), but a `replace` clears + rewrites the SingleBuffer (SAB) FS each time, and repeated clear/rewrite
// cycles corrupt it ("offset is out of bounds"). So we debounce the burst to ONE run with the latest request.
let pendingProject: { "files"?: { "path": string; "contents"?: string; "bytes"?: Uint8Array }[]; "openEditors"?: string[]; "replace"?: boolean } | undefined;
let projectTimer: ReturnType<typeof setTimeout> | undefined;

workbenchHub.subscribe("workbench.openProject", (data) => {
	pendingProject = data as typeof pendingProject;

	clearTimeout(projectTimer);
	projectTimer = setTimeout(() => {
		const project = pendingProject;

		pendingProject = undefined;

		if (project !== undefined) {
			void openProject(project.files ?? [], project.openEditors ?? [], project.replace ?? false).catch((error: unknown) => { paneLog.error("openProject failed", { "error": errText(error) }); });
		}
	}, 150);
});

// The host asks for the current workspace (for a commit back to GitHub). We hold the FS, so we serve it — every
// project file as bytes, editor scaffolding excluded.
serve(workbenchHub, "workbench.files", () => collectFiles(workspaceRoot()));

// Dev-only host-page debug bridge (window.__editor). Reads the captured API lazily; no-op off localhost.
installDebugBridge(() => vscodeApi);

render(
	<Workbench
		onReady={(container) => {
			performance.mark("editor/container");
			workbenchContainer = container;
			maybeBoot();
		}}
	/>,
	document.body
);

// The hub link + the `workbench.init` request above are the whole handshake now; nothing else to announce.
paneLog.info("pane ready", { "pane": paneId });
