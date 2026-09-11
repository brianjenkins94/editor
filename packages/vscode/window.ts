/**
 * A movable, collapsible window — WebAwesome chrome (`wa-card` with its header / header-actions slots and
 * `wa-button` controls), with only what WA has no primitive for hand-rolled: fixed positioning, pointer-drag
 * geometry, and the collapse toggle. Position + collapsed state persist per `storageKey` in localStorage.
 *
 * Adapted from sms-reference-app/app/src/window.ts's floating gauge, but sized to HOST A PANE: the body is a
 * definite-height box the caller fills with the workbench iframe (an iframe needs a laid-out ancestor to
 * measure at boot — the whole reason vscode.tsx used to pin the iframe to the viewport). Kept minimal on
 * purpose (drag + collapse + close; no resize / snap / maximize) — those are natural follow-ons, as in
 * games/packages/window's VtWindow.
 *
 * The theme tokens the `--wa-*` vars resolve against must be loaded once in this document — import
 * ./webawesome there (the host page does).
 */
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/button/button.js";

export interface PaneWindow {
	readonly "element": HTMLElement;
	/** Put your content (the iframe) here — a definite-height box, so the iframe can measure at boot. */
	readonly "body": HTMLElement;
	"setCollapsed": (collapsed: boolean) => void;
	/** Append to <body> if not already shown. */
	"show": () => void;
}

interface Persisted { "left"?: number; "top"?: number; "collapsed"?: boolean }

let stylesInjected = false;

function injectStyles(): void {
	if (stylesInjected) {
		return;
	}

	stylesInjected = true;

	const style = document.createElement("style");

	style.textContent = `
		.wa-win { position: fixed; z-index: 2147483000; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); color-scheme: light; }
		.wa-win wa-card { width: 100%; --spacing: var(--wa-space-s); }
		.wa-win__bar { display: flex; align-items: center; gap: var(--wa-space-2xs); cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
		.wa-win__bar.dragging { cursor: grabbing; }
		.wa-win__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--wa-font-weight-semibold); }
		.wa-win__actions { display: flex; gap: var(--wa-space-3xs); }
		.wa-win__actions wa-button::part(base) { padding: 0 var(--wa-space-2xs); line-height: 1.4; }
		.wa-win__body { overflow: hidden; }
		.wa-win__body > iframe { display: block; border: 0; width: 100%; height: 100%; }
		.wa-win[data-collapsed] wa-card::part(body) { display: none; }
	`;
	document.head.appendChild(style);
}

function loadState(key: string): Persisted {
	try {
		return JSON.parse(localStorage.getItem("wa-win:" + key) ?? "{}") as Persisted;
	} catch {
		return {};
	}
}

function saveState(key: string, patch: Persisted): void {
	try {
		localStorage.setItem("wa-win:" + key, JSON.stringify({ ...loadState(key), ...patch }));
	} catch {
		/* private mode / disabled */
	}
}

export interface PaneWindowOptions {
	"title": string;
	"storageKey": string;
	/** Window (and body) width in px. Default 960. */
	"width"?: number;
	/** Body height in px (the header sits above it). Default 640. */
	"height"?: number;
	"onClose"?: () => void;
}

export function createPaneWindow(options: PaneWindowOptions): PaneWindow {
	injectStyles();

	const width = options.width ?? 960;
	const height = options.height ?? 640;
	const state = loadState(options.storageKey);

	const win = document.createElement("div");

	win.className = "wa-win";
	win.style.width = width + "px";

	const card = document.createElement("wa-card");

	card.setAttribute("with-header", "");
	card.setAttribute("with-header-actions", "");

	const bar = document.createElement("div");

	bar.className = "wa-win__bar";
	bar.setAttribute("slot", "header");

	const titleEl = document.createElement("span");

	titleEl.className = "wa-win__title";
	titleEl.textContent = options.title;
	titleEl.title = options.title;
	bar.appendChild(titleEl);

	const actions = document.createElement("div");

	actions.className = "wa-win__actions";
	actions.setAttribute("slot", "header-actions");

	const collapseBtn = document.createElement("wa-button");

	collapseBtn.setAttribute("appearance", "plain");
	collapseBtn.setAttribute("size", "s");
	actions.appendChild(collapseBtn);

	if (options.onClose !== undefined) {
		const closeBtn = document.createElement("wa-button");

		closeBtn.setAttribute("appearance", "plain");
		closeBtn.setAttribute("size", "s");
		closeBtn.title = "Close";
		closeBtn.textContent = "✕";
		closeBtn.addEventListener("click", options.onClose);
		actions.appendChild(closeBtn);
	}

	const body = document.createElement("div");

	body.className = "wa-win__body";
	body.style.height = height + "px";

	card.append(bar, actions, body);
	win.appendChild(card);

	const clampLeft = (left: number): number => Math.max(4, Math.min(left, window.innerWidth - win.offsetWidth - 4));
	const clampTop = (top: number): number => Math.max(4, Math.min(top, window.innerHeight - 40));

	win.style.left = clampLeft(state.left ?? Math.max(8, (window.innerWidth - width) / 2)) + "px";
	win.style.top = clampTop(state.top ?? Math.max(8, (window.innerHeight - height) / 2 - 24)) + "px";

	function setCollapsed(collapsed: boolean): void {
		win.toggleAttribute("data-collapsed", collapsed);
		collapseBtn.textContent = collapsed ? "+" : "–";
		collapseBtn.title = collapsed ? "Expand" : "Collapse";
		saveState(options.storageKey, { "collapsed": collapsed });
	}

	collapseBtn.addEventListener("click", () => {
		setCollapsed(!win.hasAttribute("data-collapsed"));
	});
	// The editor is the primary content, so default to open (unlike the sms gauge, which hid itself).
	setCollapsed(state.collapsed ?? false);

	// Drag by the title bar. Pointer capture keeps the gesture even when the cursor outruns it.
	bar.addEventListener("pointerdown", function(event: PointerEvent) {
		if (event.button !== 0) {
			return;
		}

		const rect = win.getBoundingClientRect();
		const offX = event.clientX - rect.left;
		const offY = event.clientY - rect.top;

		bar.setPointerCapture(event.pointerId);
		bar.classList.add("dragging");

		const move = (moveEvent: PointerEvent): void => {
			win.style.left = clampLeft(moveEvent.clientX - offX) + "px";
			win.style.top = clampTop(moveEvent.clientY - offY) + "px";
		};

		const up = (): void => {
			bar.classList.remove("dragging");
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", up);
			saveState(options.storageKey, { "left": parseInt(win.style.left, 10), "top": parseInt(win.style.top, 10) });
		};

		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
	});

	function show(): void {
		if (!win.isConnected) {
			document.body.appendChild(win);
		}
	}

	return {
		"element": win,
		"body": body,
		"setCollapsed": setCollapsed,
		"show": show
	};
}
