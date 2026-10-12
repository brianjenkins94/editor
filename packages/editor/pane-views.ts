/**
 * Pane views (EXTENSION-POINTS.md, 4): the tabs on the pane's first line, and what each draws beside the code. A view
 * is core's (the Margin, drawn by live-values.ts until it's a provider too) or an extension's — declared in its manifest
 * (`contributes.paneViews`) and provided by its command `<id>.paneView`, run with a file's URI whenever the view is
 * shown, the file is, or it changes (or the provider says so: `editor.pane.refresh`). Its content is data
 * (@brianjenkins94/run-contract/pane): drawn here, in the Margin's look, each item on the lines its `at` is on now —
 * lines as given, a span reference resolved by the editor's BABLR, or a range in a text that ran followed from it
 * (anchors.ts). A view declared `into` another adds its items to that one's.
 *
 * Runs in the workbench realm (core), with the workbench's own extension API.
 */
import type * as vscodeApi from "vscode";
import type { PaneEntry, PaneMark as FrameMark, PaneView } from "@brianjenkins94/monaco-vscode-api/main";
import type { PaneAt, PaneCell, PaneCommand, PaneContent, PaneItem, PaneViewDeclaration } from "@brianjenkins94/run-contract/pane";
import type { SpanRef } from "@brianjenkins94/run-contract/annotations";
import { extensionContributions, onExtensionsChanged, renderMarkdown, showPane, showPaneViews } from "@brianjenkins94/monaco-vscode-api/main";
import { annotations } from "@brianjenkins94/run-contract/annotations";
import { Anchors } from "./anchors";

/** The Margin: core's own view, drawn by live-values.ts. */
const MARGIN = "margin";

/** Core's views, before any extension's: the Margin, and what's still to come. */
const CORE_VIEWS: PaneView[] = [
	{ "id": MARGIN, "label": "Margin", "title": "Values, notes and cards beside the code" },
	{ "id": "cards", "label": "Cards", "title": "Coming: the program as a column of cards, Automator's look (PROJECTIONS.md)", "disabled": true },
	{ "id": "event-sheet", "label": "Event sheet", "title": "Coming: the program as an event sheet's conditions and actions", "disabled": true }
];

/** How a mark's kind is styled in the pane's gutter column (live-values.css). */
const MARK_CLASSES: Record<string, string> = { "ran": "coverage-ran", "partial": "coverage-partial", "missed": "coverage-missed", "crashed": "run-crashed", "stopped": "run-stopped", "rule": "rule-placed", "rule-uncertain": "rule-placed uncertain" };

/** How a group's state reads on its card. */
const STATE_TEXT: Record<string, string> = { "ran": "ran", "partial": "partly ran", "missed": "didn't run" };

/** What live-values.ts draws in the Margin for a file — handed here, and shown while the Margin is. */
interface MarginDrawing { "entries": PaneEntry[]; "render": (entry: PaneEntry, element: HTMLElement) => (() => void) | void; "marks": FrameMark[]; "groups": PaneEntry[] }

/** An item placed: on the lines it's on now. */
interface Placed { "item": PaneItem; "fromLine": number; "toLine": number }

let api: typeof vscodeApi | undefined;
let active = MARGIN;
let declared: PaneViewDeclaration[] = [];
const margins = new Map<string, MarginDrawing>();
/** Each text that ran, its anchors (by file and text). */
const anchored = new Map<string, Anchors>();
/** The latest draw of each file, so an older one finishing late doesn't overwrite it. */
const drawing = new Map<string, number>();

