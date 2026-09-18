/** @jsxImportSource preact */
/**
 * VS Code workbench mounted in an <iframe> that fills the shell's editor space.
 *
 * The workbench runs inside an <iframe> (its own document) so monaco taking over `document.body` never
 * touches the host page. The iframe loads `/__vscode__/host.html?pane=editor`, which runs the entry
 * (workbench.js). It fills its mount container directly (the shell's middle grid area) — a laid-out box the
 * iframe can measure at boot. (The old poppable WebAwesome window that hosted it is gone; all movable-window
 * chrome — including the preview — now lives in the shell/top frame, so the editor realm carries no WebAwesome.)
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
	/** Where to mount the workbench (the iframe fills this box). Default: document.body. */
	"mountInto"?: HTMLElement;
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

	const { files = [], openEditors = [], workspaceFolder, moduleVersions, onSave, mountInto = document.body, rootHub } = options;
	const base = (import.meta as unknown as { "env"?: Record<string, string | undefined> }).env?.BASE_URL ?? "/";

	const iframe = document.createElement("iframe");

	// Explicit host page (not the directory root): monaco's own dist/index.html is the webview pre-page, so
	// the workbench host ships as host.html alongside it. `?pane` gives the entry its identity from the URL,
	// so a popped-out reload still announces as the same pane (the pane-link channel; see pane-link.ts).
	iframe.src = base + "__vscode__/host.html?pane=" + PANE_ID;

	// The editor IS the shell's middle space: the iframe fills `mountInto` directly, giving it the laid-out box it
	// must measure at boot. (The iframe fill is intrinsic geometry, not chrome — so it's inline style by necessity.)
	// eslint-disable-next-line webawesome/no-inline-styles, webawesome/no-css-in-strings -- an iframe filling its own mount box; not themeable chrome
	iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
	// eslint-disable-next-line webawesome/no-inline-styles -- give the mount box a definite height so the iframe can measure at boot
	mountInto.style.height ||= "100%";
	mountInto.appendChild(iframe);
	span.info("workbench mounted (fill)", { "pane": PANE_ID });

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
