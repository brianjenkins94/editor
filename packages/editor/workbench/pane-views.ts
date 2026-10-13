/**
 * Pane views (EXTENSION-POINTS.md, 4): the tabs on the pane's first line, and what each draws beside the code. A view
 * is core's (the Margin, live-values.ts's) or an extension's — declared in its manifest (`contributes.paneViews`) — and
 * either way provided by its command `<id>.paneView`, run with a file's URI whenever the view is shown, the file is, or
 * it changes (or the provider says so: `editor.pane.refresh`). Its content is data (@brianjenkins94/run-contract/pane):
 * drawn here, in the Margin's look, each item on the lines its `at` is on now — lines as given, a span reference
 * resolved by the editor's BABLR, or a range in a text that ran followed from it (anchors.ts). A view declared `into`
 * another adds its items to that one's.
 *
 * Runs in the workbench realm (core), with the workbench's own extension API.
 */
import type { PaneMark as FrameMark, PaneEntry, PaneView } from "@brianjenkins94/monaco-vscode-api/main";
import type { PaneAction, PaneAt, PaneCell, PaneCommand, PaneContent, PaneGroup, PaneItem, PaneViewDeclaration } from "@brianjenkins94/run-contract/pane";
import type * as vscodeApi from "vscode";
import type { NativeDrawing } from "./pane-native";
import { extensionContributions, onExtensionsChanged, renderMarkdown, showPane, showPaneViews } from "@brianjenkins94/monaco-vscode-api/main";
import { annotations } from "@brianjenkins94/run-contract/annotations";
import { Anchors } from "./anchors";
import { installNativeFace } from "./pane-native";

/** The Margin: core's own view (live-values.ts provides it, as `margin.paneView`). */
const MARGIN = "margin";

/** Core's views, before any extension's: the Margin. */
const CORE_VIEWS: PaneView[] = [{ "id": MARGIN, "label": "Margin", "title": "Values, cards and the run beside the code" }];

/** Core's views into another: coverage's marks, into the Margin (coverage.ts). */
const CORE_INTO: PaneViewDeclaration[] = [{ "id": "coverage", "into": MARGIN }];

/** How a mark's kind is styled in the pane's gutter column (live-values.css). */
const MARK_CLASSES: Record<string, string> = { "ran": "coverage-ran", "partial": "coverage-partial", "missed": "coverage-missed", "crashed": "run-crashed", "stopped": "run-stopped", "rule": "rule-placed", "rule-uncertain": "rule-placed uncertain" };

/** How a group's state reads on its card. */
const STATE_TEXT: Record<string, string> = { "ran": "ran", "partial": "partly ran", "missed": "didn't run" };

/** An item placed: on the lines it's on now. */
interface Placed { "item": PaneItem; "fromLine": number; "toLine": number }

/** A row's place among the rows lined up with it: its run of rows (by its first row's id), and their column widths. */
interface Columns { "run": string; "label": number; "cells": number[] }

/** What one draw of a file shares among its items: each column's cells, lit together as one is hovered. */
interface DrawState { "columns": Map<string, HTMLElement[]> }

let api: typeof vscodeApi | undefined;
let active = MARGIN;
/** Where the shown view is drawn: beside the code (the pane), or with VS Code's own annotations (pane-native.ts) — the
 *  pane hidden. Remembered, the same for every editor. */
const NATIVE_KEY = "pane.native";
let native = ((): boolean => {
	try {
		return localStorage.getItem(NATIVE_KEY) === "true";
	} catch {
		return false; // no storage: the pane
	}
})();
let nativeFace: ReturnType<typeof installNativeFace> | undefined;
let declared: PaneViewDeclaration[] = [];
/** Every view declared: core's into another, then each extension's. */
const allDeclared = (): PaneViewDeclaration[] => [...CORE_INTO, ...declared];
/** Each text that ran, its anchors (by file and text). */
const anchored = new Map<string, Anchors>();
/** The latest draw of each file, so an older one finishing late doesn't overwrite it. */
const drawing = new Map<string, number>();

