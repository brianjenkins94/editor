/**
 * Live values (packages/vscode/LIVE-VALUES.md): a strip at the right of every editor showing a file, a row beside each
 * line with the values the consumer gives for it — a label, then a value, or a cell per column (a loop's turns) —
 * scrolling with the code. It knows nothing of debuggers: what to draw is the consumer's (`showLiveValues`).
 *
 * Hovering a column lights it on every row, and clicking it holds it; the row at the cursor opens up, its values whole
 * rather than cut short. The strip starts past the file's longest line when there's room, so it covers no code.
 */
import { getService, ICodeEditorService } from "@codingame/monaco-vscode-api";
import * as monaco from "monaco-editor";
import css from "./live-values.css?raw";

/** One line's values: a label (`mid`), then its value (`inline`: once, beside the label) or one per column (a loop's
 *  turns; null where it didn't run). Lines are 0-based, as VS Code's. */
export interface LiveValuesRow { "line": number; "label": string; "cells": (string | null)[]; "inline"?: boolean }

/** What to draw beside a file: its rows, and a note for what was left out ("… 980 more"). */
export interface LiveValuesView { "rows": LiveValuesRow[]; "note"?: string }

/** Each file's view, by URI. */
const views = new Map<string, LiveValuesView>();
/** Each editor's strip, while it shows a file with a view. */
const strips = new Map<monaco.editor.ICodeEditor, Strip>();
let started: Promise<void> | undefined;

/** A value's look, by what it reads as. */
function kindOf(text: string): string {
	return /^['"`]/u.test(text) ? "string" : /^-?\d/u.test(text) ? "number" : text === "true" || text === "false" ? "boolean" : "";
}

/** One editor's strip: an overlay widget it repositions as the editor scrolls, lays out and changes. */
class Strip implements monaco.editor.IOverlayWidget {
	private readonly editor: monaco.editor.ICodeEditor;
	private readonly element = document.createElement("div");
	private readonly listeners: monaco.IDisposable[] = [];
	private view: LiveValuesView = { "rows": [] };
	private held: number | undefined;

	public constructor(editor: monaco.editor.ICodeEditor) {
		this.editor = editor;
		this.element.className = "live-values";
		this.element.addEventListener("mouseover", (event) => { this.light(this.columnOf(event.target)); });
		this.element.addEventListener("mouseout", () => { this.light(undefined); });
		this.element.addEventListener("click", (event) => {
			const column = this.columnOf(event.target);

			this.held = column === this.held ? undefined : column;
			this.light(undefined);
		});
		editor.addOverlayWidget(this);
		this.listeners.push(
			editor.onDidScrollChange(() => { this.place(); }),
			editor.onDidLayoutChange(() => { this.place(); }),
			editor.onDidChangeModelContent(() => { this.place(); }),
			editor.onDidChangeCursorPosition(() => { this.place(); })
		);
	}

	public getId(): string {
		return "live-values";
	}

	public getDomNode(): HTMLElement {
		return this.element;
	}

	public getPosition(): null {
		return null; // placed by `place`
	}

	public show(view: LiveValuesView): void {
		this.view = view;
		this.render();
	}

	public dispose(): void {
		for (const listener of this.listeners) {
			listener.dispose();
		}

		this.editor.removeOverlayWidget(this);
	}

	private columnOf(target: EventTarget | null): number | undefined {
		const column = (target as HTMLElement | null)?.closest?.("[data-column]")?.getAttribute("data-column");

		return column === null || column === undefined ? undefined : Number(column);
	}

	/** Light `column` (and the held one) on every row. */
	private light(column: number | undefined): void {
		for (const cell of this.element.querySelectorAll<HTMLElement>("[data-column]")) {
			const at = Number(cell.dataset["column"]);

			cell.classList.toggle("lit", at === column);
			cell.classList.toggle("held", at === this.held);
		}
	}

	/** Build the rows: the labels as wide as the widest, each column as wide as its widest value (a monospace font). */
	private render(): void {
		const { rows, note } = this.view;
		const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
		const widths: number[] = [];

		for (const row of rows.filter((candidate) => candidate.inline !== true)) {
			for (const [index, cell] of row.cells.entries()) {
				widths[index] = Math.min(24, Math.max(widths[index] ?? 1, cell?.length ?? 0));
			}
		}

		this.element.replaceChildren(...rows.map((row) => {
			const element = document.createElement("div");
			const label = document.createElement("span");

			element.className = "live-values-row";
			element.dataset["line"] = String(row.line);
			label.className = "live-values-label";
			label.textContent = row.label.padStart(labelWidth) + " = ";
			element.append(label, ...row.cells.map((cell, index) => {
				const span = document.createElement("span");

				span.className = `live-values-cell${row.inline === true ? " inline" : ""}`;
				span.textContent = cell ?? "";
				span.title = cell ?? "";

				if (cell !== null && kindOf(cell) !== "") {
					span.classList.add(`live-values-${kindOf(cell)}`);
				}

				if (row.inline !== true) {
					span.dataset["column"] = String(index);
					// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: a column as wide as its widest value
					span.style.width = `${(widths[index] ?? 1) + 1}ch`;
				}

				return span;
			}));

			return element;
		}), ...note === undefined ? [] : [Object.assign(document.createElement("div"), { "className": "live-values-note", "textContent": note })]);
		this.light(undefined);
		this.place();
	}

	/** Where everything goes now: the strip past the longest line (or as far right as leaves it room), each row beside
	 *  its line as the editor is scrolled. */
	public place(): void {
		const model = this.editor.getModel();
		const layout = this.editor.getLayoutInfo();
		const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
		const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);

		if (model === null) {
			return;
		}

		let longest = 0;

		for (let line = 1; line <= model.getLineCount(); line += 1) {
			longest = Math.max(longest, model.getLineMaxColumn(line));
		}

		const right = layout.width - layout.minimap.minimapWidth - layout.verticalScrollbarWidth;
		const left = Math.min(layout.contentLeft + (longest + 3) * font.typicalHalfwidthCharacterWidth, right - 240);
		const cursor = this.editor.getPosition()?.lineNumber;

		Object.assign(this.element.style, { "left": `${Math.max(layout.contentLeft, left)}px`, "width": `${right - Math.max(layout.contentLeft, left)}px`, "height": `${layout.height}px`, "fontFamily": font.fontFamily, "fontSize": `${font.fontSize}px`, "lineHeight": `${lineHeight}px` });

		for (const row of this.element.querySelectorAll<HTMLElement>(".live-values-row")) {
			const line = Number(row.dataset["line"]) + 1;

			// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: beside its line, as the editor scrolls
			row.style.top = `${this.editor.getTopForLineNumber(line) - this.editor.getScrollTop()}px`;
			// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: the editor's line height
			row.style.height = `${lineHeight}px`;
			row.classList.toggle("open", line === cursor);
		}
	}
}

