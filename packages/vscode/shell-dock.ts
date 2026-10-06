/**
 * The shell's DOCK — a dockview layout filling the `main` region, so panes can move between the editor and the page
 * around it (golden-layout style). The editor iframe is its one fixed panel; VS Code's new windows dock beside it.
 *
 * VS Code opens an auxiliary window (Move Editor into New Window, an editor dragged out) as a same-origin Window it
 * moves the editor group's live DOM into (BootOptions.openAuxiliaryWindow, in the component). The workbench asks for
 * one over the hub (`dock.openWindow`); we add a panel holding a blank, src-less iframe — its initial about:blank
 * document is same-origin and there from the start — and answer with the frame's name, which the workbench looks up
 * on the top window. From then on the two sides close the window for each other:
 *   • VS Code closes it (its last editor closed, or moved back) by calling the window's `close()`, which the workbench
 *     turns into `dock.closeWindow` → we remove the panel.
 *   • The user closes the panel → we fire `unload` on the frame's window first, which is how VS Code learns a popup
 *     closed: it merges the editors back into the main window.
 *
 * Every panel that holds an iframe renders with dockview's `always` renderer: its content stays put in an overlay
 * the layout positions, instead of being re-parented on each move — a moved iframe reloads, and for the editor or a
 * VS Code window that's the whole workbench or the window's editors.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { AnchoredBox, DockviewApi, DockviewGroupPanel, IContentRenderer, IHeaderActionsRenderer } from "dockview-core";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { DockviewComponent, getPanelData, themeDark, themeLight } from "dockview-core";
import dockviewCss from "dockview:css";
import type { ShellDockHost } from "./dock-host";
import type { PaneWindowFactory } from "./window";
import { SHELL_DOCK_HOST } from "./dock-host";
import { css, globalCss } from "./theme";

/** The editor's panel (and its iframe's) id. */
const EDITOR_PANEL = "editor";
/** Prefix of a VS Code window's panel id and frame name. */
const WINDOW_PREFIX = "vscode-window-";

/** Prefix of a window panel's id (a preview, the tsval render surface — see `window`). */
const PANE_PREFIX = "pane-";
/** The height of a group's tab bar, above a window panel's body. */
const TAB_BAR_HEIGHT = 35;
/** The share of the editor's box, at each edge, left to the dock's edge drops: a panel dropped inside it goes into VS
 *  Code instead. */
const EDGE_MARGIN = 0.12;

// A panel's content box, and the iframe filling it.
const fillCss = css({ "width": "100%", "height": "100%" });
const frameCss = css({ "display": "block", "width": "100%", "height": "100%", "border": 0 });
// A window panel's body: what its owner puts in it fills it (an iframe, or the iframe over DevTools).
const paneBodyCss = css({ "position": "relative", "width": "100%", "height": "100%", "overflow": "hidden", "& > iframe": { "display": "block", "width": "100%", "height": "100%", "border": 0 } });
// The editor's box, and what it shows while a window panel dragged over it would go into a VS Code editor.
const editorBoxCss = css({ "position": "relative" });
const dropHintCss = css({
	"position": "absolute", "inset": "var(--wa-space-s)", "pointerEvents": "none",
	"border": "2px dashed var(--wa-color-brand-fill-loud)", "borderRadius": "var(--wa-border-radius-m)",
	"backgroundColor": "color-mix(in srgb, var(--wa-color-brand-fill-loud) 12%, transparent)",
	"&[hidden]": { "display": "none" }
});
// A window panel's header actions, shown in its group's tab bar while it's the group's active panel.
const paneActionsCss = css({ "display": "flex", "alignItems": "center", "height": "100%", "gap": "var(--wa-space-3xs)", "paddingInline": "var(--wa-space-2xs)" });

