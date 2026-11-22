import type { CoverageEvent } from "@brianjenkins94/editor-api";
import type { PaneMark } from "@brianjenkins94/editor-api/pane";
import { Anchors, offsetOf } from "@brianjenkins94/editor-api/anchors";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import * as vscode from "vscode";

const VIEW = "coverage";

const TYPING_MS = 400;

type Reports = Map<string, { "report": CoverageEvent; "anchors": Anchors }>;

interface Line { "all": boolean; "some": boolean; "count": number }

function markOf(line: number, { all, some, count }: Line): PaneMark {
	const at = { "lines": [line, line] as [number, number] };

	if (all) {
		return { "at": at, "kind": "ran", "title": `Ran ${String(count)}×` };
	}

	return some ? { "at": at, "kind": "partial", "title": "Partly ran: some of it didn't" } : { "at": at, "kind": "missed", "title": "Didn't run" };
}

export function installCoverage(context: vscode.ExtensionContext): void {
	const ran = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#2ea04340", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const missed = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#f85149a0", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const reports = new Map<string, Reports>();
	const marked = new Map<string, PaneMark[]>();

	const linesOf = async (document: vscode.TextDocument, ofFile: Reports): Promise<Map<number, Line>> => {
		const text = document.getText();
		const statements = new Map<string, { "line": number; "count": number }>();

		for (const { report, anchors } of ofFile.values()) {
			const ranges = report.statements.map(({ start, end, anchor }): [number, number] => anchor ?? [offsetOf(anchors.text, start), offsetOf(anchors.text, end)]);
			const now = await anchors.lines(text, ranges);

			for (const [index, { start, end, count }] of report.statements.entries()) {
				const line = now[index];

				if (line !== undefined) {
					const key = `${String(line)}:${String(end[0] - start[0])}:${String(start[1])}:${String(end[1])}`;

					statements.set(key, { "line": line, "count": (statements.get(key)?.count ?? 0) + count });
				}
			}
		}

		const lines = new Map<number, Line>();

		for (const { line, count } of statements.values()) {
			const known = lines.get(line);

			lines.set(line, known === undefined ? { "all": count > 0, "some": count > 0, "count": count } : { "all": known.all && count > 0, "some": known.some || count > 0, "count": Math.max(known.count, count) });
		}

		return lines;
	};

	const draw = async (editor: vscode.TextEditor): Promise<void> => {
		const { document } = editor;
		const uri = document.uri.toString();
		const ofFile = reports.get(document.uri.path);

		if (ofFile === undefined) {
			return;
		}

		const { version } = document;
		const lines = await linesOf(document, ofFile);

		if (document.version !== version) {
			return; // typed meanwhile: a newer draw follows
		}

		const inFile = [...lines].filter(([line]) => line < document.lineCount);

		marked.set(uri, inFile.map(([line, each]) => markOf(line, each)));
		editor.setDecorations(ran, inFile.filter(([, each]) => each.all).map(([line]) => document.lineAt(line).range));
		editor.setDecorations(missed, inFile.filter(([, each]) => !each.all).map(([line]) => document.lineAt(line).range));
		void refreshPane(vscode.commands, VIEW, uri);
	};

	const redraw = (document?: vscode.TextDocument): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			if (document === undefined || editor.document === document) {
				void draw(editor);
			}
		}
	};

	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(
		vscode.commands.registerCommand("coverage.paneView", (uri: unknown) => {
			const marks = typeof uri === "string" ? marked.get(uri) : undefined;

			return marks === undefined || marks.length === 0 ? undefined : { "items": [], "marks": marks };
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
			if (event === "coverage") {
				const program = String(session.configuration["program"] ?? session.id);
				const { files = [], ...entry } = body as CoverageEvent;

				for (const report of [entry, ...files].filter(({ source }) => source !== undefined)) {
					const ofFile = reports.get(report.file) ?? new Map() as Reports;

					ofFile.set(program, { "report": report, "anchors": new Anchors(vscode, report.file, report.source as string) });
					reports.set(report.file, ofFile);
				}

				redraw();
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors(() => {
			redraw();
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				clearTimeout(typing);
				typing = setTimeout(() => {
					redraw(event.document);
				}, TYPING_MS);
			}
		})
	);
}