/** Where each item is now, in `document`: undefined for one whose code is gone. */
async function placeAll(document: vscodeApi.TextDocument, ats: PaneAt[]): Promise<([number, number] | undefined)[]> {
	const vscode = api;
	const text = document.getText();
	const file = vscode.workspace.asRelativePath(document.uri, false);
	const last = Math.max(document.lineCount - 1, 0);
	const placed: ([number, number] | undefined)[] = ats.map((at) => ("lines" in at ? [Math.min(Math.max(at.lines[0], 0), last), Math.min(Math.max(at.lines[1], at.lines[0], 0), last)] : undefined));
	// Span references, resolved together.
	const refs = ats.flatMap((at, index) => ("ref" in at ? [{ "index": index, "ref": at.ref }] : []));

	if (refs.length > 0) {
		// (none when the text can't be parsed as it is, or there's no BABLR: not drawn this time — the next draw looks again)
		const answer = await annotations(vscode.commands).resolve(text, file, refs.map(({ ref }) => ref));
		const found = "value" in answer ? answer.value : [];

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
async function run(command: PaneCommand, ...last: unknown[]): Promise<unknown> {
	return api?.commands.executeCommand(command.command, ...command.arguments ?? [], ...last);
}

/** Each row's column widths, lined up with the rows on the lines next to it (or its own line). */
function columnsOf(placed: Placed[]): Map<string, Columns> {
	const rows = placed.filter(({ item }) => "cells" in item.content).toSorted((left, right) => left.fromLine - right.fromLine);
	const widths = new Map<string, Columns>();
	let group: Placed[] = [];
	const close = (): void => {
		const label = Math.max(0, ...group.map(({ item }) => ("cells" in item.content ? item.content.label?.length ?? 0 : 0)));
		const cells: number[] = [];

		for (const { item } of group) {
			if ("cells" in item.content) {
				item.content.cells.forEach((cell, index) => {
					cells[index] = Math.max(cells[index] ?? 0, cell.text.length);
				});
			}
		}

		for (const { item } of group) {
			widths.set(item.id, { "run": group[0].item.id, "label": label, "cells": cells });
		}

		group = [];
	};

	for (const row of rows) {
		if (group.length > 0 && row.fromLine > group.at(-1).toLine + 1) {
			close();
		}

		group.push(row);
	}

	close();

	return widths;
}

function cellOf(cell: PaneCell, className: string, width?: number): HTMLSpanElement {
	const span = document.createElement("span");

	span.className = `live-values-cell ${className}${cell.kind === undefined ? "" : ` live-values-${cell.kind}`}${cell.picked === true ? " held" : ""}`;
	span.textContent = cell.text;
	span.title = cell.title ?? cell.text;

	if (width !== undefined) {
		// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: a column as wide as its widest value
		span.style.width = `${width + 2}ch`;
	}

	if (cell.command !== undefined) {
		const { command } = cell;

		span.classList.add("clickable");
		span.addEventListener("click", () => {
			void run(command).catch(() => undefined);
		});
	}

	return span;
}

/** Draw `item` into `element`, in the Margin's look, level with line `line`; what it returns is called when it goes. */
function renderItem(item: PaneItem, element: HTMLElement, line: number, columns: Columns | undefined, state: DrawState): (() => void) | undefined {
	const { content } = item;
	const buttons: HTMLButtonElement[] = [];
	let dispose: (() => void) | undefined;
	// A button's command: the item's buttons off until it's drawn again, this one marked — and why, if it fails.
	const act = (command: PaneCommand, chosen: HTMLButtonElement): void => {
		for (const each of buttons) {
			each.disabled = true;
		}

		chosen.classList.add("chosen");
		void run(command).catch((error: unknown) => {
			// eslint-disable-next-line ts/no-base-to-string -- a rejection can be any value: String() is the rendering meant, and any cast to quiet this is flagged as unnecessary
			element.append(Object.assign(document.createElement("div"), { "className": "live-values-ask-error", "textContent": error instanceof Error ? error.message : String(error) }));
		});
	};

	const button = (command: PaneCommand, className: string, onClick: (self: HTMLButtonElement) => void): HTMLButtonElement => {
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		const made = Object.assign(document.createElement("button"), { "className": className, "textContent": command.title, "title": command.tooltip ?? command.title, "disabled": command.disabled === true });

		made.addEventListener("click", () => {
			onClick(made);
		});
		buttons.push(made);

		return made;
	};

	// A button — and, with `more`, ▾ beside it, a menu of the ways it can go.
	const actionOf = (action: PaneAction): HTMLElement => {
		const main = button(action, "live-values-choice", (self) => {
			act(action, self);
		});

		if (action.more === undefined || action.more.length === 0) {
			return main;
		}

		const group = Object.assign(document.createElement("span"), { "className": "live-values-split" });
		const menu = Object.assign(document.createElement("div"), { "className": "live-values-menu", "hidden": true });
		const close = (event: Event): void => {
			if (!group.contains(event.target as Node) || (event instanceof KeyboardEvent && event.key === "Escape")) {
				menu.hidden = true;
				document.removeEventListener("pointerdown", close, true);
				document.removeEventListener("keydown", close, true);
			}
		};

		const more = button({ "title": "▾", "command": "", "tooltip": `${action.title}: for how long` }, "live-values-choice more", () => {
			menu.hidden = !menu.hidden;

			if (!menu.hidden) {
				document.addEventListener("pointerdown", close, true);
				document.addEventListener("keydown", close, true);
			}
		});

		for (const way of action.more) {
			menu.append(button(way, "live-values-menu-item", () => {
				menu.hidden = true;
				act(way, main);
			}));
		}

		group.append(main, more, menu);

		return group;
	};

	element.classList.add("pane-item", ...item.tone === undefined ? [] : [`tone-${item.tone}`]);
	element.dataset["item"] = item.id;

	if ("markdown" in content) {
		const rendered = renderMarkdown(content.markdown);

		rendered.element.classList.add("pane-markdown");
		element.append(rendered.element);
		({ dispose } = rendered);
	} else {
		const row = document.createElement("div");

		row.className = "live-values-row";
		row.dataset["line"] = String(line);

		if ("cells" in content) {
			for (const cell of content.lead ?? []) {
				row.append(cellOf(cell, "lead"));
			}
		}

		if (content.label !== undefined && content.label !== "") {
			row.append(Object.assign(document.createElement("span"), { "className": "live-values-label", "textContent": content.label.padEnd(columns?.label ?? 0) }));
		}

		if ("cells" in content) {
			if (content.value !== undefined) {
				row.append(cellOf(content.value, "inline"));
			}

			content.cells.forEach((cell, index) => {
				const span = cellOf(cell, "turn", columns?.cells[index]);
				const key = `${columns?.run ?? item.id}#${index}`;

				state.columns.set(key, [...state.columns.get(key) ?? [], span]);
				span.addEventListener("mouseenter", () => {
					for (const each of state.columns.get(key) ?? []) {
						each.classList.add("lit");
					}
				});
				span.addEventListener("mouseleave", () => {
					for (const each of state.columns.get(key) ?? []) {
						each.classList.remove("lit");
					}
				});
				row.append(span);
			});

			// A row's buttons at its end, shown as it's hovered.
			if (item.actions !== undefined && item.actions.length > 0) {
				const tools = Object.assign(document.createElement("span"), { "className": "live-values-mock" });

				tools.append(...item.actions.map(actionOf));
				row.append(tools);
			}
		} else {
			const { input } = content;
			// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
			const field = Object.assign(document.createElement("input"), { "className": "live-values-input", "value": input.value, "placeholder": input.placeholder ?? "" });

			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					void run(input.submit, field.value).catch(() => undefined);
				}
			});
			row.append(field);
		}

		element.append(row);
	}

	if (!("cells" in content) && item.actions !== undefined && item.actions.length > 0) {
		const choices = Object.assign(document.createElement("div"), { "className": "live-values-choices" });

		choices.append(...item.actions.map(actionOf));
		element.append(choices);
	}

	return dispose;
}

