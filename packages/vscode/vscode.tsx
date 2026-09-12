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
 * Host ⇄ pane talk goes over the pane bus (pane-bus.ts), which carries the workbench handshake as its
 * payload: the entry signals "ready" → we send it the workspace `files`/`openEditors`; it posts "save" back
 * with the edited path + contents (→ `onSave`) and "online" when monaco is up (→ whenReady). The bus tracks
 * the pane's live window, so once the editor can be popped out these same messages reach the popped window
 * with no change here. The host app must only call this once `crossOriginIsolated` is true (SharedArrayBuffer).
 *
 * Every pane's structured logs are funnelled back here (logging.ts) so the host console is the one place to
 * read what the editor did — including after it's popped into its own tab.
 *
 * Singleton — monaco-vscode-api is one global workbench; subsequent calls are no-ops.
 */
import type { Hub } from "@brianjenkins94/hub";
import { portTransport } from "@brianjenkins94/hub";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import { hostLog } from "./logging";
import { createPaneBusHost } from "./pane-bus";
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
	/** The page's root hub. When given, the workbench pane's hub (the extension pod + its workers) is linked
	 *  into it, so pod/worker spans federate to the root collector. Re-linked to the pane's CURRENT window on
	 *  every "ready" (so it follows a popout, exactly as the pane bus does). */
	"rootHub"?: Hub;
}

/** Handle returned by createVscodeWindow for talking to the workbench after it's mounted. */
export interface VscodeWindowHandle {
	/** Resolves once the workbench has actually booted (monaco mounted), for readiness gating. */
	"whenReady": Promise<void>;
}

interface PaneMessage { "type"?: string; "path"?: string; "contents"?: string }

let booted = false;

export function createVscodeWindow(options: VscodeWindowOptions = {}): VscodeWindowHandle {
	if (booted) {
		return { "whenReady": Promise.resolve() };
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
	// so a popped-out reload still announces as the same pane (see pane-bus.ts).
	iframe.src = base + "__vscode__/host.html?pane=" + PANE_ID;

	// A large, centered window — the editor is the primary content, just no longer welded to the viewport.
	const paneWindow = createPaneWindow({
		"title": "Editor",
		"storageKey": PANE_ID,
		"width": Math.min(1200, window.innerWidth - 80),
		"height": Math.min(760, window.innerHeight - 120)
	});

	paneWindow.body.appendChild(iframe);
	mountInto.appendChild(paneWindow.element);
	span.info("workbench window mounted", { "pane": PANE_ID });

	// The pane bus routes to the pane's CURRENT window (iframe now, popped-out window later) and tracks it
	// from every inbound message, so the handshake below is unchanged when the editor gains a popout.
	const bus = createPaneBusHost();

	bus.register(PANE_ID, iframe);

	// Link the page's root hub to the pane over a DEDICATED MessagePort (transferred to the pane's current
	// window), so the extension pod's spans federate to the root collector. A port (not windowTransport) so
	// interest queues instead of racing a not-yet-listening peer — the same reason the SW link uses a port.
	// Re-done on every "ready" (initial + popout re-announce): the pane bus has just recorded the live window,
	// and a popped-out pane re-announces, so it gets a fresh port for free.
	let unlinkPaneHub: (() => void) | undefined;
	const linkPaneHub = (): void => {
		const win = bus.windowFor(PANE_ID);

		if (rootHub !== undefined && win !== undefined) {
			unlinkPaneHub?.();

			const channel = new MessageChannel();

			win.postMessage({ "__hubPort": true }, "*", [channel.port2]);
			unlinkPaneHub = rootHub.link(portTransport(channel.port1));
		}
	};

	bus.on((id, payload) => {
		if (id !== PANE_ID) {
			return;
		}

		const data = payload as PaneMessage;

		if (data.type === "ready") {
			bus.post(PANE_ID, { "type": "init", "files": files, "openEditors": openEditors, "workspaceFolder": workspaceFolder, "moduleVersions": moduleVersions });
			linkPaneHub();
			span.info("pane ready → sent init", { "files": files.length, "openEditors": openEditors.length });
		} else if (data.type === "save" && typeof data.path === "string" && typeof data.contents === "string") {
			onSave?.(data.path, data.contents);
		} else if (data.type === "online") {
			span.end();
			markReady();
		}
	});

	return { "whenReady": whenReady };
}
