/**
 * The right-hand side (packages/vscode/LIVE-VALUES.md): a pane beside every editor showing a file, each entry beside
 * the span of lines it's about. The consumer renders an entry into the element it's handed (`showPane`'s `render`);
 * this frame only places it — and makes Monaco the grid's row sizer: an entry taller than its span gets a view zone
 * after the span's last line as tall as the difference, so the code below moves down by that much and no entry spills
 * onto lines it isn't about. Entries on overlapping spans share one cell, stacked.
 *
 * Hovering an entry marks its span in the editor; the cursor on a line lights the entry about it. Beside the cells, at
 * the pane's left edge, a mark per line the consumer gives (`marks`: a class to style it by, a title), as tall as its
 * line wraps to — coverage's strip, say: the glyph margin stays the breakpoints'.
 *
 * The pane's left edge is a divider you drag (remembered, the same for every editor). Wrapping code wraps at it: while a
 * pane shows and wrapping is wanted, the editor wraps at a column (`wordWrap: "bounded"`) set to the divider's — and
 * View: Toggle Word Wrap (Alt+Z), whose override knows only "on" (wrap at the editor's full width, under the pane) and
 * "off", is taken over for an editor with a pane: it toggles wrapping at the divider instead. Elsewhere it's VS Code's.
 */
