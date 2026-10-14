/**
 * The pane's native face (EXTENSION-POINTS.md, 4, step 5): a pane view's content — the same data pane-views.ts draws
 * beside the code, placed the same way — drawn with VS Code's own contribution points instead, for when there's no
 * pane (a desktop build) or it's hidden (`editor.pane.toggleNative`): a row as an inlay hint at the end of its line
 * (its label and latest value; every cell on hover), prose as a CodeLens (its first line) and a hover (all of it),
 * buttons as CodeLenses running their commands (a menu's ways in a quick pick), a one-line input as a CodeLens asking
 * for it, a card's label as a CodeLens above its first line, and a gutter mark as an overview-ruler mark (its title on
 * hover). Public API only.
 */
import type { PaneAction, PaneCommand, PaneGroup, PaneItem } from "@brianjenkins94/editor-api/pane";
import type * as vscodeApi from "vscode";

/** A file's content, placed: each item, card and mark on the lines it's on now (0-based). */
export interface NativeDrawing {
	"items": { "item": PaneItem; "fromLine": number; "toLine": number }[];
	"groups": { "group": PaneGroup; "fromLine": number; "toLine": number }[];
	"marks": { "line": number; "kind": string; "title"?: string }[];
}

/** How a mark is shown in the overview ruler, by its kind. */
const MARK_COLORS: Record<string, string> = { "ran": "#2ea04380", "partial": "#d29922a0", "missed": "#f85149a0", "crashed": "#f85149", "stopped": "#d29922", "rule": "#a371f7", "rule-uncertain": "#a371f780" };

