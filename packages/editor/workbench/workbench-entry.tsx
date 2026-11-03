/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the <Workbench/> shell, then boots monaco into the resolved part containers once the host
 * page has sent the workspace (files/openEditors) over postMessage. On save, it posts the edited path
 * + contents back to the host. `boot`/`registerExtension`/`registerFileSystemOverlay` come from the
 * pre-built monaco-vscode-api bundle, kept external and mapped to the sibling `./main.js`.
 *
 * the bridge (extensions/bridge) is the bridge, and the one way core reaches VS Code: registered as browser CJS by
 * the URL of its served bundle, it is the default API context, and core's `vscode` API is its (the activity bar runs
 * `workbench.view.*` commands through it). Filesystem overlays (CDN node_modules now, real-disk FSA later) layer UNDER the seeded snapshot —
 * they answer only paths the in-memory FS misses, falling through on FileNotFound.
 */
// (first: a hidden tab's timers kept, before anything takes the realm's own — shared/hidden-timers.ts)
import "../shared/hidden-timers";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { WorkspaceFs } from "./workspace-fs";
// First of what runs, before anything loads Lit: Web Awesome's components here move into VS Code's new windows (theme/documents).
import "theme/documents";
// eslint-disable-next-line perfectionist/sort-imports -- theme/documents above, first on purpose: it has to run before Lit does
import { failureText } from "@brianjenkins94/editor-api/failures";
import { classifyUrl, identifyWorker } from "@brianjenkins94/editor-api/probes";
import { linkRuntime } from "@brianjenkins94/editor-api/runtime";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { boot, ExtensionHostKind, installMonacoProbes, registerExtension, registerFileSystemOverlay, setTerminalProcessFactory } from "@brianjenkins94/monaco-vscode-api/main";
import { isCancellation, observe } from "@brianjenkins94/observability";
import bridgeExtension from "bridge:extension";
import settingsDefaults from "editor:settings-defaults";
import historyExtension from "history:extension";
import { render } from "preact";
import sourceControlExtension from "source-control:extension";
import tsvalExtension from "tsval:extension";
import { NETWORK_PROBES } from "../shared/architecture";
import { reportWorkbenchMetrics } from "../shared/editor-metrics";
import { windowClientTransport } from "../shared/pane-link";
import { architectureStore } from "./architecture-store";
import { installTypeAcquisition } from "./ata";
import { wireWorkbenchHub } from "./bridge-link";
import { installDebugBridge, markBridgeReady, markContributedLoaded } from "./debug-bridge";
import { installDecisions } from "./decisions";
import { installEditorState } from "./editor-state";
import { loadContributedExtensions, registerExtensionFolder } from "./extensions";
import { installGitHistory } from "./git-history";
import { installGitPush } from "./git-push";
import { commitPart, installGitReview } from "./git-review";
import { installGitService } from "./git-service";
import { createNodeModulesProvider } from "./node-modules-provider";
import { createNodeRunner } from "./node-runner";
import { announceWorkspaceSettings, followProjectSwitches, openProject, OVERRIDABLE_DEFAULTS, serveOrigin } from "./project";
import { markReady, whenDebuggerUp } from "./readiness";
import { createBashProcess, serveTerminalState } from "./terminal";
import { installTarballs } from "./tarballs";
import { installTestRuns } from "./test-runs";
import { followSystemTheme, showVsCodeTheme } from "./theme-follow";
import { serveUnpushed } from "./unpushed";
import { pinned, watchVersions } from "./versions";
import { Workbench } from "./Workbench";
import { configuration, keybindings } from "./workspace";
import { installWorkspaceFs } from "./workspace-fs";
import { installWorkspaceTools } from "./workspace-tools";

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
// boot handshake below AND the bridge/worker span federation), and bridges the extension bridge into that same hub
// (wireWorkbenchHub, once the ext host is up). The link's `hello` handshake recovers the lossy-window race the old
// MessagePort was guarding, so no port is needed.
const workbenchHub = createHub({ "id": "workbench" });