import { getService, ICodeEditorService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/monaco";
import { renderMarkdown as renderVsMarkdown } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/markdownRenderer";
import * as monaco from "monaco-editor";
import css from "./pane.css?raw";

/** An entry, about lines `fromLine`–`toLine` (0-based, inclusive, as VS Code's). */
export interface PaneEntry { "id": string; "fromLine": number; "toLine": number }

/** Render `entry` into `element`; what it returns, if anything, is called when the entry goes. */
export type PaneRender = (entry: PaneEntry, element: HTMLElement) => (() => void) | void;

/** A mark beside line `line` (0-based) at the pane's left edge: `kind` its class (the consumer styles it), `title` on
 *  hover. */
export interface PaneMark { "line": number; "kind": string; "title"?: string }

/** Each file's entries, how to render them, and its marks, by URI. */
const panes = new Map<string, { "entries": PaneEntry[]; "render": PaneRender; "marks": PaneMark[] }>();
/** Each editor's frame, while it shows a file with a pane. */
const frames = new Map<monaco.editor.ICodeEditor, Frame>();
let started: Promise<void> | undefined;

const DIVIDER_KEY = "pane.divider";
/** Where the divider is, as a share of the width past the line numbers (undefined: past the longest line). */
let divider = ((): number | undefined => {
	try {
		const stored = Number(localStorage.getItem(DIVIDER_KEY));

		return stored > 0 && stored < 1 ? stored : undefined;
	} catch {
		return undefined; // no storage: the default
	}
})();
const TOGGLE_WORD_WRAP = "editor.action.toggleWordWrap";
/** VS Code's word-wrap toggle keeps its state per model under this key (toggleWordWrap.ts): cleared, it wraps as configured. */
const TRANSIENT_WORD_WRAP = "transientWordWrapState";

interface WrapService { "setTransientModelProperty": (model: monaco.editor.ITextModel, key: string, value: unknown) => void }
let codeEditors: WrapService | undefined;

/** Entries grouped into cells: those whose spans overlap share one (its span, theirs together). */
function cellsOf(entries: PaneEntry[]): { "fromLine": number; "toLine": number; "entries": PaneEntry[] }[] {
	const cells: { "fromLine": number; "toLine": number; "entries": PaneEntry[] }[] = [];

	for (const entry of entries.toSorted((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine)) {
		const last = cells.at(-1);

		if (last !== undefined && entry.fromLine <= last.toLine) {
			last.toLine = Math.max(last.toLine, entry.toLine);
			last.entries.push(entry);
		} else {
			cells.push({ "fromLine": entry.fromLine, "toLine": entry.toLine, "entries": [entry] });
		}
	}

	return cells;
}

interface Cell { "fromLine": number; "toLine": number; "element": HTMLElement; "zone"?: { "id": string; "height": number } }

/** One editor's frame: an overlay widget it lays out as the editor scrolls, lays out and changes, and the view zones
 *  its tall cells need. */
class Frame implements monaco.editor.IOverlayWidget {
	private readonly editor: monaco.editor.ICodeEditor;
	private readonly element = document.createElement("div");
	private readonly listeners: monaco.IDisposable[] = [];
	private readonly resize = new ResizeObserver(() => { this.layout(); });
	private readonly sash = document.createElement("div");
	private readonly strip = document.createElement("div");
	private marks: { "line": number; "element": HTMLElement }[] = [];
	private cells: Cell[] = [];
	private disposers: (() => void)[] = [];
	private marked: string[] = [];
	/** Whether the code wraps (at the divider), and the editor's own wrap options to give back when the pane goes. */
	private wrap: boolean;
	private readonly own: { "wordWrap": unknown; "wordWrapColumn": unknown };
	private applying = false;

	public constructor(editor: monaco.editor.ICodeEditor) {
		this.editor = editor;
		this.element.className = "notes-margin";
		this.sash.className = "notes-margin-sash";
		this.sash.title = "Drag to move the divider";
		this.strip.className = "notes-margin-strip";
		this.element.append(this.sash, this.strip);
		this.sash.addEventListener("pointerdown", (event) => { this.drag(event); });

		const raw = editor.getRawOptions();

		this.own = { "wordWrap": raw.wordWrap, "wordWrapColumn": raw.wordWrapColumn };
		this.wrap = editor.getOption(monaco.editor.EditorOption.wrappingInfo).wrappingColumn !== -1;
		editor.addOverlayWidget(this);
		this.listeners.push(
			editor.onDidScrollChange(() => { this.place(); }),
			editor.onDidLayoutChange(() => { this.place(); }),
			editor.onDidChangeModelContent(() => { this.layout(); }),
			editor.onDidChangeCursorPosition(() => { this.place(); }),
			// The configured wrap re-applied (a settings change), or Alt+Z's override turned on elsewhere: wrap at the
			// divider again.
			editor.onDidChangeConfiguration((event) => {
				if (!this.applying && event.hasChanged(monaco.editor.EditorOption.wrappingInfo)) {
					if (editor.getOption(monaco.editor.EditorOption.wordWrapOverride2) === "on") {
						this.wrap = true;
					}

					this.place();
				}
			})
		);
	}

	/** Alt+Z, for an editor with a pane: wrap at the divider, or don't wrap. */
	public toggleWrap(): void {
		this.wrap = !this.wrap;
		this.place();
	}

	/** Every frame laid out again (the divider moved). */
	public relayout(): void {
		this.layout();
	}

	public getId(): string {
		return "notes-margin";
	}

	public getDomNode(): HTMLElement {
		return this.element;
	}

	public getPosition(): null {
		return null; // placed by `place`
	}

	public show(entries: PaneEntry[], render: PaneRender, marks: PaneMark[] = []): void {
		this.clear();
		this.marks = marks.map((mark) => {
			const element = document.createElement("div");

			element.className = `notes-margin-mark ${mark.kind}`;

			if (mark.title !== undefined) {
				element.title = mark.title;
			}

			this.strip.append(element);

			return { "line": mark.line, "element": element };
		});
		this.cells = cellsOf(entries).map((cell) => {
			const element = document.createElement("div");

			element.className = "notes-margin-cell";

			for (const entry of cell.entries) {
				const item = document.createElement("div");

				item.className = "notes-margin-entry";
				item.addEventListener("mouseenter", () => { this.mark(entry); });
				item.addEventListener("mouseleave", () => { this.mark(undefined); });
				element.append(item);

				const dispose = render(entry, item);

				if (typeof dispose === "function") {
					this.disposers.push(dispose);
				}
			}

			this.element.append(element);
			this.resize.observe(element);

			return { "fromLine": cell.fromLine, "toLine": cell.toLine, "element": element };
		});
		this.layout();
	}

	public dispose(): void {
		this.clear();
		this.resize.disconnect();

		for (const listener of this.listeners) {
			listener.dispose();
		}

		this.editor.removeOverlayWidget(this);
		this.editor.updateOptions(this.own as monaco.editor.IEditorOptions);
	}

	/** Drag the divider: a share of the width past the line numbers, kept for every editor. */
	private drag(start: PointerEvent): void {
		start.preventDefault();
		this.sash.setPointerCapture(start.pointerId);
		this.sash.classList.add("dragging");

		const move = (event: PointerEvent): void => {
			const layout = this.editor.getLayoutInfo();
			const right = layout.width - layout.minimap.minimapWidth - layout.verticalScrollbarWidth;
			const x = event.clientX - (this.editor.getDomNode()?.getBoundingClientRect().left ?? 0);

			divider = Math.min(0.9, Math.max(0.15, (x - layout.contentLeft) / (right - layout.contentLeft)));

			for (const frame of frames.values()) {
				frame.relayout();
			}
		};
		const end = (): void => {
			this.sash.removeEventListener("pointermove", move);
			this.sash.removeEventListener("pointerup", end);
			this.sash.classList.remove("dragging");

			try {
				localStorage.setItem(DIVIDER_KEY, String(divider));
			} catch {
				// no storage: the divider stays where it is until reload
			}
		};

		this.sash.addEventListener("pointermove", move);
		this.sash.addEventListener("pointerup", end);
	}

	/** Wrap at `column` (the divider's) when wrapping's wanted — clearing Alt+Z's override, which would wrap under the
	 *  pane — or not at all when it isn't. */
	private wrapAt(column: number): void {
		const raw = this.editor.getRawOptions();
		const model = this.editor.getModel();
		const wanted: monaco.editor.IEditorOptions = this.wrap ? { "wordWrap": "bounded", "wordWrapColumn": column } : { "wordWrap": "off" };
		const overridden = this.editor.getOption(monaco.editor.EditorOption.wordWrapOverride2) !== "inherit";

		if (raw.wordWrap === wanted.wordWrap && (!this.wrap || raw.wordWrapColumn === column) && !overridden) {
			return;
		}

		this.applying = true;

		try {
			if (overridden && model !== null) {
				codeEditors?.setTransientModelProperty(model, TRANSIENT_WORD_WRAP, null);
			}

			this.editor.updateOptions(wanted);
		} finally {
			this.applying = false;
		}
	}

	private clear(): void {
		for (const dispose of this.disposers) {
			dispose();
		}

		this.disposers = [];
		this.editor.changeViewZones((accessor) => {
			for (const cell of this.cells) {
				if (cell.zone !== undefined) {
					accessor.removeZone(cell.zone.id);
				}
			}
		});

		for (const cell of this.cells) {
			this.resize.unobserve(cell.element);
		}

		this.cells = [];
		this.strip.replaceChildren();
		this.marks = [];
		this.element.replaceChildren(this.sash, this.strip);
		this.mark(undefined);
	}

	/** Mark `entry`'s span in the editor (or none). */
	private mark(entry: PaneEntry | undefined): void {
		this.marked = this.editor.deltaDecorations(this.marked, entry === undefined ? [] : [{ "range": new monaco.Range(entry.fromLine + 1, 1, entry.toLine + 1, 1), "options": { "isWholeLine": true, "className": "notes-margin-marked" } }]);
	}

	/** Size each tall cell's view zone (the code side of the row grows by the difference), then place everything. */
	private layout(): void {
		this.editor.changeViewZones((accessor) => {
			for (const cell of this.cells) {
				// The span's own height: its lines' (each as many rows as it wraps to), not counting the zone after it.
				const span = this.bottomOf(cell.toLine) - this.editor.getTopForLineNumber(cell.fromLine + 1);
				const height = Math.max(0, Math.ceil(cell.element.offsetHeight - span));

				if (cell.zone?.height === height) {
					continue;
				}

				if (cell.zone !== undefined) {
					accessor.removeZone(cell.zone.id);
				}

				cell.zone = height === 0 ? undefined : { "id": accessor.addZone({ "afterLineNumber": cell.toLine + 1, "heightInPx": height, "domNode": document.createElement("div") }), "height": height };
			}
		});
		this.place();
	}

	/** Where everything goes now: the frame at the divider (by default past the longest line, but no further than 60% of
	 *  the way), the code wrapping there if it wraps, each cell beside its span as the editor scrolls, the cursor's lit. */
	/** Where line `line` (0-based) ends: its last wrapped row's bottom, not counting a zone after it. */
	private bottomOf(line: number): number {
		const editor = this.editor as unknown as { "getBottomForLineNumber"?: (line: number, includeViewZones?: boolean) => number };

		return editor.getBottomForLineNumber?.(line + 1, false) ?? this.editor.getTopForLineNumber(line + 1) + this.editor.getOption(monaco.editor.EditorOption.lineHeight);
	}

	private place(): void {
		const model = this.editor.getModel();
		const layout = this.editor.getLayoutInfo();
		const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);

		if (model === null) {
			return;
		}

		let longest = 0;

		for (let line = 1; line <= model.getLineCount(); line += 1) {
			longest = Math.max(longest, model.getLineMaxColumn(line));
		}

		const right = layout.width - layout.minimap.minimapWidth - layout.verticalScrollbarWidth;
		const span = right - layout.contentLeft;
		const left = layout.contentLeft + (divider === undefined ? Math.min((longest + 3) * font.typicalHalfwidthCharacterWidth, span * 0.6) : span * divider);
		const cursor = (this.editor.getPosition()?.lineNumber ?? 0) - 1;

		this.wrapAt(Math.max(20, Math.floor((left - layout.contentLeft) / font.typicalHalfwidthCharacterWidth) - 2));
		Object.assign(this.element.style, { "left": `${left}px`, "width": `${right - left}px`, "height": `${layout.height}px`, "lineHeight": `${this.editor.getOption(monaco.editor.EditorOption.lineHeight)}px` });
		// The editor's own font for code in a note (VS Code's --vscode-editor-font-* aren't defined in here).
		this.element.style.setProperty("--notes-margin-code-font-family", font.fontFamily);
		this.element.style.setProperty("--notes-margin-code-font-size", `${font.fontSize}px`);

		for (const mark of this.marks) {
			const top = this.editor.getTopForLineNumber(mark.line + 1);

			// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: beside its line, as tall as it wraps to
			Object.assign(mark.element.style, { "top": `${top - this.editor.getScrollTop()}px`, "height": `${this.bottomOf(mark.line) - top}px` });
		}

		for (const cell of this.cells) {
			// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: beside its span, as the editor scrolls
			cell.element.style.top = `${this.editor.getTopForLineNumber(cell.fromLine + 1) - this.editor.getScrollTop()}px`;
			cell.element.classList.toggle("lit", cell.fromLine <= cursor && cursor <= cell.toLine);
		}
	}
}

/** Keep each editor's frame to its file's pane, as editors come and go and change files. */
async function start(): Promise<void> {
	const style = document.createElement("style");

	style.textContent = css;
	document.head.append(style);

	const service = await getService(ICodeEditorService);

	codeEditors = service as unknown as WrapService;

	// Alt+Z, taken over for an editor with a pane (see above); anywhere else, VS Code's own.
	const toggle = CommandsRegistry.getCommand(TOGGLE_WORD_WRAP);

	if (toggle !== undefined) {
		CommandsRegistry.registerCommand(TOGGLE_WORD_WRAP, (accessor, ...args: unknown[]) => {
			const editor = (service.getFocusedCodeEditor() ?? service.getActiveCodeEditor()) as unknown as monaco.editor.ICodeEditor | null;
			const frame = editor === null ? undefined : frames.get(editor);

			if (frame === undefined) {
				return toggle.handler(accessor, ...args);
			}

			frame.toggleWrap();

			return undefined;
		});
	}

	const follow = (editor: monaco.editor.ICodeEditor): void => {
		editor.onDidChangeModel(() => { sync(editor); });
		editor.onDidDispose(() => {
			frames.get(editor)?.dispose();
			frames.delete(editor);
		});
		sync(editor);
	};

	for (const editor of service.listCodeEditors()) {
		follow(editor as unknown as monaco.editor.ICodeEditor);
	}

	service.onCodeEditorAdd((editor) => { follow(editor as unknown as monaco.editor.ICodeEditor); });
}

/** An editor's frame, shown or taken down to match its file's pane. */
function sync(editor: monaco.editor.ICodeEditor): void {
	const pane = panes.get(editor.getModel()?.uri.toString() ?? "");
	let frame = frames.get(editor);

	if (pane === undefined) {
		frame?.dispose();
		frames.delete(editor);

		return;
	}

	if (frame === undefined) {
		frame = new Frame(editor);
		frames.set(editor, frame);
	}

	frame.show(pane.entries, pane.render, pane.marks);
}

/** Show `entries` beside every editor showing `uri` (a file URI's string), each rendered by `render` — now and when one
 *  opens it — or, with none, take the pane away. */
export function showPane(uri: string, entries: PaneEntry[] | undefined, render?: PaneRender, marks: PaneMark[] = []): void {
	if (entries === undefined || render === undefined) {
		panes.delete(uri);
	} else {
		panes.set(uri, { "entries": entries, "render": render, "marks": marks });
	}

	started ??= start();
	void started.then(async () => {
		for (const editor of (await getService(ICodeEditorService)).listCodeEditors()) {
			sync(editor as unknown as monaco.editor.ICodeEditor);
		}
	});
}

/** Markdown rendered as VS Code renders it (sanitized: a note may be anyone's), a code block by `codeBlock` if given. */
export function renderMarkdown(text: string, codeBlock?: (languageId: string, value: string) => Promise<HTMLElement>): { "element": HTMLElement; "dispose": () => void } {
	const rendered = renderVsMarkdown({ "value": text }, codeBlock === undefined ? {} : { "codeBlockRenderer": codeBlock });

	return { "element": rendered.element, "dispose": () => { rendered.dispose(); } };
}
