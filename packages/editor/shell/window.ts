/**
 * A movable, collapsible window: the theme's `<app-window>` (theme/app-window: its chrome, drag, collapse, and its place
 * and state kept per `storageKey`), with a body of the given size and a row for the caller's header actions.
 *
 * Adapted from sms-reference-app/app/src/window.ts's floating gauge, but sized to HOST A PANE: the body is a
 * definite-height box the caller fills with the workbench iframe (an iframe needs a laid-out ancestor to
 * measure at boot — the whole reason vscode.tsx used to pin the iframe to the viewport). Kept minimal on
 * purpose (drag + collapse + close; no resize / snap / maximize) — those are natural follow-ons, as in
 * games/packages/window's VtWindow.
 *
 * The theme tokens the `--wa-*` vars resolve against must be loaded once in this document — import
 * "theme/chrome" there (the shell does).
 */
// Web Awesome's button first, so the window's controls are its (theme/app-window doesn't register it).
import "theme/components/button";
import { appWindow } from "theme/app-window";

export interface PaneWindow {
	readonly "element": HTMLElement;
	/** Put your content (the iframe) here — a definite-height box, so the iframe can measure at boot. */
	readonly "body": HTMLElement;
	/** A flex row in the titlebar, left of the collapse/close controls — the caller fills it with extra header
	 *  actions (e.g. the preview's debug toolbar). */
	readonly "headerActions": HTMLElement;
	"setCollapsed": (collapsed: boolean) => void;
	/** Resize the body (the window follows it). */
	"setBodyHeight": (height: number) => void;
	/** Append to <body> if not already shown. */
	"show": () => void;
	/** Take the window away (without calling its `onClose`: that's for the user closing it). */
	"close": () => void;
	/** A dock window shown in a VS Code editor: bring it back into the dock, where its own chrome is. */
	"dock"?: () => void;
}

/** Makes a window — a floating one (createPaneWindow) or a panel of the shell's dock (shell-dock.ts). */
export type PaneWindowFactory = (options: PaneWindowOptions) => PaneWindow;

export interface PaneWindowOptions {
	"title": string;
	"storageKey": string;
	/** Window (and body) width in px. Default 960. */
	"width"?: number;
	/** Body height in px (the header sits above it). Default 640. */
	"height"?: number;
	/** Where it opens when it has no position of its own saved (under `storageKey`). Default: centred. */
	"left"?: number;
	"top"?: number;
	"onClose"?: () => void;
}

export function createPaneWindow(options: PaneWindowOptions): PaneWindow {
	// Caller-owned header actions (e.g. the debug toolbar), left of the window's own controls.
	const extras = document.createElement("div");
	const body = document.createElement("div");

	extras.className = "wa-cluster wa-gap-3xs wa-flex-nowrap";

	const win = appWindow({
		"label": options.title,
		"storageKey": options.storageKey,
		"closable": options.onClose !== undefined,
		"width": options.width ?? 960,
		"bodyHeight": options.height ?? 640,
		"headerActions": [extras],
		"children": [body],
		"onClose": options.onClose
	});

	win.initialLeft = options.left;
	win.initialTop = options.top;

	return {
		"element": win,
		"body": body,
		"headerActions": extras,
		"setCollapsed": (collapsed: boolean) => {
			win.collapsed = collapsed;
		},
		"setBodyHeight": (next: number) => {
			win.setAttribute("body-height", String(next));
		},
		"show": () => {
			if (!win.isConnected) {
				document.body.appendChild(win);
			}
		},
		"close": () => {
			win.remove();
		}
	};
}