/** A card's label: its title, its detail, how it ran; its title on hover. */
function renderGroup(group: PaneGroup, element: HTMLElement): void {
	element.append(
		Object.assign(document.createElement("span"), { "className": "live-values-step-title", "textContent": group.label }),
		...group.detail === undefined || group.detail === "" ? [] : [Object.assign(document.createElement("span"), { "className": "live-values-step-detail", "textContent": group.detail })],
		...group.state === undefined ? [] : [Object.assign(document.createElement("span"), { "className": `live-values-step-ran ${group.state}`, "textContent": group.stateText ?? STATE_TEXT[group.state] })]
	);

	if (group.title !== undefined) {
		element.title = group.title;
	}
}

/** What `view` and the views `into` it provide for `uri` — none from one that has nothing, or isn't there. */
async function contentOf(view: string, uri: string): Promise<PaneContent[]> {
	const providers = [view, ...allDeclared().filter((each) => each.into === view).map((each) => each.id)];
	const answers = await Promise.all(providers.map(async (id) => Promise.resolve(api?.commands.executeCommand<PaneContent | undefined>(`${id}.paneView`, uri)).catch(() => undefined)));

	return answers.filter((answer): answer is PaneContent => answer !== undefined && answer !== null && Array.isArray(answer.items));
}