/** Where each item is now, in `document`: undefined for one whose code is gone. */
async function placeAll(document: vscodeApi.TextDocument, ats: PaneAt[]): Promise<([number, number] | undefined)[]> {
	const vscode = api!;
	const text = document.getText();
	const file = vscode.workspace.asRelativePath(document.uri, false);
	const last = Math.max(document.lineCount - 1, 0);
	const placed: ([number, number] | undefined)[] = ats.map((at) => ("lines" in at ? [Math.min(Math.max(at.lines[0], 0), last), Math.min(Math.max(at.lines[1], at.lines[0], 0), last)] : undefined));
	// Span references, resolved together.
	const refs = ats.flatMap((at, index) => ("ref" in at ? [{ "index": index, "ref": at.ref }] : []));

	if (refs.length > 0) {
		const found = await annotations(vscode.commands).resolve(text, file, refs.map(({ ref }) => ref as SpanRef)) ?? [];

		refs.forEach(({ index }, at) => {
			const candidate = found[at]?.status === "orphaned" ? undefined : found[at]?.candidate;

			if (candidate?.start !== undefined && candidate.end !== undefined && (candidate.file === undefined || candidate.file === file)) {
				placed[index] = [document.positionAt(candidate.start).line, document.positionAt(Math.max(candidate.end - 1, candidate.start)).line];
			}
		});
	}

	// Ranges in texts that ran, each text's together.
	const ran = new Map<string, { "index": number; "start": number; "end": number }[]>();

	ats.forEach((at, index) => {
		if ("ran" in at) {
			ran.set(at.ran.source, [...ran.get(at.ran.source) ?? [], { "index": index, "start": at.ran.start, "end": at.ran.end }]);
		}
	});

	for (const [source, ranges] of ran) {
		const key = `${document.uri.toString()}\0${source}`;
		const anchors = anchored.get(key) ?? new Anchors(vscode, document.uri.path, source);

		anchored.set(key, anchors);

		const lines = await anchors.lines(text, ranges.map(({ start, end }) => [start, end]));

		ranges.forEach(({ index, start, end }, at) => {
			const line = lines[at];

			// (as many lines down as the range spans in the text that ran)
			if (line !== undefined) {
				placed[index] = [line, Math.min(line + (source.slice(start, end).match(/\n/gu)?.length ?? 0), last)];
			}
		});
	}

	return placed;
}

/** Run `command` (a click on an item's button or cell), with `last` after its own arguments. */
function run(command: PaneCommand, ...last: unknown[]): void {
	void Promise.resolve(api?.commands.executeCommand(command.command, ...command.arguments ?? [], ...last)).catch(() => undefined);
}

/** Each row's column widths, lined up with the rows on the lines next to it: label width, then a width a cell. */
function columnsOf(placed: Placed[]): Map<string, { "label": number; "cells": number[] }> {
	const rows = placed.filter(({ item }) => "cells" in item.content).toSorted((a, b) => a.fromLine - b.fromLine);
	const widths = new Map<string, { "label": number; "cells": number[] }>();
	let run: Placed[] = [];
	const close = (): void => {
		const label = Math.max(0, ...run.map(({ item }) => ("cells" in item.content ? item.content.label?.length ?? 0 : 0)));
		const cells: number[] = [];

		for (const { item } of run) {
			if ("cells" in item.content) {
				item.content.cells.forEach((cell, index) => { cells[index] = Math.max(cells[index] ?? 0, cell.text.length); });
			}
		}

		for (const { item } of run) {
			widths.set(item.id, { "label": label, "cells": cells });
		}

		run = [];
	};

	for (const row of rows) {
		if (run.length > 0 && row.fromLine > run.at(-1)!.toLine + 1) {
			close();
		}

		run.push(row);
	}

	close();

	return widths;
}

function button(command: PaneCommand, className: string): HTMLButtonElement {
	// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
	const element = document.createElement("button");

	element.className = className;
	element.textContent = command.title;
	element.title = command.tooltip ?? command.title;
	element.addEventListener("click", () => { run(command); });

	return element;
}

function cellOf(cell: PaneCell, width: number | undefined): HTMLSpanElement {
	const span = document.createElement("span");

	span.className = `live-values-cell turn${cell.kind === undefined ? "" : ` live-values-${cell.kind}`}${cell.picked === true ? " held" : ""}`;
	span.textContent = cell.text;
	span.title = cell.title ?? cell.text;

	if (width !== undefined) {
		// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: a column as wide as its widest value
		span.style.width = `${width + 2}ch`;
	}

	if (cell.command !== undefined) {
		const { command } = cell;

		span.addEventListener("click", () => { run(command); });
	}

	return span;
}