/** A markdown text's first line, plain: what a CodeLens says of it. */
function plain(markdown: string): string {
	const first = markdown.split("\n").find((line) => line.trim() !== "") ?? "";

	return first.replaceAll(/[*_`]/gu, "").trim().slice(0, 120);
}

export function installNativeFace(vscode: typeof vscodeApi): { "show": (uri: string, drawing: NativeDrawing | undefined) => void; "disposables": vscodeApi.Disposable[] } {
	const drawings = new Map<string, NativeDrawing>();
	const hintsChanged = new vscode.EventEmitter<void>();
	const lensesChanged = new vscode.EventEmitter<void>();
	const decorations = new Map(Object.entries(MARK_COLORS).map(([kind, color]) => [kind, vscode.window.createTextEditorDecorationType({ "overviewRulerColor": color, "overviewRulerLane": vscode.OverviewRulerLane.Left })]));
	const lens = (line: number, command: PaneCommand): vscodeApi.CodeLens => new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { "title": command.disabled === true ? `(${command.title})` : command.title, "command": command.disabled === true ? "" : command.command, "arguments": command.arguments ?? [], ...command.tooltip === undefined ? {} : { "tooltip": command.tooltip } });
	const actionLenses = (line: number, action: PaneAction): vscodeApi.CodeLens[] => [
		lens(line, action),
		...action.more === undefined || action.more.length === 0 ? [] : [lens(line, { "title": "▾", "command": "editor.pane.native.more", "arguments": [action.more], "tooltip": `${action.title}: for how long` })]
	];
	const decorate = (editor: vscodeApi.TextEditor): void => {
		const drawing = drawings.get(editor.document.uri.toString());

		for (const [kind, type] of decorations) {
			editor.setDecorations(type, (drawing?.marks ?? []).filter((mark) => mark.kind === kind && mark.line < editor.document.lineCount).map((mark) => ({ "range": editor.document.lineAt(mark.line).range, ...mark.title === undefined ? {} : { "hoverMessage": mark.title } })));
		}
	};

	return {
		"show": (uri, drawing) => {
			if (drawing === undefined) {
				if (!drawings.delete(uri)) {
					return;
				}
			} else {
				drawings.set(uri, drawing);
			}

			hintsChanged.fire();
			lensesChanged.fire();

			for (const editor of vscode.window.visibleTextEditors.filter((each) => each.document.uri.toString() === uri)) {
				decorate(editor);
			}
		},
		"disposables": [
			hintsChanged,
			lensesChanged,
			...decorations.values(),
			vscode.window.onDidChangeVisibleTextEditors((editors) => { editors.forEach(decorate); }),
			// A row: its label and latest value at the end of its line.
			vscode.languages.registerInlayHintsProvider({ "scheme": "file" }, {
				"onDidChangeInlayHints": hintsChanged.event,
				"provideInlayHints": (document, range) => (drawings.get(document.uri.toString())?.items ?? []).flatMap(({ item, fromLine }) => {
					const { content } = item;

					if (!("cells" in content) || fromLine < range.start.line || fromLine > range.end.line || fromLine >= document.lineCount) {
						return [];
					}

					const latest = content.value?.text ?? content.cells.findLast((cell) => cell.text !== "")?.text ?? "";
					const hint = new vscode.InlayHint(document.lineAt(fromLine).range.end, ` ${[content.label, latest].filter((each) => each !== undefined && each !== "").join(" ")}`);

					hint.tooltip = content.cells.length > 1 ? content.cells.map((cell) => cell.text).join(" · ") : undefined;

					return [hint];
				})
			}),
			// Prose's first line, a card's label, each button and input: above their lines.
			vscode.languages.registerCodeLensProvider({ "scheme": "file" }, {
				"onDidChangeCodeLenses": lensesChanged.event,
				"provideCodeLenses": (document) => {
					const drawing = drawings.get(document.uri.toString());

					if (drawing === undefined) {
						return [];
					}

					return [
						...drawing.groups.map(({ group, fromLine }) => lens(fromLine, { "title": [group.label, group.detail, group.stateText ?? group.state].filter((each) => each !== undefined && each !== "").join(" · "), "command": "", ...group.title === undefined ? {} : { "tooltip": group.title } })),
						...drawing.items.flatMap(({ item, fromLine }) => [
							...!("markdown" in item.content) ? [] : [lens(fromLine, { "title": plain(item.content.markdown), "command": "" })],
							...!("input" in item.content) ? [] : [lens(fromLine, { "title": `${item.content.label} ${item.content.input.value === "" ? "…" : item.content.input.value} ✎`, "command": "editor.pane.native.input", "arguments": [item.content.input] })],
							...(item.actions ?? []).flatMap((action) => actionLenses(fromLine, action))
						])
					].filter((each) => each.range.start.line < document.lineCount);
				}
			}),
			// Prose, whole, on its lines.
			vscode.languages.registerHoverProvider({ "scheme": "file" }, {
				"provideHover": (document, position) => {
					const texts = (drawings.get(document.uri.toString())?.items ?? []).filter(({ item, fromLine, toLine }) => "markdown" in item.content && fromLine <= position.line && position.line <= toLine).map(({ item }) => ("markdown" in item.content ? item.content.markdown : ""));

					return texts.length === 0 ? undefined : new vscode.Hover(texts.map((text) => new vscode.MarkdownString(text)));
				}
			}),
			// A menu's ways (this call, this run, always), picked.
			vscode.commands.registerCommand("editor.pane.native.more", async (ways: PaneCommand[]) => {
				const picked = await vscode.window.showQuickPick(ways.filter((way) => way.disabled !== true).map((way) => ({ "label": way.title, ...way.tooltip === undefined ? {} : { "detail": way.tooltip }, "way": way })));

				if (picked !== undefined) {
					await vscode.commands.executeCommand(picked.way.command, ...picked.way.arguments ?? []);
				}
			}),
			// A one-line input, asked for.
			vscode.commands.registerCommand("editor.pane.native.input", async (input: { "value": string; "placeholder"?: string; "submit": PaneCommand }) => {
				const value = await vscode.window.showInputBox({ "value": input.value, ...input.placeholder === undefined ? {} : { "placeHolder": input.placeholder } });

				if (value !== undefined) {
					await vscode.commands.executeCommand(input.submit.command, ...input.submit.arguments ?? [], value);
				}
			})
		]
	};
}
