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
import type { DockviewApi, IContentRenderer } from "dockview-core";
import { serve } from "@brianjenkins94/hub";
import { createDockview, themeDark, themeLight } from "dockview-core";
import dockviewCss from "dockview:css";
import { css } from "./theme";

/** The editor's panel (and its iframe's) id. */
const EDITOR_PANEL = "editor";
/** Prefix of a VS Code window's panel id and frame name. */
const WINDOW_PREFIX = "vscode-window-";

// A panel's content box, and the iframe filling it.
const fillCss = css({ "width": "100%", "height": "100%" });
const frameCss = css({ "display": "block", "width": "100%", "height": "100%", "border": 0 });

export interface ShellDock {
	"api": DockviewApi;
	/** The editor iframe, in its fixed panel. Not loaded: the shell points it at the app. */
	"editorFrame": HTMLIFrameElement;
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

	const editorFrame = frameElement();

	editorFrame.title = "editor";

	/** VS Code windows VS Code itself is closing — their panel's removal mustn't tell VS Code it closed. */
	const closingFromVscode = new Set<string>();
	let windowCount = 0;

	const scheme = window.matchMedia("(prefers-color-scheme: dark)");
	const api = createDockview(host, {
		"theme": scheme.matches ? themeDark : themeLight,
		"floatingGroupBounds": "boundedWithinViewport",
		"createComponent": ({ id, name }) => {
			if (name === "editor") {
				return frameContent(editorFrame);
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

	scheme.addEventListener("change", () => { api.updateOptions({ "theme": scheme.matches ? themeDark : themeLight }); });

	const editorPanel = api.addPanel({ "id": EDITOR_PANEL, "component": "editor", "title": "Editor", "renderer": "always" });

	// The editor is the fixed frame of the layout: no tab to drag it away by, nothing docks INTO its group (VS Code's
	// own editors are where tabs go), but the edges around it still take a drop.
	editorPanel.group.header.hidden = true;
	editorPanel.group.locked = true;

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

	return { "api": api, "editorFrame": editorFrame };
}