/** Draw `item` into `element`, in the Margin's look; what it returns is called when it goes. */
function renderItem(item: PaneItem, element: HTMLElement, columns: { "label": number; "cells": number[] } | undefined): (() => void) | undefined {
	const { content } = item;
	let dispose: (() => void) | undefined;

	element.classList.add("pane-item", ...item.tone === undefined ? [] : [`tone-${item.tone}`]);

	if ("markdown" in content) {
		const rendered = renderMarkdown(content.markdown);

		element.append(rendered.element);
		dispose = rendered.dispose;
	} else {
		const line = document.createElement("div");

		line.className = "live-values-row";

		if (content.label !== undefined && content.label !== "") {
			line.append(Object.assign(document.createElement("span"), { "className": "live-values-label", "textContent": content.label.padEnd(columns?.label ?? 0) }));
		}

		if ("cells" in content) {
			content.cells.forEach((cell, index) => { line.append(cellOf(cell, columns?.cells[index])); });
		} else {
			const { input } = content;
			// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
			const field = Object.assign(document.createElement("input"), { "className": "live-values-input", "value": input.value, "placeholder": input.placeholder ?? "" });

			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					run(input.submit, field.value);
				}
			});
			line.append(field);
		}

		element.append(line);
	}

	if (item.actions !== undefined && item.actions.length > 0) {
		const choices = Object.assign(document.createElement("div"), { "className": "live-values-choices" });

		choices.append(...item.actions.map((action) => button(action, "live-values-choice")));
		element.append(choices);
	}

	return dispose;
}

/** What `view` and the views `into` it provide for `uri` — undefined from one that has nothing, or isn't there. */
async function contentOf(view: string, uri: string): Promise<PaneContent[]> {
	const providers = [view, ...declared.filter((each) => each.into === view).map((each) => each.id)];
	const answers = await Promise.all(providers.map(async (id) => (id === MARGIN ? undefined : Promise.resolve(api?.commands.executeCommand<PaneContent | undefined>(`${id}.paneView`, uri)).catch(() => undefined))));

	return answers.filter((answer): answer is PaneContent => answer !== undefined && Array.isArray(answer.items));
}

/** Draw `uri`'s pane: the shown view's content (the Margin's, live-values.ts's own, with what's `into` it). */
async function draw(uri: string): Promise<void> {
	const file = api?.workspace.textDocuments.find((each) => each.uri.toString() === uri);
	const token = (drawing.get(uri) ?? 0) + 1;

	drawing.set(uri, token);

	if (file === undefined) {
		return;
	}

	const contents = await contentOf(active, uri);
	const items = contents.flatMap((content) => content.items);
	const groups = contents.flatMap((content) => content.groups ?? []);
	const marks = contents.flatMap((content) => content.marks ?? []);
	const places = await placeAll(file, [...items.map((item) => item.at), ...groups.map((group) => group.at), ...marks.map((mark) => mark.at)]);

	if (drawing.get(uri) !== token) {
		return; // a newer draw
	}

	const placed = items.flatMap((item, index): Placed[] => (places[index] === undefined ? [] : [{ "item": item, "fromLine": places[index][0], "toLine": places[index][1] }]));
	const placedGroups = groups.flatMap((group, index) => {
		const at = places[items.length + index];

		return at === undefined ? [] : [{ "group": group, "fromLine": at[0], "toLine": at[1] }];
	});
	const frameMarks = marks.flatMap((mark, index): FrameMark[] => {
		const at = places[items.length + groups.length + index];

		return at === undefined ? [] : [{ "line": at[0], "kind": MARK_CLASSES[mark.kind] ?? mark.kind, ...mark.title === undefined ? {} : { "title": mark.title } }];
	});
	const columns = columnsOf(placed);
	const byId = new Map(placed.map((each) => [`item:${each.item.id}`, each.item]));
	const groupsById = new Map(placedGroups.map((each) => [`group:${each.group.id}`, each.group]));
	const render = (entry: PaneEntry, element: HTMLElement): (() => void) | void => {
		const item = byId.get(entry.id);

		if (item !== undefined) {
			return renderItem(item, element, columns.get(item.id));
		}

		const group = groupsById.get(entry.id);

		if (group !== undefined) {
			element.append(
				Object.assign(document.createElement("span"), { "className": "live-values-step-title", "textContent": group.label }),
				...group.state === undefined ? [] : [Object.assign(document.createElement("span"), { "className": `live-values-step-ran ${group.state}`, "textContent": STATE_TEXT[group.state] })]
			);

			return undefined;
		}

		return margins.get(uri)?.render(entry, element);
	};
	const entries = placed.map(({ item, fromLine, toLine }) => ({ "id": `item:${item.id}`, "fromLine": fromLine, "toLine": toLine }));
	const frameGroups = placedGroups.map(({ group, fromLine, toLine }) => ({ "id": `group:${group.id}`, "fromLine": fromLine, "toLine": toLine }));
	const margin = active === MARGIN ? margins.get(uri) : undefined;

	// (the pane stays, its tabs with it, whatever the view has: an empty view is still shown)
	showPane(uri, [...margin?.entries ?? [], ...entries], render, [...margin?.marks ?? [], ...frameMarks], [...margin?.groups ?? [], ...frameGroups]);
}

