/**
 * Hosted editors: editor tabs whose content is the consumer's own DOM, by slot — e.g. a panel of the page around the
 * workbench dropped into the editor area. Each slot is one editor input (plain DOM in the workbench realm, like the
 * live architecture pane). The consumer renders into the pane's container each time it shows the slot — again after
 * the editor moves to another group or window — and hears when the slot's editor is closed for good.
 */
import type { IEditorGroup } from "@codingame/monaco-vscode-api";
import { getService, IEditorService } from "@codingame/monaco-vscode-api";
import { registerEditorPane, SimpleEditorInput, SimpleEditorPane } from "@codingame/monaco-vscode-api/service-override/tools/views";
import { EditorsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";

export interface HostedEditorOptions {
	/** Render slot `slot` into `container` (the editor showing it); dispose when that editor stops showing it. */
	"render": (slot: string, container: HTMLElement) => { "dispose": () => void };
	/** The slot's editor was closed (not just moved). */
	"onClose": (slot: string) => void;
}

const PANE_ID = "workbench.editors.hosted";
const ICON = { "id": "window" };

let options: HostedEditorOptions | undefined;
/** Each open slot's input — one editor per slot. */
const inputs = new Map<string, HostedEditorInput>();

class HostedEditorPane extends SimpleEditorPane {
	public static readonly ID = PANE_ID;

	public constructor(group: IEditorGroup) {
		super(HostedEditorPane.ID, group);
	}

	public initialize(): HTMLElement {
		const element = document.createElement("div");

		// eslint-disable-next-line webawesome/no-inline-styles -- the pane's fill box for the consumer's content; intrinsic layout, not themeable chrome
		Object.assign(element.style, { "position": "relative", "width": "100%", "height": "100%", "display": "flex", "flexDirection": "column", "overflow": "hidden" });

		return element;
	}

	public async renderInput(input: HostedEditorInput): Promise<{ "dispose": () => void }> {
		return options?.render(input.slot, this.container) ?? { "dispose": () => undefined };
	}
}

class HostedEditorInput extends SimpleEditorInput {
	public readonly slot: string;

	public constructor(slot: string, title: string) {
		super(undefined);
		this.slot = slot;
		this.setName(title);
	}

	public override get typeId(): string {
		return HostedEditorPane.ID;
	}

	public override getIcon(): typeof ICON {
		return ICON;
	}

	public override matches(other: unknown): boolean {
		return other instanceof HostedEditorInput && other.slot === this.slot;
	}

	public override dispose(): void {
		if (inputs.get(this.slot) === this) {
			inputs.delete(this.slot);
			options?.onClose(this.slot);
		}

		super.dispose();
	}
}

let registered = false;

/** Register the hosted editor. Call before `boot()`. Not restored on reload: a slot's content is the consumer's, live,
 *  and gone with the page. */
export function registerHostedEditors(hostedEditorOptions: HostedEditorOptions): void {
	options = hostedEditorOptions;

	if (!registered) {
		registered = true;
		registerEditorPane("hosted-editor-pane", "Hosted", HostedEditorPane, [HostedEditorInput]);
	}
}

/** Open slot `slot`'s editor in the active group — or reveal it where it already is. */
export async function openHostedEditor(slot: string, title: string): Promise<void> {
	const editorService = await getService(IEditorService);
	const input = inputs.get(slot) ?? new HostedEditorInput(slot, title);

	inputs.set(slot, input);
	await editorService.openEditor(input, { "pinned": true });
}

/** Close slot `slot`'s editor, wherever it is. */
export async function closeHostedEditor(slot: string): Promise<void> {
	const input = inputs.get(slot);

	if (input === undefined) {
		return;
	}

	const editorService = await getService(IEditorService);

	// By the input itself: it has no resource to find it by.
	await editorService.closeEditors(editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor === input));
}