workbenchHub.link(windowClientTransport(paneId, host));

// The pane's logger — its spans/records now ride the workbench hub to the root collector (converging the old
// bespoke window log relay onto the hub). Uncaught errors/rejections go through the same logger so they reach
// the collector too. Records published before the port links simply don't federate (the boot span may be an
// early casualty); everything after — saves, diagnostics, errors — arrives.
// Its uncaught errors and its hub + network on $sys.arch ride along (observe).
const { "log": paneLog, architecture } = observe(workbenchHub, { "network": NETWORK_PROBES });

// The live architecture view: this realm's hub + network, and — installed before boot() creates anything — the
// monaco probes (workers, extension host RPC, webviews). The diagram is the tab a load lands on (opened
// after the initial editors, below), and reopens with "Developer: Open Live Architecture Diagram".

// A debugger's worker in the web worker extension host (an extension loaded from outside, editor-contrib's) reaches the
// editor's runtime through the probe there — VS Code leaves its extensions no other way out — linked into this hub, and
// answered as tsval's is (ARCHITECTURE.md, *Extension points* 2: its file calls by the bridge, its servers by the preview) — linked as
// every runtime link is (editor-api's linkRuntime: its own id, carrying only the runtime).
installMonacoProbes(architecture, { "identifyWorker": identifyWorker, "classifyUrl": classifyUrl, "linkRuntime": (port, name, session) => linkRuntime(workbenchHub, port, name, session) });

window.addEventListener("error", (event) => {
	// A benign ResizeObserver notice monaco triggers constantly — not a real fault; don't relay it as an error.
	if (!event.message.includes("ResizeObserver loop")) {
		// With its stack, so its report is named and grouped by where it was thrown, not lumped with every other one
		// without (packages/api's fingerprint falls back to the route).
		paneLog.error("uncaught error", { "message": event.message, "file": event.filename, "line": event.lineno, "stack": stackOf(event.error) });
	}
});
window.addEventListener("unhandledrejection", (event) => {
	const { reason } = event;

	// A cancellation isn't a fault — e.g. VS Code's own unawaited `fetchThreads()` as a debug session stops, which its
	// own error handler ignores. Mark it handled, so the browser doesn't print it as an uncaught error either.
	if (isCancellation(reason)) {
		event.preventDefault();

		return;
	}

	// Capture the STACK, not just the message — a bare message is rarely enough to place a boot-time rejection.
	// Relays to the $sys.log.> collector (debug-mcp). (This is how the workspace-fs fake-URI `e.with` was traced.)
	paneLog.error("unhandled rejection", { "reason": reasonText(reason), "stack": stackOf(reason instanceof ErrorEvent ? reason.error : reason) });
});

/** A thrown value's stack, if it has one — also an error made in another document (a docked window's), which isn't
 *  this realm's `Error`. */
function stackOf(thrown: unknown): string | undefined {
	const stack = (thrown as { "stack"?: unknown } | null | undefined)?.stack;

	return typeof stack === "string" ? stack : undefined;
}

/** What a rejection's reason says: an error's message; a failure event's (a worker's, rejected as it came), with where
 *  — never `[object ErrorEvent]`; else the value. */
function reasonText(reason: unknown): string {
	if (reason instanceof ErrorEvent) {
		return `${reason.message || "a worker failed"}${reason.filename === "" ? "" : ` (${reason.filename}:${reason.lineno})`}`;
	}

	return reason instanceof Error ? reason.message : failureText(reason);
}

/** One of the editor's own extensions (`<name>:extension`: its folder, as build.ts built it, and its manifest), registered
 *  from that folder as any extension is (extensions.ts). */
function builtIn(extension: { "base": string; "manifest": Parameters<typeof registerExtensionFolder>[0] }, kind: ExtensionHostKind): ReturnType<typeof registerExtensionFolder> {
	return registerExtensionFolder(extension.manifest, new URL(extension.base, location.href), kind);
}

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
/** Tells the shell VS Code's colours (set once the workbench is up). */
let publishColors: (() => void) | undefined;

