import type { PaneAction, PaneAt, PaneCell, PaneCommand, PaneContent, PaneGroup, PaneItem, PaneViewDeclaration } from "@brianjenkins94/editor-api/pane";
import type { PaneMark as FrameMark, PaneEntry, PaneView } from "@brianjenkins94/monaco-vscode-api/main";
import type WaButton from "theme/components/button";
import type WaDropdownItem from "theme/components/dropdown-item";
import type * as vscodeApi from "vscode";
import type { NativeDrawing } from "./pane-native";
import { Anchors } from "@brianjenkins94/editor-api/anchors";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { extensionContributions, onExtensionsChanged, renderMarkdown, rollPaneBall, showPane, showPaneRuns, showPaneViews } from "@brianjenkins94/monaco-vscode-api/main";
import { marginStyles } from "theme/styles/margin";
import { paneViewsStyles } from "theme/styles/pane-views";
import { installNativeFace } from "./pane-native";
import "theme/components/button";
import "theme/components/button-group";
import "theme/components/dropdown";
import "theme/components/dropdown-item";
import "theme/components/input";

const MARGIN = "margin";

const MARK_CLASSES: Record<string, string> = { "ran": "coverage-ran", "partial": "coverage-partial", "missed": "coverage-missed", "crashed": "run-crashed", "stopped": "run-stopped", "rule": "rule-placed", "rule-uncertain": "rule-placed uncertain" };

const STATE_TEXT: Record<string, string> = { "ran": "ran", "partial": "partly ran", "missed": "didn't run" };

interface Placed { "item": PaneItem; "fromLine": number; "toLine": number }

interface Columns { "run": string; "label": number; "cells": number[] }

interface DrawState { "columns": Map<string, HTMLElement[]> }

let api: typeof vscodeApi | undefined;
let active = MARGIN;
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
const anchored = new Map<string, Anchors>();
const drawing = new Map<string, number>();

async function placeAll(document: vscodeApi.TextDocument, ats: PaneAt[]): Promise<([number, number] | undefined)[]> {
	const vscode = api;
	const text = document.getText();
	const file = vscode.workspace.asRelativePath(document.uri, false);
	const last = Math.max(document.lineCount - 1, 0);
	const placed: ([number, number] | undefined)[] = ats.map((at) => ("lines" in at ? [Math.min(Math.max(at.lines[0], 0), last), Math.min(Math.max(at.lines[1], at.lines[0], 0), last)] : undefined));
	const refs = ats.flatMap((at, index) => ("ref" in at ? [{ "index": index, "ref": at.ref }] : []));

	if (refs.length > 0) {
		const answer = await annotations(vscode.commands).resolve(text, file, refs.map(({ ref }) => ref));
		const found = "value" in answer ? answer.value : [];

		refs.forEach(({ index }, at) => {
			const candidate = found[at]?.status === "orphaned" ? undefined : found[at]?.candidate;

			if (candidate?.start !== undefined && candidate.end !== undefined && (candidate.file === undefined || candidate.file === file)) {
				placed[index] = [document.positionAt(candidate.start).line, document.positionAt(Math.max(candidate.end - 1, candidate.start)).line];
			}
		});
	}

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

			if (line !== undefined) {
				placed[index] = [line, Math.min(line + (source.slice(start, end).match(/\n/gu)?.length ?? 0), last)];
			}
		});
	}

	return placed;
}

async function run(command: PaneCommand, ...last: unknown[]): Promise<unknown> {
	return api?.commands.executeCommand(command.command, ...command.arguments ?? [], ...last);
}

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