/** Every file shown in an editor. */
function shownFiles(): string[] {
	return [...new Set((api?.window.visibleTextEditors ?? []).filter((editor) => editor.document.uri.scheme === "file").map((editor) => editor.document.uri.toString()))];
}

/** The strip: core's views, then each extension's own (a view `into` another has no tab). */
function showStrip(): void {
	const views = [...CORE_VIEWS, ...declared.filter((view) => view.into === undefined && !CORE_VIEWS.some((core) => core.id === view.id)).map((view) => ({ "id": view.id, "label": view.label ?? view.id, ...view.title === undefined ? {} : { "title": view.title } }))];

	showPaneViews(views, active, (id) => {
		active = id;
		showStrip();

		for (const uri of new Set([...shownFiles(), ...margins.keys()])) {
			void draw(uri);
		}
	});
}

/** The Margin's drawing of `uri` (live-values.ts's), or none: shown while the Margin is, with what's `into` it. */
export function showMargin(uri: string, drawn: MarginDrawing | undefined): void {
	if (drawn === undefined) {
		margins.delete(uri);

		if (active === MARGIN) {
			showPane(uri, undefined);
		}

		return;
	}

	margins.set(uri, drawn);

	if (active === MARGIN) {
		if (declared.some((view) => view.into === MARGIN)) {
			void draw(uri);
		} else {
			showPane(uri, drawn.entries, drawn.render, drawn.marks, drawn.groups);
		}
	}
}

/** Read the views extensions declare, offer them, and draw the one shown as files show and change. */
export function installPaneViews(vscode: typeof vscodeApi): vscodeApi.Disposable[] {
	api = vscode;

	const read = async (): Promise<void> => {
		declared = (await extensionContributions("paneViews")).flatMap(({ value }) => (Array.isArray(value) ? value.filter((view): view is PaneViewDeclaration => typeof view?.id === "string") : []));
		showStrip();
	};
	const changed = new Map<string, ReturnType<typeof setTimeout>>();
	// (typing paused: a file's content asked for again)
	const redrawLater = (uri: string): void => {
		clearTimeout(changed.get(uri));
		changed.set(uri, setTimeout(() => {
			changed.delete(uri);
			void draw(uri);
		}, 300));
	};

	showStrip();
	void read();
	void onExtensionsChanged(() => { void read(); });

	return [
		// A provider's word that its content changed: one file's, or every file's.
		vscode.commands.registerCommand("editor.pane.refresh", (view: unknown, uri?: unknown) => {
			if (view !== active && !declared.some((each) => each.id === view && each.into === active)) {
				return;
			}

			for (const each of typeof uri === "string" ? [uri] : shownFiles()) {
				void draw(each);
			}
		}),
		// The shown view's content, for a file as it's shown and as it changes (the Margin draws itself).
		vscode.window.onDidChangeVisibleTextEditors(() => {
			if (active !== MARGIN || declared.some((view) => view.into === MARGIN)) {
				for (const uri of shownFiles()) {
					void draw(uri);
				}
			}
		}),
		vscode.workspace.onDidChangeTextDocument(({ document }) => {
			if ((active !== MARGIN || declared.some((view) => view.into === MARGIN)) && shownFiles().includes(document.uri.toString())) {
				redrawLater(document.uri.toString());
			}
		})
	];
}
