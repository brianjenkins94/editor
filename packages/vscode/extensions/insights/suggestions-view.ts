/**
 * The Suggestions view, in the panel beside Problems: everything runs say could go (suggestions.ts), in every file with
 * evidence, open or not — VS Code's Problems view doesn't list hints. A file, then its suggestions in order, each with
 * its line and how sure it is; a click goes to it, and one with a fix has it on its row. The count is the view's badge.
 */
import type { FileSuggestions, SuggestionSource } from "./fixes";
import type { Suggestion } from "./suggestions";
import * as vscode from "vscode";

type Item = { "kind": "file"; "file": string; "found": FileSuggestions } | { "kind": "suggestion"; "found": FileSuggestions; "suggestion": Suggestion };

/** `offset` in `text`, as a position. */
function positionAt(text: string, offset: number): vscode.Position {
	const before = text.slice(0, offset);
	const line = before.split("\n").length - 1;

	return new vscode.Position(line, offset - (before.lastIndexOf("\n") + 1));
}

const rangeOf = (text: string, start: number, end: number): vscode.Range => new vscode.Range(positionAt(text, start), positionAt(text, end));

export function registerSuggestionsView(context: vscode.ExtensionContext, source: SuggestionSource): void {
	const changed = new vscode.EventEmitter<undefined>();
	const purple = new vscode.ThemeColor("charts.purple");
	const provider: vscode.TreeDataProvider<Item> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (item) => (item === undefined
			? [...source.all()].sort(([a], [b]) => a.localeCompare(b)).map(([file, found]): Item => ({ "kind": "file", "file": file, "found": found }))
			: item.kind === "file" ? item.found.suggestions.toSorted((a, b) => a.start - b.start).map((suggestion): Item => ({ "kind": "suggestion", "found": item.found, "suggestion": suggestion })) : []),
		"getTreeItem": (item) => {
			if (item.kind === "file") {
				const tree = new vscode.TreeItem(item.found.uri, vscode.TreeItemCollapsibleState.Expanded);
				const folder = item.file.includes("/") ? item.file.slice(0, item.file.lastIndexOf("/")) : "";

				tree.description = `${folder}${folder === "" ? "" : " · "}${item.found.suggestions.length}`;

				return tree;
			}

			const { suggestion, found } = item;
			const range = rangeOf(found.text, suggestion.start, suggestion.end);
			const tree = new vscode.TreeItem(suggestion.label, vscode.TreeItemCollapsibleState.None);

			tree.description = `Ln ${range.start.line + 1} · ${suggestion.evidence}`;
			tree.tooltip = new vscode.MarkdownString(suggestion.message);
			tree.iconPath = new vscode.ThemeIcon("lightbulb", purple);
			tree.contextValue = suggestion.fix === undefined ? "suggestion" : "suggestion.fixable";
			tree.command = { "command": "vscode.open", "title": "Go to it", "arguments": [found.uri, { "selection": range }] };

			return tree;
		}
	};
	const view = vscode.window.createTreeView("insights.suggestions", { "treeDataProvider": provider, "showCollapseAll": true });
	const refresh = (): void => {
		const total = [...source.all().values()].reduce((sum, found) => sum + found.suggestions.length, 0);

		view.badge = total === 0 ? undefined : { "value": total, "tooltip": `${total} suggestion${total === 1 ? "" : "s"} from runs` };
		view.message = total === 0 ? "Nothing to suggest yet: run a program a few times (F5 — mock its process.argv in the notes margin to give it other inputs), and what none of the runs needed shows here." : undefined;
		changed.fire(undefined);
	};

	context.subscriptions.push(changed, view, source.onDidChange(refresh),
		vscode.commands.registerCommand("insights.applySuggestion", async (item?: Item) => {
			const fix = item?.kind === "suggestion" ? item.suggestion.fix : undefined;

			if (item === undefined || fix === undefined) {
				return;
			}

			const edit = new vscode.WorkspaceEdit();

			edit.replace(item.found.uri, rangeOf(item.found.text, fix.start, fix.end), fix.text);
			await vscode.workspace.applyEdit(edit);
		})
	);
	refresh();
}