// A group's window controls, macOS style — at the head of its tab bar, or a floating window's title bar: grey where
// they do nothing, and in a group that isn't the active one until hovered; their glyphs show on hover. In a title bar
// they're a utility panel's (an inspector's): smaller, to match the bar.
const trafficLightsCss = css({
	"display": "flex", "alignItems": "center", "gap": "8px", "height": "100%", "paddingInline": "12px 8px",
	"& > button": {
		"display": "grid", "placeItems": "center", "width": "12px", "height": "12px", "padding": 0, "border": 0, "borderRadius": "50%",
		"boxShadow": "inset 0 0 0 0.5px rgb(0 0 0 / 0.2)", "color": "rgb(0 0 0 / 0.55)", "cursor": "default"
	},
	"& > button > svg": { "width": "100%", "height": "100%", "opacity": 0 },
	"&:hover > button:enabled > svg": { "opacity": 1 },
	"& > [data-control=close]": { "backgroundColor": "#ff5f57" },
	"& > [data-control=minimize]": { "backgroundColor": "#febc2e" },
	"& > [data-control=zoom]": { "backgroundColor": "#28c840" },
	"& > button:disabled, .dv-inactive-group &:not(:hover) > button": { "backgroundColor": "rgb(128 128 128 / 0.35)", "boxShadow": "none" },
	".dv-floating-titlebar > &": { "gap": "5px", "paddingInline": "6px", "& > button": { "width": "9px", "height": "9px" } }
});
// A floating window's title bar, inspector-height (dockview's is 22px).
const injectDockGlobals = globalCss({ ".dv-floating-titlebar": { "--dv-floating-titlebar-height": "16px" } });

/** The traffic lights' glyphs, on a 12px light. */
const GLYPHS = {
	"close": "<path d=\"M4 4l4 4M8 4l-4 4\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/>",
	"minimize": "<path d=\"M3.5 6h5\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/>",
	"zoom": "<path d=\"M3.5 3.5H7L3.5 7zM8.5 8.5H5L8.5 5z\" fill=\"currentColor\"/>"
};

export interface ShellDock {
	"api": DockviewApi;
	/** The editor iframe, in its fixed panel. Not loaded: the shell points it at the app. */
	"editorFrame": HTMLIFrameElement;
	/** A window as a panel of the dock — floating where the options put it, to be docked anywhere from there. */
	"window": PaneWindowFactory;
}

/** A window panel's parts, made before its panel is added and handed to dockview by the panel's id. */
interface Pane {
	"title": string;
	"body": HTMLElement;
	"actions": HTMLElement;
	"onClose"?: () => void;
	/** Its owner is closing it (`close()`), not the user: don't call `onClose`. */
	"closing": boolean;
	/** Showing in a VS Code editor (see `hostInEditor`): its frame moved there, its panel gone. */
	"hosted": boolean;
	/** The frame it shows in an editor — its body's iframe, while it's there. */
	"frame"?: HTMLIFrameElement;
}


function frameElement(name?: string): HTMLIFrameElement {
	const frame = document.createElement("iframe");

	frame.allow = "cross-origin-isolated";
	frame.className = frameCss();

	if (name !== undefined) {
		frame.name = name;
	}

	return frame;
}

/** A panel's content: one iframe filling it. `onDispose` runs as the panel goes, while the frame is still in the page. */
function frameContent(frame: HTMLIFrameElement, onDispose?: () => void): IContentRenderer {
	const element = document.createElement("div");

	element.className = fillCss();
	element.append(frame);

	return { "element": element, "init": () => undefined, "dispose": () => { onDispose?.(); } };
}