/** Draw `uri`'s pane: the shown view's content, with what's `into` it — or, with none, no pane. */
async function draw(uri: string): Promise<void> {
	const file = api?.workspace.textDocuments.find((each) => each.uri.toString() === uri);
	const token = (drawing.get(uri) ?? 0) + 1;

	drawing.set(uri, token);

	if (file === undefined) {
		return;
	}

	const contents = await contentOf(active, uri);

	// Nothing: the Margin's no pane (a file that isn't code); another view's an empty one, its tabs still there.
	if (contents.length === 0) {
		if (drawing.get(uri) === token) {
			nativeFace?.show(uri, undefined);
			showPane(uri, active === MARGIN || native ? undefined : [], () => undefined);
		}

		return;
	}

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
	const byId = new Map(placed.map((each) => [`item:${each.item.id}`, each]));
	const groupsById = new Map(placedGroups.map((each) => [`group:${each.group.id}`, each.group]));
	const state: DrawState = { "columns": new Map() };
	const render = (entry: PaneEntry, element: HTMLElement): (() => void) | void => {
		const each = byId.get(entry.id);

		if (each !== undefined) {
			return renderItem(each.item, element, each.fromLine, columns.get(each.item.id), state);
		}

		const group = groupsById.get(entry.id);

		if (group !== undefined) {
			renderGroup(group, element);
		}

		return undefined;
	};

	// With VS Code's own annotations instead, the pane hidden.
	if (native) {
		const nativeDrawing: NativeDrawing = {
			"items": placed,
			"groups": placedGroups,
			"marks": marks.flatMap((mark, index) => {
				const at = places[items.length + groups.length + index];

				return at === undefined ? [] : [{ "line": at[0], "kind": mark.kind, ...mark.title === undefined ? {} : { "title": mark.title } }];
			})
		};

		nativeFace?.show(uri, nativeDrawing);
		showPane(uri, undefined);

		return;
	}

	nativeFace?.show(uri, undefined);
	// (the pane stays, its tabs with it, whatever the view has: an empty view is still shown)
	showPane(uri, placed.map(({ item, fromLine, toLine }) => ({ "id": `item:${item.id}`, "fromLine": fromLine, "toLine": toLine })), render, frameMarks, placedGroups.map(({ group, fromLine, toLine }) => ({ "id": `group:${group.id}`, "fromLine": fromLine, "toLine": toLine })));
}