function renderItem(item: PaneItem, element: HTMLElement, line: number, columns: Columns | undefined, state: DrawState): (() => void) | undefined {
	const { content } = item;
	const buttons: (WaButton | WaDropdownItem)[] = [];
	let dispose: (() => void) | undefined;
	const act = (command: PaneCommand, chosen: WaButton): void => {
		const before = buttons.map((each) => each.disabled);

		for (const each of buttons) {
			each.disabled = true;
		}

		chosen.classList.add("chosen");
		void run(command).then(() => {
			buttons.forEach((each, index) => {
				each.disabled = before[index];
			});
			chosen.classList.remove("chosen");
		}, (error: unknown) => {
			// eslint-disable-next-line ts/no-base-to-string -- a rejection can be any value: String() is the rendering meant, and any cast to quiet this is flagged as unnecessary
			element.append(Object.assign(document.createElement("div"), { "className": "live-values-ask-error", "textContent": error instanceof Error ? error.message : String(error) }));
		});
	};

	const button = (command: PaneCommand, className: string, onClick: (self: WaButton) => void): WaButton => {
		const made = Object.assign(document.createElement("wa-button"), { "className": className, "size": "s", "textContent": command.title, "title": command.tooltip ?? command.title, "disabled": command.disabled === true });

		made.addEventListener("click", () => {
			onClick(made);
		});
		buttons.push(made);

		return made;
	};

	const actionOf = (action: PaneAction): HTMLElement => {
		const main = button(action, "live-values-choice", (self) => {
			act(action, self);
		});

		if (action.more === undefined || action.more.length === 0) {
			return main;
		}

		const group = Object.assign(document.createElement("wa-button-group"), { "className": "live-values-split", "label": action.title });
		const menu = Object.assign(document.createElement("wa-dropdown"), { "size": "s", "placement": "bottom-start" });
		const more = Object.assign(document.createElement("wa-button"), { "className": "live-values-choice more", "size": "s", "withCaret": true, "title": `${action.title}: for how long`, "slot": "trigger" });

		more.append(Object.assign(document.createElement("span"), { "className": "wa-visually-hidden", "textContent": `${action.title}: for how long` }));
		buttons.push(more);
		action.more.forEach((way, index) => {
			const each = Object.assign(document.createElement("wa-dropdown-item"), { "className": "live-values-menu-item", "value": String(index), "textContent": way.title, "title": way.tooltip ?? way.title, "disabled": way.disabled === true });

			buttons.push(each);
			menu.append(each);
		});
		menu.prepend(more);
		menu.addEventListener("wa-select", (event) => {
			const way = action.more?.[Number((event as CustomEvent<{ "item": WaDropdownItem }>).detail.item.value)];

			if (way !== undefined) {
				act(way, main);
			}
		});
		group.append(main, menu);

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

			if (item.actions !== undefined && item.actions.length > 0) {
				const tools = Object.assign(document.createElement("span"), { "className": `live-values-mock wa-cluster wa-gap-2xs${item.tone === undefined ? "" : " shown"}` });

				tools.append(...item.actions.map(actionOf));
				row.append(tools);
			}
		} else {
			const { input } = content;
			const field = Object.assign(document.createElement("wa-input"), { "className": "live-values-input", "size": "s", "value": input.value, "placeholder": input.placeholder ?? "" });

			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					void run(input.submit, field.value ?? "").catch(() => undefined);
				}
			});
			row.append(field);
		}

		element.append(row);
	}

	if (!("cells" in content) && item.actions !== undefined && item.actions.length > 0) {
		const choices = Object.assign(document.createElement("div"), { "className": "live-values-choices wa-cluster wa-gap-xs" });

		choices.append(...item.actions.map(actionOf));
		element.append(choices);
	}

	return dispose;
}

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

async function contentOf(view: string, uri: string): Promise<PaneContent[]> {
	const providers = [view, ...declared.filter((each) => each.into === view).map((each) => each.id)];
	const answers = await Promise.all(providers.map(async (id) => Promise.resolve(api?.commands.executeCommand<PaneContent | undefined>(`${id}.paneView`, uri)).catch(() => undefined)));

	return answers.filter((answer): answer is PaneContent => answer !== undefined && answer !== null && Array.isArray(answer.items));
}

