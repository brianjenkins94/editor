/**
 * Hosting for the live architecture diagram: an editor pane (plain DOM in the workbench realm, not a webview) and
 * the command that opens it. The diagram itself is the consumer's (`render`) — this only wires it into the workbench.
 */
import type { IEditorGroup } from "@codingame/monaco-vscode-api";
import type { IInstantiationService } from "@codingame/monaco-vscode-api";
import type { IEditorSerializer } from "@codingame/monaco-vscode-views-service-override";
import { createInstance, IEditorService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry, MenuId, MenuRegistry } from "@codingame/monaco-vscode-api/monaco";
import { registerEditorPane, registerEditorSerializer, SimpleEditorInput, SimpleEditorPane } from "@codingame/monaco-vscode-views-service-override";

export const OPEN_ARCHITECTURE_COMMAND = "architecture.open";

export interface LiveArchitectureOptions {
	/** Render the diagram into `container`; dispose when the pane closes. */
	"render": (container: HTMLElement) => { "dispose": () => void };
}

const ICON = { "id": "type-hierarchy" };
const PANE_ID = "workbench.editors.liveArchitecture";

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

/** Register the pane and its command ("Developer: Open Live Architecture Diagram"). Call before `boot()`, so a
 *  restored diagram tab finds its serializer. */
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
}
