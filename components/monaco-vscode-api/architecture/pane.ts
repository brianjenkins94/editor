/**
 * Hosting for the live architecture diagram: an editor pane (plain DOM in the workbench realm, not a webview),
 * the command that opens it, and a walkthrough on the Welcome page pointing at it. The diagram itself is the
 * consumer's (`render`) — this only wires it into the workbench.
 */
import type { IEditorGroup } from "@codingame/monaco-vscode-api";
import type { IInstantiationService } from "@codingame/monaco-vscode-api";
import type { IEditorSerializer } from "@codingame/monaco-vscode-views-service-override";
import { createInstance, IEditorService, IWalkthroughsService } from "@codingame/monaco-vscode-api";
import { registerServiceInitializePostParticipant } from "@codingame/monaco-vscode-api/lifecycle";
import { CommandsRegistry, ContextKeyExpr, MenuId, MenuRegistry } from "@codingame/monaco-vscode-api/monaco";
import { registerEditorPane, registerEditorSerializer, SimpleEditorInput, SimpleEditorPane } from "@codingame/monaco-vscode-views-service-override";
import * as monaco from "monaco-editor";
import previewSvg from "./preview.svg?raw";

export const OPEN_ARCHITECTURE_COMMAND = "architecture.open";

export interface LiveArchitectureOptions {
	/** Render the diagram into `container`; dispose when the pane closes. */
	"render": (container: HTMLElement) => { "dispose": () => void };
}

const ICON = { "id": "type-hierarchy" };
const PANE_ID = "workbench.editors.liveArchitecture";

// The walkthrough's media: a tiny schematic, inlined as a data: URI (the build stubs walkthrough image FILES).
const PREVIEW = "data:image/svg+xml," + encodeURIComponent(previewSvg);

let options: LiveArchitectureOptions | undefined;

class LiveArchitecturePane extends SimpleEditorPane {
	public static readonly ID = PANE_ID;

	public constructor(group: IEditorGroup) {
		super(LiveArchitecturePane.ID, group);
	}

	public initialize(): HTMLElement {
		// Sized by the diagram's own stylesheet (it fills the pane).
		return document.createElement("div");
	}

	public async renderInput(): Promise<{ "dispose": () => void }> {
		return options?.render(this.container) ?? { "dispose": () => undefined };
	}
}

class LiveArchitectureInput extends SimpleEditorInput {
	public constructor() {
		super(undefined);
		this.setName("Live architecture");
	}

	public override get typeId(): string {
		return LiveArchitecturePane.ID;
	}

	public override getIcon(): typeof ICON {
		return ICON;
	}

	public override matches(other: unknown): boolean {
		return other instanceof LiveArchitectureInput;
	}
}

let registered = false;

/** Register the pane, its command ("Developer: Open Live Architecture Diagram") and the Welcome page walkthrough.
 *  Call before `boot()`: the walkthrough must exist before the Welcome page is first built. */
export function registerLiveArchitecture(liveArchitectureOptions: LiveArchitectureOptions): void {
	options = liveArchitectureOptions;

	if (registered) {
		return;
	}

	registered = true;

	registerEditorPane("live-architecture-pane", "Live architecture", LiveArchitecturePane, [LiveArchitectureInput]);
	registerEditorSerializer(LiveArchitecturePane.ID, class implements IEditorSerializer {
		public canSerialize(): boolean {
			return true;
		}

		public serialize(): string {
			return "{}";
		}

		public deserialize(instantiationService: IInstantiationService): LiveArchitectureInput {
			return instantiationService.createInstance(LiveArchitectureInput);
		}
	});

	CommandsRegistry.registerCommand(OPEN_ARCHITECTURE_COMMAND, async (accessor) => {
		const editorService = accessor.get(IEditorService);

		await editorService.openEditor(await createInstance(LiveArchitectureInput), { "pinned": true });
	});
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		"command": { "id": OPEN_ARCHITECTURE_COMMAND, "title": "Open Live Architecture Diagram", "category": "Developer" }
	});

	// Registered once the services exist but BEFORE the workbench renders: a walkthrough registered through the
	// service later doesn't refresh a Welcome page that's already built. (Not an extension `walkthroughs`
	// contribution: monaco-vscode-api's build drops that extension point's handler — fixed upstream, not released.)
	const preview = monaco.Uri.parse(PREVIEW);

	registerServiceInitializePostParticipant(async (accessor) => {
		accessor.get(IWalkthroughsService).registerWalkthrough({
			"id": "editor.liveArchitecture",
			"title": "Live architecture",
			"description": "Every realm, hub, worker and connection of this editor, and the messages flowing between them.",
			"order": 0,
			"source": "editor",
			"isFeatured": true,
			"when": ContextKeyExpr.true(),
			"icon": { "type": "icon", "icon": ICON },
			"walkthroughPageTitle": "Live architecture",
			"steps": [
				{
					"id": "editor.liveArchitecture.open",
					"title": "Explore the live architecture diagram",
					"description": [
						"The shell, the app, the workbench and its extension hosts, the pod, the workers they spawn, the service worker, webviews, storage and the network — and every hub link and channel between them, observed live.",
						"Check the architecture against its model, or debug who talks to whom.",
						"[Open the diagram](command:" + OPEN_ARCHITECTURE_COMMAND + ")"
					].join("\n"),
					"category": "editor.liveArchitecture",
					"when": ContextKeyExpr.true(),
					"order": 0,
					"completionEvents": ["onCommand:" + OPEN_ARCHITECTURE_COMMAND],
					"media": { "type": "image", "altText": "Schema of the editor's realms", "path": { "light": preview, "dark": preview, "hcLight": preview, "hcDark": preview } }
				}
			]
		});
	});
}
