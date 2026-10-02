/**
 * Hosted editors: editor tabs whose content is the consumer's own DOM, by slot — e.g. a panel of the page around the
 * workbench dropped into the editor area.
 *
 * A slot's content doesn't live in its editor pane: VS Code takes an inactive editor's pane out of the document, and
 * an iframe taken out of the document unloads — a hosted page would reload on every tab switch. So, as VS Code does
 * for its own webviews, each slot gets one element of its own in the workbench (fixed, on top of the editor area, under
 * VS Code's menus and widgets), and the pane showing the slot only lays that element over itself while it's visible,
 * and hides it — still loaded — while it isn't. The consumer fills a slot's element once (`render`); it stays put
 * through tab switches and moves between groups, and moves documents only with its editor (into another window).
 */
import type { IEditorGroup } from "@codingame/monaco-vscode-api";
import { getService, IEditorService } from "@codingame/monaco-vscode-api";
import { registerEditorPane, SimpleEditorInput, SimpleEditorPane } from "@codingame/monaco-vscode-api/service-override/tools/views";
import { EditorsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";

export interface HostedEditorOptions {
	/** Fill slot `slot`'s element — once, when its editor first opens. */
	"render": (slot: string, element: HTMLElement) => void;
	/** The slot's editor was closed (not just moved or hidden); its element is gone. */
	"onClose": (slot: string) => void;
}

const PANE_ID = "workbench.editors.hosted";
const ICON = { "id": "window" };

/** A slot's own element, and the pane laying it out now (if any). */
interface Slot {
	"element": HTMLElement;
	"shownBy"?: HostedEditorPane;
}

let options: HostedEditorOptions | undefined;
/** Each open slot's input — one editor per slot. */
const inputs = new Map<string, HostedEditorInput>();
const slots = new Map<string, Slot>();

/** The workbench container of `container`'s window: where a slot's element goes. */
function rootOf(container: HTMLElement): HTMLElement {
	return container.closest<HTMLElement>(".monaco-workbench") ?? container.ownerDocument.body;
}

function hide(slot: Slot): void {
	// eslint-disable-next-line webawesome/no-inline-styles -- hiding a positioned overlay without unloading it; intrinsic layout, not themeable chrome
	slot.element.style.visibility = "hidden";
}

/** Documents whose slots step aside (no pointer events) while something is dragged, so an editor can be dropped onto
 *  the group under them. */
const dragAware = new WeakSet<Document>();

function stepAsideWhileDragging(document: Document): void {
	if (dragAware.has(document)) {
		return;
	}

	dragAware.add(document);

	const set = (value: string): void => {
		for (const slot of slots.values()) {
			// eslint-disable-next-line webawesome/no-inline-styles -- letting a drag pass through the overlay; intrinsic interaction state, not themeable chrome
			slot.element.style.pointerEvents = value;
		}
	};

	document.addEventListener("dragstart", () => { set("none"); }, true);
	document.addEventListener("dragend", () => { set(""); }, true);
	document.addEventListener("drop", () => { set(""); }, true);
}

class HostedEditorPane extends SimpleEditorPane {
	public static readonly ID = PANE_ID;

	private shown: Slot | undefined;
	private frame = 0;
	private view: Window = window;
	private onScreen = false;

	public constructor(group: IEditorGroup) {
		super(HostedEditorPane.ID, group);
	}

	public initialize(): HTMLElement {
		const element = document.createElement("div");

		// eslint-disable-next-line webawesome/no-inline-styles -- the pane's fill box the slot's element is laid over; intrinsic layout, not themeable chrome
		Object.assign(element.style, { "width": "100%", "height": "100%" });

		return element;
	}

	public async renderInput(input: HostedEditorInput): Promise<{ "dispose": () => void }> {
		let slot = slots.get(input.slot);

		if (slot === undefined) {
			const element = this.container.ownerDocument.createElement("div");

			// eslint-disable-next-line webawesome/no-inline-styles -- a fixed overlay laid over the editor pane each frame; intrinsic layout, not themeable chrome
			Object.assign(element.style, { "position": "fixed", "display": "flex", "flexDirection": "column", "overflow": "hidden", "visibility": "hidden" });
			slot = { "element": element };
			slots.set(input.slot, slot);
			options?.render(input.slot, element);
		}

		const shown = slot;

		this.shown = shown;
		shown.shownBy = this;
		this.track();

		return {
			"dispose": () => {
				if (shown.shownBy === this) {
					shown.shownBy = undefined;
					hide(shown);
				}

				if (this.shown === shown) {
					this.shown = undefined;
				}
			}
		};
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.onScreen = visible;

		if (visible) {
			this.track();
		} else if (this.shown?.shownBy === this) {
			hide(this.shown);
		}
	}

	public override dispose(): void {
		this.view.cancelAnimationFrame(this.frame);
		super.dispose();
	}

	/** Lay the slot's element over this pane every frame while it's showing (a pane moves without resizing — a sidebar
	 *  toggled, a sash dragged — so the frame, not a resize, is the signal), into this window's workbench first. */
	private track(): void {
		this.view.cancelAnimationFrame(this.frame);

		// Its window's frames: a pane in another window runs on that window's clock.
		const view = this.container.ownerDocument.defaultView ?? window;

		this.view = view;

		const step = (): void => {
			const slot = this.shown;

			if (slot?.shownBy !== this || !this.onScreen) {
				return;
			}

			if (this.container.isConnected) {
				const root = rootOf(this.container);

				if (slot.element.parentElement !== root) {
					root.append(slot.element); // another window's document: the content moves with it (and reloads)
					stepAsideWhileDragging(root.ownerDocument);
				}

				const box = this.container.getBoundingClientRect();

				// eslint-disable-next-line webawesome/no-inline-styles -- the pane's live geometry; intrinsic layout, not themeable chrome
				Object.assign(slot.element.style, { "left": box.left + "px", "top": box.top + "px", "width": box.width + "px", "height": box.height + "px", "visibility": box.width > 0 && box.height > 0 ? "visible" : "hidden" });
			}

			this.frame = view.requestAnimationFrame(step);
		};

		step();
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
			slots.get(this.slot)?.element.remove();
			slots.delete(this.slot);
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