// Core's VS Code API — the bridge's (the bridge's), once it resolves. `runCommand` drives the workbench
// through it and reads the latest api, so a command issued early still runs once it's captured.
// eslint-disable-next-line ts/no-explicit-any
let vscodeApi: any = null;

// Resolves once `vscodeApi` is captured — an `openProject` message (from the shell's picker, over the pane bus)
// may arrive right after "online" but before getApi()'s promise settles, so its handler awaits this.
let markApiReady: () => void;
const apiReady = new Promise<void>((resolve) => {
	markApiReady = resolve;
});

function runCommand(command: string): void {
	const pending = vscodeApi?.commands?.executeCommand(command) as Promise<unknown> | undefined;

	pending?.catch((error: unknown) => {
		console.error("[vscode] command failed", command, failureText(error));
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
	const bootSpan = paneLog.span("editor.workbench.workbench-entry.boot", { "files": files.length, "openEditors": openEditors.length });
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
	// (the overridable defaults among it not read-only there: written again after they're deleted, they go to zen-fs)
	const baseFiles = files.filter((file) => file.readonly === true).map((file) => (OVERRIDABLE_DEFAULTS.has(file.path.slice((workspaceFolder ?? "/workspace").length + 1)) ? { ...file, "readonly": false } : file));

	boot({
		// VS Code lays out the whole workbench — minus the menu bar and title bar: the shell around this iframe is the
		// app's chrome, and the menus are in the command palette (and on Alt).
		"layout": "workbench",
		"container": workbenchContainer,
		"configurationDefaults": {
			"window.menuBarVisibility": "hidden",
			"window.customTitleBarVisibility": "never",
			"window.commandCenter": false,
			"workbench.layoutControl.enabled": false,
			// No change bars in the gutter: their place is the Margin's gutter column (coverage: extensions/margin), and
			// the shell's Changes panel is the git UI.
			"scm.diffDecorations": "none",
			// VS Code 1.142's Modern UI stays on, in its compact density: no gaps between the parts (the layout reserves
			// them in code, so CSS can't take them back) and uppercase view headers, as the workbench looked before. What
			// it changes beyond its settings, the tabs most, Workbench.tsx puts back.
			"window.density.layout": "compact",
			"workbench.experimental.modernUIUppercaseViewHeaders": true
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
			// Web Awesome in this document, on the active VS Code theme (theme/vscode): the workbench's own views draw
			// with <wa-*> components, not CSS of their own.
			publishColors = showVsCodeTheme(workbenchHub);

			// The writable workspace: a zen-fs-backed FileSystemProvider the type-checker reads through (priority 2,
			// above boot's now defaults-only priority-1 base). This is the SOLE store for source — it gets the FULL
			// `files` (source + type surface), so the workers/type-checker that attach to this same zen-fs see them,
			// and a repo load can clear/replace it. See workspace-fs.ts.
			workspaceFs = await installWorkspaceFs(files, paneLog, { "hub": workbenchHub, "architecture": architecture }).catch((error: unknown) => {
				bootSpan.error("workspace zen-fs failed", { "error": errText(error) });

				return undefined;
			});
			markReady("workspace");
			// Filesystem overlays, layered UNDER the seeded snapshot (they only answer paths the in-memory
			// FS misses, falling through on FileNotFound). Registered after boot so the file service is up.
			// The CDN node_modules overlay is the first; a real-disk File System Access overlay will be its
			// sibling here. Priority 0 = below the snapshot.
			// Pinned by the build's own versions until the workspace's are resolved (versions.ts's `pinned`, which each sync
			// keeps up), so a loaded repo's packages load at its versions, not the editor's.
			Object.assign(pinned, moduleVersions);
			registerFileSystemOverlay(0, createNodeModulesProvider(workspaceFolder ?? "/workspace", pinned));

			// Open the initial editors now — deferred from boot's defaultLayout because the source files no longer live
			// in boot's priority-1 seed (that layer now carries only the read-only base). They're in the zen-fs overlay
			// seeded just above, so the editor can read them. Empty `files` = open only, don't rewrite (already seeded).
			// openProject self-gates on the vscode API being ready (apiReady, captured below).
			void apiReady.then(async () => (openEditors.length > 0 ? openProject(vscodeApi, workspaceFolder ?? "/workspace", paneLog, { "openEditors": openEditors }) : undefined))
				.catch((error: unknown) => { bootSpan.error("initial open failed", { "error": errText(error) }); });

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

			// the bridge — the bridge between the core runtime and VS Code, and the ONE way core reaches VS Code: core's
			// vscode API is the bridge's (getApi), so everything core does in VS Code is done as the bridge, and nothing
			// else of core's crosses. It also hosts the language servers (on the main-thread LocalProcess host, so it
			// spawns top-level, non-throttled server workers), the debug adapters, tasks and Source Control. Registered
			// as CJS by the URL of its bundle, served beside this entry (bundledExtension in build.ts), so its code is
			// fetched on activation rather than carried in workbench.js; the other extensions below register the same way —
			// each from its folder, as an extension from outside the editor is (extensions.ts).
			const bridgeExt = builtIn(bridgeExtension, ExtensionHostKind.LocalProcess);

			bridgeExt.setAsDefaultApi().catch((error: unknown) => {
				bootSpan.error("setAsDefaultApi failed", { "error": errText(error) });
			});
			bridgeExt.getApi().then((api: unknown) => {
				vscodeApi = api;
				// Unblock the debug bridge (window.__editor.ready / .api). See debug-bridge.ts.
				markApiReady(); // let a queued openProject (picker) proceed
				markBridgeReady();
				markReady("api");
				// A debug run can start once the debugger is up (readiness.ts).
				whenDebuggerUp(api as typeof import("vscode"), workbenchHub).catch((error: unknown) => { bootSpan.error("the debugger didn't come up", { "error": errText(error) }); });
				// Workspace settings persisted in the store (a loaded repo's .vscode/, or the user's own) were invisible
				// when the configuration service read them at startup — the store mounts after boot, and restoring it
				// fires no change events. Announce them now so they apply. (Writes after boot fire events themselves.)
				void announceWorkspaceSettings(api as typeof import("vscode"), workspaceFolder ?? "/workspace", workspaceFs);
				// Runtime type acquisition: fetch types for arbitrary imports on demand and write them into the FS,
				// so files beyond the baked demo deps (and later a user-opened folder) type-check. See ata.ts.
				installTypeAcquisition(api as typeof import("vscode"), workspaceFolder ?? "/workspace", pinned, (path) => workspaceFs?.has(path) ?? false, paneLog);
				// The versions every package loads at (.silo/versions.json), kept up to the manifests, and what the CDN can't
				// serve installed (versions.ts); and a debug run's packages, as tarballs (tarballs.ts).
				watchVersions(api as typeof import("vscode"));
				installTarballs(api as typeof import("vscode"), workbenchHub);
				// The workspace terminal — just-bash on the workspace filesystem, registered as the DEFAULT terminal
				// backend's process factory (so every terminal is this one; no fake). `node` runs in a dedicated
				// worker over the SAME zen-fs, dispatched + observed over the hub. See terminal/index.ts. One node runner
				// (worker) is shared by every terminal.
				const nodeRunner = createNodeRunner(workbenchHub);

				installEditorState(workbenchHub, api as typeof import("vscode"), paneLog);

				setTerminalProcessFactory((fire, cwd) => createBashProcess(api as typeof import("vscode"), nodeRunner, workbenchHub, fire, cwd));
				// The workspace as an agent works in it — its files read, written, edited, found and searched (workspace-tools.ts;
				// debug-mcp's files_* tools).
				installWorkspaceTools(api as typeof import("vscode"), workbenchHub);
				serveTerminalState(nodeRunner, workbenchHub);

				// Uplink the extension bridge to the page: a workbench hub bridges the bridge (via the extension's
				// exported event/function channel — the ext host has no window path) to the top page over the
				// window. bridge/worker spans then federate to the page's $sys.log.> collector. See wireWorkbenchHub.
				wireWorkbenchHub(api as typeof import("vscode"), workbenchHub, paneLog, workspaceFs?.buffer);
				// The metrics plane: memory by realm, workspace fill, long frames, hub traffic, storage (editor-metrics.ts).
				reportWorkbenchMetrics(workbenchHub, workspaceFs?.buffer, architectureStore(workbenchHub));
				// Git: browser-git (isomorphic-git over the zen-fs workspace), served over the hub (git-service) to the
					// shell's review panel, and VS Code's Source Control view (the source-control extension, by the editor.git.* commands). See
					// git-service.ts / git-engine.ts.
				const git = installGitService(api as typeof import("vscode"), workbenchHub, paneLog, { "part": commitPart });

				// The review: the changes as hunks, committed or discarded in part (git-review.ts).
				installGitReview(workbenchHub, git);
				// Branches, and a branch pulled from or pushed to GitHub through the shell's sign-in (git-push.ts).
				const remote = installGitPush(workbenchHub, paneLog);

				// Diff, log, show and blame, for agents' git tools (git-history.ts).
				installGitHistory(api as typeof import("vscode"), workbenchHub, remote);
				// The repository the workspace is a clone of, for the shell's binding (project.ts); and what only it holds,
				// for Reset (unpushed.ts).
				serveOrigin(workbenchHub);
				serveUnpushed(workbenchHub);
				// What's been decided about a file or a name: the history extension's reading of the ledger and docs (decisions.ts).
				installDecisions(api as typeof import("vscode"), workbenchHub);
				// Tests for agents: which a change reaches, by their traces, and their results as data (test-runs.ts).
				installTestRuns(api as typeof import("vscode"), workbenchHub, git, nodeRunner);

				// The editor's theme follows the system's, as the shell's does (theme-follow.ts).
				followSystemTheme(api as typeof import("vscode"), workbenchHub, () => publishColors?.());
				bootSpan.info("the bridge's vscode api, for core");
			}).catch((error: unknown) => { bootSpan.error("the bridge's setup failed", { "error": errText(error) }); });

			// tsval, the stepping debugger — an extension of its own, in the bridge's host (LocalProcess: it spawns its debug
			// workers top-level, as the bridge does its servers). It reaches the editor as any debugger does: the run contract,
			// and the workspace runtime the bridge exports.
			builtIn(tsvalExtension, ExtensionHostKind.LocalProcess);

			// The rest run in the web worker host, each from its folder with the files its manifest lists: history (its
			// tsserver plugin) and Source Control (on the editor's git). Public API only, but for what ARCHITECTURE.md lists
			// (*Extension points* 3).
			for (const extension of [historyExtension, sourceControlExtension]) {
				builtIn(extension, ExtensionHostKind.LocalWebWorker);
			}

			// And any from outside the editor, by URL — the site's own (`extensions.json`) and `?extension=`'s:
			// editor-contrib's interpreters and renderers (extensions.ts).
			void apiReady.then(() => loadContributedExtensions(vscodeApi as typeof import("vscode"), paneLog)).then(markContributedLoaded);

			bootSpan.info("extensions registered", { "extensions": ["bridge", "tsval", "history", "source-control"] });
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
			await new Promise((resolve) => {
				setTimeout(resolve, 250);
			});
		}
	}
})();

// A live project switch (the shell's repo load → the app → here), written into the running workbench (project.ts).
followProjectSwitches(workbenchHub, async (project) => {
	await apiReady;
	await openProject(vscodeApi, init?.workspaceFolder ?? "/workspace", paneLog, project);
}, paneLog);

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