export function createShellDock(host: HTMLElement, hub: Hub): ShellDock {
	const sheet = new CSSStyleSheet();

	sheet.replaceSync(dockviewCss);
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	injectDockGlobals();

	const editorFrame = frameElement();

	editorFrame.title = "editor";

	const editorContent = frameContent(editorFrame);

	editorContent.element.classList.add(editorBoxCss());

	/** VS Code windows VS Code itself is closing — their panel's removal mustn't tell VS Code it closed. */
	const closingFromVscode = new Set<string>();
	let windowCount = 0;
	const panes = new Map<string, Pane>();
	let paneCount = 0;

	/**
	 * A group's traffic lights. Close closes the group, every panel in it. Minimize folds a floating window to its tab
	 * bar, and back. Zoom maximizes a docked group, and fills the dock with a floating window; again, restores either.
	 * A popout group (its own browser window has its own) gets neither of the last two. A floating window's lights
	 * sit in its title bar — dockview's blank drag handle above the tabs, which takes no content of its own — and
	 * come back to the tab bar when it docks.
	 */
	const trafficLights = (group: DockviewGroupPanel): IHeaderActionsRenderer => {
		const element = document.createElement("div");
		const lights = document.createElement("div");
		/** A floating window's box before minimize or zoom changed it, to restore. */
		let restore: AnchoredBox | undefined;
		const light = (control: keyof typeof GLYPHS, onClick: () => void): HTMLButtonElement => {
			// eslint-disable-next-line webawesome/prefer-components -- a 12px coloured dot, not a Web Awesome button
			const button = document.createElement("button");

			button.dataset["control"] = control;
			button.innerHTML = "<svg width=\"12\" height=\"12\" viewBox=\"0 0 12 12\">" + GLYPHS[control] + "</svg>";
			// Not the tab bar's: a press here mustn't start dragging the group.
			button.addEventListener("pointerdown", (event) => { event.stopPropagation(); });
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				onClick();
			});

			return button;
		};
		/** Change a floating window's box, or put back the one it had. Sizes are the ones `position` takes, its border
		 *  not counted — `toJSON`'s count it, so restoring from those would grow the window each time. */
		const toggle = (box: (current: AnchoredBox, border: number) => Partial<AnchoredBox>): void => {
			const floating = component.getFloatingWindowForGroup(group);

			if (floating === undefined) {
				return;
			}

			if (restore === undefined) {
				const { style } = floating.overlay.element;
				const outer = floating.overlay.toJSON();
				const width = Number.parseFloat(style.width);

				restore = { ...outer, "width": width, "height": Number.parseFloat(style.height) };
				floating.position(box(restore, outer.width - width));
			} else {
				floating.position(restore);
				restore = undefined;
			}
		};
		const close = light("close", () => { group.api.close(); });
		// Down to its title and tab bars: the window's height less its group's content.
		const minimize = light("minimize", () => { toggle(({ height }) => ({ "height": height - group.element.querySelector(".dv-content-container")!.getBoundingClientRect().height })); });
		const zoom = light("zoom", () => {
			if (group.api.location.type === "grid") {
				if (group.api.isMaximized()) {
					group.api.exitMaximized();
				} else {
					group.api.maximize();
				}
			} else {
				toggle((_, border) => ({ "top": 0, "left": 0, "width": host.clientWidth - border, "height": host.clientHeight - border }));
			}
		});
		const render = (): void => {
			const { type } = group.api.location;
			const floating = component.getFloatingWindowForGroup(group);
			// The window's own group's: a window holding a nested layout has one title bar, and the rest keep theirs.
			const titleBar = floating?.group === group ? floating.overlay.element.querySelector(":scope > .dv-floating-titlebar") : null;

			(titleBar ?? element).append(lights);

			restore = undefined; // a box from before a move means nothing after it
			minimize.disabled = type !== "floating";
			zoom.disabled = type === "popout";
			zoom.title = type === "grid" ? "Maximize" : "Fill the dock";
		};
		let listener: { "dispose": () => void } | undefined;

		close.title = "Close";
		minimize.title = "Minimize";
		lights.className = trafficLightsCss();
		lights.append(close, minimize, zoom);

		return {
			"element": element,
			"init": () => {
				render();
				listener = group.api.onDidLocationChange(render);
			},
			"dispose": () => {
				listener?.dispose();
				lights.remove();
			}
		};
	};

	const scheme = window.matchMedia("(prefers-color-scheme: dark)");
	const component = new DockviewComponent(host, {
		"theme": scheme.matches ? themeDark : themeLight,
		"floatingGroupBounds": "boundedWithinViewport",
		"createPrefixHeaderActionComponent": trafficLights,
		// A window panel's header actions sit in its group's tab bar, the active panel's showing.
		"createRightHeaderActionComponent": () => {
			const element = document.createElement("div");
			let listener: { "dispose": () => void } | undefined;

			return {
				"element": element,
				"init": ({ api: groupApi, group }) => {
					const render = (): void => {
						const pane = group.activePanel === undefined ? undefined : panes.get(group.activePanel.id);

						element.replaceChildren(...pane === undefined ? [] : [pane.actions]);
					};

					render();
					listener = groupApi.onDidActivePanelChange(render);
				},
				"dispose": () => { listener?.dispose(); }
			};
		},
		"createComponent": ({ id, name }) => {
			if (name === "editor") {
				return editorContent;
			}

			if (name === "pane") {
				const pane = panes.get(id)!;

				return {
					"element": pane.body,
					"init": () => undefined,
					"dispose": () => {
						if (pane.hosted) {
							return; // its frame went into an editor, and the window lives on there
						}

						panes.delete(id);

						if (!pane.closing) {
							pane.onClose?.();
						}
					}
				};
			}

			const frame = frameElement(id);

			return frameContent(frame, () => {
				if (closingFromVscode.delete(id)) {
					return;
				}

				// The user closed the panel: tell VS Code its window went away, while the frame is still in the page.
				frame.contentWindow?.dispatchEvent(new Event("unload"));
			});
		}
	});

	const { "api": api } = component;

	scheme.addEventListener("change", () => { api.updateOptions({ "theme": scheme.matches ? themeDark : themeLight }); });

	const editorPanel = api.addPanel({ "id": EDITOR_PANEL, "component": "editor", "title": "Editor", "renderer": "always" });

	// The editor is the fixed frame of the layout: no tab to drag it away by, and nothing docks INTO its group (the
	// edges around it still take a drop). Its content is VS Code's editor area: a window panel dropped on it goes into a
	// VS Code editor (hostInEditor). That drop is ours, not a dockview drop target's: the editor's frame lives in the
	// `always` renderer's overlay, outside its group's drop target, so a drag over it never reaches the group — but
	// dockview turns off its iframes' pointer events while a panel is dragged, so it reaches the frame's own box.
	editorPanel.group.header.hidden = true;
	editorPanel.group.locked = true;

	const rpc = createRpcClient(hub);
	const hostable = (panelId: string | null | undefined): boolean => panelId !== null && panelId !== undefined && (panes.get(panelId)?.body.querySelector(":scope > iframe") ?? null) !== null;
	const dropHint = document.createElement("div");
	// Only the box's inner part: its margins are the dock's edges, where a panel docks beside the editor instead.
	const intoEditor = (event: DragEvent): boolean => {
		const box = editorContent.element.getBoundingClientRect();
		const marginX = box.width * EDGE_MARGIN;
		const marginY = box.height * EDGE_MARGIN;

		return hostable(getPanelData()?.panelId) && event.clientX > box.left + marginX && event.clientX < box.right - marginX && event.clientY > box.top + marginY && event.clientY < box.bottom - marginY;
	};

	dropHint.className = dropHintCss();
	dropHint.hidden = true;
	editorContent.element.append(dropHint);
	editorContent.element.addEventListener("dragover", (event) => {
		dropHint.hidden = !intoEditor(event);

		if (!dropHint.hidden) {
			event.preventDefault();
		}
	});
	editorContent.element.addEventListener("dragleave", (event) => {
		if (!editorContent.element.contains(event.relatedTarget as Node | null)) {
			dropHint.hidden = true;
		}
	});
	editorContent.element.addEventListener("drop", (event) => {
		dropHint.hidden = true;

		if (intoEditor(event)) {
			event.preventDefault();
			event.stopPropagation(); // not dockview's too
			void hostInEditor(getPanelData()!.panelId!);
		}
	});
	document.addEventListener("dragend", () => { dropHint.hidden = true; }, true);

	/** The workbench's call for a slot (see ShellDockHost) — its reply, or undefined with no workbench to answer. */
	const askWorkbench = async (name: string, args: { "slot": string; "title"?: string }): Promise<boolean> => rpc.request(name, args, { "timeoutMs": 10_000, "waitForResponderMs": 2000 }).then(() => true, () => false);

	/**
	 * Show a window panel in a VS Code editor: the workbench opens a hosted editor for it (by the panel's id), hands
	 * its container over (`attach`), and the panel's frame moves in — a frame moved into another document reloads,
	 * which a preview takes as a reconnect. Only the frame moves: the panel's own chrome (its header actions, a
	 * capability prompt's overlay) is styled for this document and wouldn't be in VS Code's, so it stays here, out
	 * of sight until the panel comes back to the dock.
	 */
	const hostInEditor = async (id: string): Promise<void> => {
		const pane = panes.get(id);
		const frame = pane?.body.querySelector<HTMLIFrameElement>(":scope > iframe");

		if (pane === undefined || frame === null || frame === undefined) {
			return;
		}

		pane.frame = frame;
		pane.hosted = true;

		if (!(await askWorkbench("dock.hostEditor", { "slot": id, "title": pane.title }))) {
			pane.hosted = false;
			pane.body.prepend(frame);

			return;
		}

		api.getPanel(id)?.api.close(); // its dispose keeps the hosted pane
	};

	/** Bring a window panel back from its VS Code editor into the dock, beside the editor. */
	const dockPane = async (id: string): Promise<void> => {
		const pane = panes.get(id);

		if (pane?.hosted !== true || pane.frame === undefined) {
			return;
		}

		pane.hosted = false; // first: its editor closing (below) isn't the user closing the window
		pane.body.prepend(pane.frame);
		api.addPanel({ "id": id, "component": "pane", "title": pane.title, "renderer": "always", "position": { "referencePanel": EDITOR_PANEL, "direction": "right" } });
		await askWorkbench("dock.closeEditor", { "slot": id });
	};

	const dockHost: ShellDockHost = {
		"attach": (slot, element) => {
			const pane = panes.get(slot);

			if (pane?.hosted !== true || pane.frame === undefined) {
				return;
			}

			// Built in the editor's own document, styled inline with VS Code's theme variables: none of this page's
			// classes exist there.
			const doc = element.ownerDocument;
			const bar = doc.createElement("div");
			// eslint-disable-next-line webawesome/prefer-components -- in VS Code's document, where Web Awesome's styles don't reach (a component moved between documents loses its shadow styles)
			const back = doc.createElement("button");

			/* eslint-disable webawesome/no-inline-styles -- in VS Code's document, where the shell's theme classes don't exist: VS Code's own theme variables, inline */
			Object.assign(bar.style, { "display": "flex", "alignItems": "center", "gap": "6px", "flex": "0 0 auto", "padding": "4px 8px", "borderBottom": "1px solid var(--vscode-editorGroup-border, transparent)", "font": "12px var(--vscode-font-family, system-ui)" });
			Object.assign(back.style, { "font": "inherit", "padding": "2px 8px", "border": "0", "borderRadius": "2px", "cursor": "pointer", "color": "var(--vscode-button-secondaryForeground)", "background": "var(--vscode-button-secondaryBackground)" });
			Object.assign(pane.frame.style, { "display": "block", "flex": "1 1 auto", "minHeight": "0", "width": "100%", "border": "0" });
			element.style.background = "var(--vscode-editor-background)";
			/* eslint-enable webawesome/no-inline-styles */
			back.textContent = "Move to dock";
			back.title = "Move " + pane.title + " back into the dock";
			back.addEventListener("click", () => { void dockPane(slot); });
			bar.append(back);
			element.replaceChildren(bar, pane.frame);
		},
		"closed": (slot) => {
			const pane = panes.get(slot);

			if (pane?.hosted !== true) {
				return; // moving back into the dock, or already gone
			}

			panes.delete(slot);

			if (!pane.closing) {
				pane.onClose?.();
			}
		}
	};

	(window as unknown as Record<string, ShellDockHost>)[SHELL_DOCK_HOST] = dockHost;

	serve(hub, "dock.openWindow", (args) => {
		const { bounds } = (args ?? {}) as { "bounds"?: { "x"?: number; "y"?: number; "width"?: number; "height"?: number } };

		windowCount += 1;

		const id = WINDOW_PREFIX + windowCount;

		// An editor dropped outside the workbench asks for the drop point (screen coordinates): float the window there.
		// Otherwise dock it to the right of whatever's there.
		if (bounds?.x !== undefined && bounds.y !== undefined) {
			const origin = host.getBoundingClientRect();
			const width = Math.min(bounds.width ?? 640, origin.width * 0.8);
			const height = Math.min(bounds.height ?? 480, origin.height * 0.8);
			// Wholly inside the dock: a window hanging off its edge would be cut off.
			const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));

			api.addPanel({
				"id": id,
				"component": "vscode-window",
				"title": "Editors",
				"renderer": "always",
				"floating": {
					"x": clamp(bounds.x - window.screenX - origin.left, origin.width - width),
					"y": clamp(bounds.y - window.screenY - origin.top, origin.height - height),
					"width": width,
					"height": height
				}
			});
		} else {
			api.addPanel({ "id": id, "component": "vscode-window", "title": "Editors", "renderer": "always", "position": { "direction": "right" } });
		}

		return { "name": id };
	});

	hub.subscribe("dock.closeWindow", (data) => {
		const name = (data as { "name"?: string } | null)?.name;
		const panel = typeof name === "string" ? api.getPanel(name) : undefined;

		if (name !== undefined && panel !== undefined) {
			closingFromVscode.add(name);
			panel.api.close();
		}
	});

	const paneWindow: PaneWindowFactory = (options) => {
		paneCount += 1;

		const id = PANE_PREFIX + paneCount;
		const body = document.createElement("div");
		const actions = document.createElement("div");
		const pane: Pane = { "title": options.title, "body": body, "actions": actions, "onClose": options.onClose, "closing": false, "hosted": false };

		body.className = paneBodyCss();
		actions.className = paneActionsCss();
		panes.set(id, pane);

		// It opens floating, as the floating windows did — where asked (viewport coordinates), else centred — at the
		// asked size plus the tab bar, all inside the dock.
		const origin = host.getBoundingClientRect();
		const width = Math.min(options.width ?? 640, origin.width * 0.9);
		const height = Math.min((options.height ?? 480) + TAB_BAR_HEIGHT, origin.height * 0.9);
		const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));
		api.addPanel({
			"id": id,
			"component": "pane",
			"title": options.title,
			"renderer": "always",
			"floating": {
				"x": clamp(options.left === undefined ? (origin.width - width) / 2 : options.left - origin.left, origin.width - width),
				"y": clamp(options.top === undefined ? (origin.height - height) / 2 : options.top - origin.top, origin.height - height),
				"width": width,
				"height": height
			}
		});

		return {
			"element": body,
			"body": body,
			"headerActions": actions,
			// The dock sizes a panel; there's no collapsed state.
			"setCollapsed": () => undefined,
			"setBodyHeight": () => undefined,
			// In an editor, it's the editor that's revealed or closed (its panel's gone: looked up each time).
			"show": () => {
				if (pane.hosted) {
					void askWorkbench("dock.hostEditor", { "slot": id, "title": pane.title });
				} else {
					api.getPanel(id)?.api.setActive();
				}
			},
			"close": () => {
				pane.closing = true;

				if (pane.hosted) {
					void askWorkbench("dock.closeEditor", { "slot": id });
				} else {
					api.getPanel(id)?.api.close();
				}
			},
			"dock": () => { void dockPane(id); }
		};
	};

	return { "api": api, "editorFrame": editorFrame, "window": paneWindow };
}