async function draw(uri: string): Promise<void> {
	const file = api?.workspace.textDocuments.find((each) => each.uri.toString() === uri);
	const token = (drawing.get(uri) ?? 0) + 1;

	drawing.set(uri, token);

	if (file === undefined) {
		return;
	}

	const contents = await contentOf(active, uri);

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
	const runs = contents.find((content) => content.runs !== undefined)?.runs ?? [];
	const path = contents.find((content) => content.path !== undefined)?.path;
	const places = await placeAll(file, [...items.map((item) => item.at), ...groups.map((group) => group.at), ...marks.map((mark) => mark.at), ...path?.at ?? []]);

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
	showPane(uri, placed.map(({ item, fromLine, toLine }) => ({ "id": `item:${item.id}`, "fromLine": fromLine, "toLine": toLine })), render, frameMarks, placedGroups.map(({ group, fromLine, toLine }) => ({ "id": `group:${group.id}`, "fromLine": fromLine, "toLine": toLine })));
	showPaneRuns(uri, runs.map((run) => ({ "id": run.id, "title": run.title, ...run.state === undefined ? {} : { "state": run.state }, ...run.picked === undefined ? {} : { "picked": run.picked } })), (id) => {
		const command = runs.find((run) => run.id === id)?.command;

		if (command !== undefined) {
			void Promise.resolve(api?.commands.executeCommand(command.command, ...command.arguments ?? [])).catch(() => undefined);
		}
	});

	if (path !== undefined) {
		const from = items.length + groups.length + marks.length;
		const lines = path.at.flatMap((_, index) => (places[from + index] === undefined ? [] : [places[from + index][0]])).filter((line, index, all) => index === 0 || line !== all[index - 1]);

		rollPaneBall(uri, path.id, lines, path.live === true);
	}
}

function shownFiles(): string[] {
	return [...new Set((api?.window.visibleTextEditors ?? []).filter((editor) => editor.document.uri.scheme === "file").map((editor) => editor.document.uri.toString()))];
}

function tabs(): PaneView[] {
	const own = declared.filter((view) => view.into === undefined);

	return [...own.filter((view) => view.id === MARGIN), ...own.filter((view) => view.id !== MARGIN)].map((view) => ({ "id": view.id, "label": view.label ?? view.id, ...view.title === undefined ? {} : { "title": view.title } }));
}

function choose(id: string): void {
	active = id;
	showStrip();

	for (const uri of shownFiles()) {
		void draw(uri);
	}
}

function showStrip(): void {
	showPaneViews(tabs(), active, choose);
}

function refreshView(view: string, uri?: string): void {
	if (view !== active && !declared.some((each) => each.id === view && each.into === active)) {
		return;
	}

	for (const each of uri === undefined ? shownFiles() : [uri]) {
		void draw(each);
	}
}

export function installPaneViews(vscode: typeof vscodeApi): vscodeApi.Disposable[] {
	api = vscode;
	marginStyles();
	paneViewsStyles();

	const read = async (): Promise<void> => {
		declared = (await extensionContributions("paneViews")).flatMap(({ value }) => (Array.isArray(value) ? value.filter((view): view is PaneViewDeclaration => typeof view?.id === "string") : []));
		showStrip();

		for (const uri of shownFiles()) {
			void draw(uri);
		}
	};

	const changed = new Map<string, ReturnType<typeof setTimeout>>();
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
		vscode.commands.registerCommand("editor.pane.chooseView", async (id?: unknown) => {
			const picked = typeof id === "string" ? id : (await vscode.window.showQuickPick(tabs().filter((view) => view.disabled !== true).map((view) => ({ "label": view.label, ...view.title === undefined ? {} : { "detail": view.title }, "id": view.id, ...view.id === active ? { "description": "shown" } : {} }))))?.id;

			if (picked !== undefined) {
				choose(picked);
			}

			return active;
		}),
		vscode.commands.registerCommand("editor.pane.refresh", (view: unknown, uri?: unknown) => {
			if (typeof view === "string") {
				refreshView(view, typeof uri === "string" ? uri : undefined);
			}
		}),
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
