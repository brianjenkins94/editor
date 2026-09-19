/**
 * File augmentations — a single auxiliary-bar ("auxpane") view that shows a per-file-type AUGMENTATION for the active
 * editor. An augmentation is a projection of the open file (the BABLR CST is the source of truth; text and these views
 * are both projections of it) rendered beside the code, with clicks that drive the editor.
 *
 * This is the FIRST of many such augmentations, each keyed to a file type — hence the registry shape rather than a
 * one-off view: register `FileAugmentation`s, and the auxpane renders whichever one matches the active document (or a
 * placeholder, with each augmentation's optional bootstrap action, when none matches).
 *
 * Runs INSIDE the workbench iframe (needs the vscode `api` and DOM). Real DOM via `registerCustomView` — not a webview —
 * so it composites under our coi-serviceworker single-origin harness (same reason as debug-preview-view.ts).
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
/* eslint-disable webawesome/no-inline-styles, webawesome/no-css-in-strings, webawesome/prefer-components -- plain DOM aux-bar glue (intrinsic geometry + a bootstrap button), not themeable Web Awesome chrome */
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";

type Api = any;

/** What an augmentation's `render` gets: the vscode api, plus the active editor + document it matched. */
export interface AugmentationContext {
	"api": Api;
	"editor": any;
	"document": any;
}

/** One file-type augmentation: matches a document, renders a projection of it into the auxpane, drives the editor. */
export interface FileAugmentation {
	"id": string;
	"title": string;
	/** True when this augmentation applies to the given document (e.g. by extension or filename). */
	"when": (document: any) => boolean;
	/** Render the projection into `container`; return a disposer that tears down listeners/DOM. */
	"render": (container: HTMLElement, context: AugmentationContext) => { "dispose": () => void };
	/** Optional: offered in the placeholder when nothing matches — a way to create/open a file this augmentation handles. */
	"bootstrap"?: { "label": string; "run": (api: Api) => Promise<void> | void };
}

/** Install the auxpane view and wire it to dispatch among `augmentations` by the active editor's document. */
export function installFileAugmentations(getApi: () => Api, augmentations: FileAugmentation[]): void {
	registerCustomView({
		"id": "editor.fileAugmentation",
		"name": "Augment",
		"order": 2,
		"location": ViewContainerLocation.AuxiliaryBar,
		"renderBody": (container: HTMLElement) => {
			const api = getApi();

			
			container.style.cssText = "height:100%;overflow:auto";

			let active: { "dispose": () => void } | undefined;

			const teardown = (): void => {
				try {
					active?.dispose();
				} catch { /* an augmentation's own dispose threw — drop it and move on */ }

				active = undefined;
				container.replaceChildren();
			};

			const refresh = (): void => {
				teardown();

				const editor = api.window.activeTextEditor;
				const document = editor?.document;
				const match = document === undefined ? undefined : augmentations.find((augmentation) => {
					try {
						return augmentation.when(document);
					} catch {
						return false;
					}
				});

				if (match === undefined || editor === undefined) {
					container.append(placeholder(api, augmentations));

					return;
				}

				active = match.render(container, { "api": api, "editor": editor, "document": document });
			};

			const sub = api.window.onDidChangeActiveTextEditor(() => { refresh(); });

			refresh();

			return { "dispose": (): void => { sub.dispose(); teardown(); } };
		}
	});
}

/** The empty state: a hint plus a button per augmentation that can bootstrap its file. */
function placeholder(api: Api, augmentations: FileAugmentation[]): HTMLElement {
	const wrap = document.createElement("div");

	
	wrap.style.cssText = "padding:12px;font-size:13px;opacity:0.8;display:flex;flex-direction:column;gap:8px";

	const hint = document.createElement("div");

	hint.textContent = "No augmentation for this file. Open a file it handles:";
	wrap.append(hint);

	for (const augmentation of augmentations) {
		if (augmentation.bootstrap === undefined) {
			continue;
		}

		const button = document.createElement("button");

		button.textContent = augmentation.bootstrap.label;
		
		button.style.cssText = "align-self:flex-start;cursor:pointer";
		button.addEventListener("click", () => { void augmentation.bootstrap?.run(api); });
		wrap.append(button);
	}

	return wrap;
}