/** Every file shown in an editor. */
function shownFiles(): string[] {
	return [...new Set((api?.window.visibleTextEditors ?? []).filter((editor) => editor.document.uri.scheme === "file").map((editor) => editor.document.uri.toString()))];
}

/** The views with tabs: core's, then each extension's own (a view `into` another has none). */
function tabs(): PaneView[] {
	return [...CORE_VIEWS, ...declared.filter((view) => view.into === undefined && !CORE_VIEWS.some((core) => core.id === view.id)).map((view) => ({ "id": view.id, "label": view.label ?? view.id, ...view.title === undefined ? {} : { "title": view.title } }))];
}

/** Show view `id`, every shown file's. */
function choose(id: string): void {
	active = id;
	showStrip();

	for (const uri of shownFiles()) {
		void draw(uri);
	}
}

/** The strip: the views with tabs, the one shown chosen. */
function showStrip(): void {
	showPaneViews(tabs(), active, choose);
}

/** Draw `uri` again — or every shown file — for `view`, if it's the one shown (or in it): its provider's word that its
 *  content changed (core's views say so this way; an extension's through `editor.pane.refresh`). */
export function refreshView(view: string, uri?: string): void {
	if (view !== active && !allDeclared().some((each) => each.id === view && each.into === active)) {
		return;
	}

	for (const each of uri === undefined ? shownFiles() : [uri]) {
		void draw(each);
	}
}

/** Read the views extensions declare, offer them, and draw the one shown as files show and change. */
export function installPaneViews(vscode: typeof vscodeApi): vscodeApi.Disposable[] {
	api = vscode;

	const read = async (): Promise<void> => {
		declared = (await extensionContributions("paneViews")).flatMap(({ value }) => (Array.isArray(value) ? value.filter((view): view is PaneViewDeclaration => typeof view?.id === "string") : []));
		showStrip();

		for (const uri of shownFiles()) {
			void draw(uri);
		}
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
	void onExtensionsChanged(() => {
		void read();
	});
	nativeFace = installNativeFace(vscode);

	return [
		...nativeFace.disposables,
		// Beside the code, or as VS Code's own annotations (the pane hidden): the shown view drawn the other way.
		vscode.commands.registerCommand("editor.pane.toggleNative", () => {
			native = !native;

			try {
				localStorage.setItem(NATIVE_KEY, String(native));
			} catch { /* no storage: just this session */ }

			for (const uri of shownFiles()) {
				void draw(uri);
			}

			return native;
		}),
		// Which view is shown — the pane's tabs, when there's no pane to show them.
		vscode.commands.registerCommand("editor.pane.chooseView", async (id?: unknown) => {
			const picked = typeof id === "string" ? id : (await vscode.window.showQuickPick(tabs().filter((view) => view.disabled !== true).map((view) => ({ "label": view.label, ...view.title === undefined ? {} : { "detail": view.title }, "id": view.id, ...view.id === active ? { "description": "shown" } : {} }))))?.id;

			if (picked !== undefined) {
				choose(picked);
			}

			return active;
		}),
		// A provider's word that its content changed: one file's, or every file's.
		vscode.commands.registerCommand("editor.pane.refresh", (view: unknown, uri?: unknown) => {
			if (typeof view === "string") {
				refreshView(view, typeof uri === "string" ? uri : undefined);
			}
		}),
		// The shown view's content, for a file as it's shown and as it changes.
		vscode.window.onDidChangeVisibleTextEditors(() => {
			for (const uri of shownFiles()) {
				void draw(uri);
			}
		}),
		vscode.workspace.onDidChangeTextDocument(({ document }) => {
			if (shownFiles().includes(document.uri.toString())) {
				redrawLater(document.uri.toString());
			}
		})
	];
}