/** Keep each editor's strip to its file's view, as editors come and go and change files. */
async function start(): Promise<void> {
	const style = document.createElement("style");

	style.textContent = css;
	document.head.append(style);

	const service = await getService(ICodeEditorService);
	const follow = (editor: monaco.editor.ICodeEditor): void => {
		editor.onDidChangeModel(() => { sync(editor); });
		editor.onDidDispose(() => {
			strips.get(editor)?.dispose();
			strips.delete(editor);
		});
		sync(editor);
	};

	for (const editor of service.listCodeEditors()) {
		follow(editor as unknown as monaco.editor.ICodeEditor);
	}

	service.onCodeEditorAdd((editor) => { follow(editor as unknown as monaco.editor.ICodeEditor); });
}

/** An editor's strip, shown or taken down to match its file's view. */
function sync(editor: monaco.editor.ICodeEditor): void {
	const view = views.get(editor.getModel()?.uri.toString() ?? "");
	let strip = strips.get(editor);

	if (view === undefined) {
		strip?.dispose();
		strips.delete(editor);

		return;
	}

	if (strip === undefined) {
		strip = new Strip(editor);
		strips.set(editor, strip);
	}

	strip.show(view);
}

/** Every code editor showing `uri` (a file URI's string) now: for something drawn into an editor of its own (a spike,
 *  a renderer the strip doesn't cover). */
export async function editorsShowing(uri: string): Promise<monaco.editor.ICodeEditor[]> {
	return (await getService(ICodeEditorService)).listCodeEditors().filter((editor) => editor.getModel()?.uri.toString() === uri) as unknown as monaco.editor.ICodeEditor[];
}

/** Draw `view` beside every editor showing `uri` (a file URI's string) — now and when one opens it — or, undefined,
 *  take it away. */
export function showLiveValues(uri: string, view: LiveValuesView | undefined): void {
	if (view === undefined) {
		views.delete(uri);
	} else {
		views.set(uri, view);
	}

	started ??= start();
	void started.then(async () => {
		for (const editor of (await getService(ICodeEditorService)).listCodeEditors()) {
			sync(editor as unknown as monaco.editor.ICodeEditor);
		}
	});
}
