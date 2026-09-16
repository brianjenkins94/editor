/** @jsxImportSource preact */
/**
 * VS Code workbench mounted inside a WebAwesome window, in an <iframe>.
 *
 * The workbench runs inside an <iframe> (its own document) so monaco taking over `document.body` never
 * touches the host page. The iframe loads `/__vscode__/host.html?pane=editor`, which runs the entry
 * (workbench.js). The iframe lives in the body of a draggable/collapsible window (window.ts) — the window's
 * definite-height body gives the iframe a laid-out box to measure at boot (what the old full-viewport
 * `position: fixed; inset: 0` mount was for).
 *
 * Host ⇄ pane talk rides ONE hub link over a retargeting window transport (pane-link.ts): the entry requests
 * `workbench.init` (RPC) → we serve the workspace `files`/`openEditors`; it publishes `workbench.save` (→ `onSave`)
 * and `workbench.online` when monaco is up (→ whenReady). The transport tracks the pane's live window, so once the
 * editor can be popped out these messages reach the popped window with no change here. The host app must only call
 * this once `crossOriginIsolated` is true (SharedArrayBuffer).
 *
 * Every pane's structured logs are funnelled back here (logging.ts) so the host console is the one place to
 * read what the editor did — including after it's popped into its own tab.
 *
 * Singleton — monaco-vscode-api is one global workbench; subsequent calls are no-ops.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import { serve } from "@brianjenkins94/hub";
import { hostLog } from "./logging";
import { windowServerTransport } from "./pane-link";
import { createPaneWindow } from "./window";
import "./webawesome";

/** The workbench pane's stable id — travels in the iframe URL (`?pane=`) so it survives a popout reload. */
const PANE_ID = "editor";

export interface VscodeWindowOptions {
	/** Files to seed the workbench with. */
	"files"?: WorkbenchFile[];
	/** Files (by path) opened on first layout. */
	"openEditors"?: string[];
	/** Workspace folder the files live under (shown as the explorer root, e.g. "/workspace"). */
	"workspaceFolder"?: string;
	/** Package version map (name → version). When set, node_modules resolves lazily from the unpkg CDN
	 *  overlay (go-to-definition into deps); type-checking still uses the synchronously-seeded files. */
	"moduleVersions"?: Record<string, string>;
	/** Called in *this* document when a document is saved in the workbench. */
	"onSave"?: (path: string, contents: string) => void;
	/** Where to mount the workbench window. Default: document.body. */
	"mountInto"?: HTMLElement;
	/** Fill `mountInto` directly (no draggable window chrome) — used when the editor is slotted into the outer
	 *  shell's middle space. Default false: the standalone, poppable WebAwesome window. */
	"fill"?: boolean;
	/** The page's root hub — REQUIRED in practice: the workbench boots over it (we serve `workbench.init`), and the
	 *  pane's hub (extension pod + workers) federates into it for spans. The link retargets to the pane's live
	 *  window on popout. Typed optional only to keep the options bag ergonomic; omitting it throws. */
	"rootHub"?: Hub;
}

/** A file to write when opening a project into the live workbench (path + contents). */
export interface ProjectFile { "path": string; "contents": string }

/** Handle returned by createVscodeWindow for talking to the workbench after it's mounted. */
export interface VscodeWindowHandle {
	/** Resolves once the workbench has actually booted (monaco mounted), for readiness gating. */
	"whenReady": Promise<void>;
	/** Open a project into the ALREADY-BOOTED workbench: write `files` into the workspace and focus `openEditors`.
	 *  Waits for readiness internally, so a call made before boot still lands. Drives the LHS picker. */
	"openProject": (files: ProjectFile[], openEditors: string[]) => void;
}

let booted = false;

export function createVscodeWindow(options: VscodeWindowOptions = {}): VscodeWindowHandle {
	if (booted) {
		return { "whenReady": Promise.resolve(), "openProject": () => { /* singleton already booted elsewhere */ } };
	}

	booted = true;

	// (Pane logs now federate onto the hub → the root $sys.log.> collector; no separate window-relay aggregator.)
	const span = hostLog.span("editor-window");

	let markReady: () => void;
	const whenReady = new Promise<void>((resolve) => {
		markReady = resolve;
	});

	const { files = [], openEditors = [], workspaceFolder, moduleVersions, onSave, mountInto = document.body, rootHub, fill = false } = options;
	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

	const iframe = document.createElement("iframe");

	// Explicit host page (not the directory root): monaco's own dist/index.html is the webview pre-page, so
	// the workbench host ships as host.html alongside it. `?pane` gives the entry its identity from the URL,
	// so a popped-out reload still announces as the same pane (the pane-link channel; see pane-link.ts).
	iframe.src = base + "__vscode__/host.html?pane=" + PANE_ID;

	// Two mount modes. FILL (embedded in the outer shell): the editor IS the middle space, so the iframe fills
	// `mountInto` directly — no draggable window chrome. WINDOWED (standalone /): a large, centered, poppable
	// WebAwesome window, the editor's shape today. Either way the iframe + pane bus below are identical.
	if (fill) {
		iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
		mountInto.style.height ||= "100%";
		mountInto.appendChild(iframe);
		span.info("workbench mounted (fill)", { "pane": PANE_ID });
	} else {
		const paneWindow = createPaneWindow({
			"title": "Editor",
			"storageKey": PANE_ID,
			"width": Math.min(1200, window.innerWidth - 80),
			"height": Math.min(760, window.innerHeight - 120)
		});

		paneWindow.body.appendChild(iframe);
		mountInto.appendChild(paneWindow.element);
		span.info("workbench window mounted", { "pane": PANE_ID });
	}

	// ONE hub link carries everything host ⇄ pane — the boot handshake AND the pod/worker span federation — over a
	// retargeting window transport that re-pairs to the pane's live window on popout (pane-link.ts). rootHub is
	// required: the workbench boots from the `workbench.init` we serve below.
	if (rootHub === undefined) {
		throw new Error("createVscodeWindow requires a rootHub — the workbench boots over it");
	}

	const paneHub = rootHub;

	paneHub.link(windowServerTransport(PANE_ID, () => iframe.contentWindow ?? undefined));

	// The pane requests its workspace once linked (RPC, retried on its side until interest settles); serve it.
	serve(paneHub, "workbench.init", () => ({ "files": files, "openEditors": openEditors, "workspaceFolder": workspaceFolder, "moduleVersions": moduleVersions }));

	// The pane announces it's up (→ whenReady) and streams saves back (→ onSave).
	paneHub.subscribe("workbench.online", () => {
		span.end();
		markReady();
	});
	paneHub.subscribe("workbench.save", (data) => {
		const save = data as { "path"?: string; "contents"?: string };

		if (typeof save.path === "string" && typeof save.contents === "string") {
			onSave?.(save.path, save.contents);
		}
	});

	// Open a project into the live workbench: publish the files + entry once it's online (the pane writes them via
	// the vscode FS API and focuses the entry — no reboot). Rides the same hub link, so it follows a popped-out pane.
	const openProject = (projectFiles: ProjectFile[], entryFiles: string[]): void => {
		void whenReady.then(() => {
			paneHub.publish("workbench.openProject", { "files": projectFiles, "openEditors": entryFiles });
		});
	};

	return { "whenReady": whenReady, "openProject": openProject };
}
