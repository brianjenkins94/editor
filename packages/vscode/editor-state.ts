/**
 * What the editor shows, as data — for agents (debug-mcp's `editor`, `problems` and `notifications` tools, page-tools.ts),
 * which would otherwise read it off the DOM or know VS Code's API and which frame it's in:
 *
 * - `editor.state`: the file in front of you — its cursor, selections and the lines in view, unsaved or not — and every
 *   editor tab open, by group;
 * - `problems.list` { file?, limit? }: the Problems view's diagnostics, each with its source (TypeScript, eslint, notes,
 *   a capability tripwire), severity, range and message;
 * - `notifications.list`: the notifications showing — the toasts and the notification center's — which the extension API
 *   can't list (the component reads the notification service's model).
 *
 * Lines and columns are 1-based, as an agent reads code. Runs in the workbench realm (core), with its own extension API.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import { shownNotifications } from "@brianjenkins94/monaco-vscode-api/main";

/** A selection's text, at most this long (a whole file selected isn't what the tool is for). */
const MAX_SELECTED = 500;

/** Diagnostics answered, by default, at most. */
const PROBLEMS = 200;

const SEVERITIES = ["error", "warning", "info", "hint"] as const;

export function installEditorState(hub: Hub, vscode: typeof vscodeApi): void {
	const at = (position: vscodeApi.Position): { "line": number; "column": number } => ({ "line": position.line + 1, "column": position.character + 1 });
	/** A file's path in the workspace — relative, as the tools take it — or its URI when it isn't a file. */
	const pathOf = (uri: vscodeApi.Uri): string => (uri.scheme === "file" ? vscode.workspace.asRelativePath(uri, false) : uri.toString());

	serve(hub, "editor.state", () => {
		const editor = vscode.window.activeTextEditor;
		const document = editor?.document;

		return {
			"active": editor === undefined || document === undefined ? null : {
				"file": pathOf(document.uri),
				"language": document.languageId,
				"lines": document.lineCount,
				"dirty": document.isDirty,
				"cursor": at(editor.selection.active),
				"selections": editor.selections.filter((selection) => !selection.isEmpty).map((selection) => {
					const text = document.getText(selection);

					return { "start": at(selection.start), "end": at(selection.end), "text": text.length > MAX_SELECTED ? text.slice(0, MAX_SELECTED) + "…" : text };
				}),
				"visible": editor.visibleRanges.map((range) => ({ "from": range.start.line + 1, "to": range.end.line + 1 }))
			},
			"tabs": vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => {
				const input = tab.input as { "uri"?: vscodeApi.Uri } | undefined;

				return { "label": tab.label, ...input?.uri === undefined ? {} : { "file": pathOf(input.uri) }, "group": group.viewColumn, "active": tab.isActive && group.isActive, "dirty": tab.isDirty };
			}))
		};
	});

	serve(hub, "problems.list", (args) => {
		const { file, limit } = (args ?? {}) as { "file"?: unknown; "limit"?: unknown };
		const wanted = typeof file === "string" && file !== "" ? vscode.workspace.asRelativePath(file.startsWith("/") ? vscode.Uri.file(file) : vscode.Uri.file(`/workspace/${file}`), false) : undefined;
		const all = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => (wanted !== undefined && pathOf(uri) !== wanted ? [] : diagnostics.map((diagnostic) => ({
			"file": pathOf(uri),
			"line": diagnostic.range.start.line + 1,
			"column": diagnostic.range.start.character + 1,
			"endLine": diagnostic.range.end.line + 1,
			"endColumn": diagnostic.range.end.character + 1,
			"severity": SEVERITIES[diagnostic.severity],
			...diagnostic.source === undefined ? {} : { "source": diagnostic.source },
			...diagnostic.code === undefined ? {} : { "code": String(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code) },
			"message": diagnostic.message
		}))));
		// Errors first, then by file and line.
		const sorted = all.toSorted((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
		const most = typeof limit === "number" && limit > 0 ? limit : PROBLEMS;

		return { "total": sorted.length, "problems": sorted.slice(0, most) };
	});

	serve(hub, "notifications.list", async () => shownNotifications());
}
