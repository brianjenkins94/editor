import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { shownNotifications, traceLog } from "@brianjenkins94/monaco-vscode-api/main";

const MAX_SELECTED = 500;

const PROBLEMS = 200;

const SEVERITIES = ["error", "warning", "info", "hint"] as const;

const TRACE_SECONDS = 30;
const TRACE_MOST = 300;

export function installEditorState(hub: Hub, vscode: typeof vscodeApi, log: Logger): void {
	const at = (position: vscodeApi.Position): { "line": number; "column": number } => ({ "line": position.line + 1, "column": position.character + 1 });
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
		const sorted = all.toSorted((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity) || left.file.localeCompare(right.file) || left.line - right.line);
		const most = typeof limit === "number" && limit > 0 ? limit : PROBLEMS;

		return { "total": sorted.length, "problems": sorted.slice(0, most) };
	});

	serve(hub, "notifications.list", async () => shownNotifications());

	const trace = (component: string, seconds: unknown, also?: (line: string) => void): { "lasting": number; "window": Promise<void> } => {
		const lasting = Math.min(typeof seconds === "number" && seconds > 0 ? seconds : TRACE_SECONDS, TRACE_MOST);
		const wanted = component.trim().toLowerCase();
		const window = traceLog((message) => message.toLowerCase().includes(wanted), (level, message) => {
			log.info(message, { "source": "vscode-trace", "level": level, "component": component });
			also?.(`${new Date().toISOString().slice(11, 23)} [${String(level)}] ${message}`);
		}, lasting * 1000);

		return { "lasting": lasting, "window": window };
	};

	serve(hub, "editor.trace", (args) => {
		const { component, seconds } = (args ?? {}) as { "component"?: unknown; "seconds"?: unknown };

		if (typeof component !== "string" || component.trim() === "") {
			throw new TypeError("editor.trace takes { component, seconds? }: the text its messages carry (\"text file model\", say)");
		}

		const { lasting, window } = trace(component, seconds);

		return Promise.race([window.then(() => ({ "closed": true })), new Promise((resolve) => {
			setTimeout(resolve, 50);
		}).then(() => ({ "tracing": component, "until": new Date(Date.now() + lasting * 1000).toISOString(), "read": `logs_query or logs_wait with source vscode-trace (or the text "${component}")` }))]);
	});

	let output: vscodeApi.OutputChannel | undefined;

	vscode.commands.registerCommand("editor.trace.show", async () => {
		const component = await vscode.window.showInputBox({ "title": "Trace a VS Code Component", "prompt": "Text its messages carry, as VS Code writes them", "placeHolder": "text file model, extension host, configuration…" });

		if (component === undefined || component.trim() === "") {
			return;
		}

		output ??= vscode.window.createOutputChannel("VS Code Trace");
		output.show(true);
		output.appendLine(`Tracing "${component.trim()}" for ${String(TRACE_SECONDS)} s…`);

		const { window } = trace(component, TRACE_SECONDS, (line) => { output?.appendLine(line); });

		void window.then(() => { output?.appendLine(`Done tracing "${component.trim()}".`); }, (error: unknown) => { output?.appendLine(`Couldn't trace: ${error instanceof Error ? error.message : String(error)}`); });
	});
}
