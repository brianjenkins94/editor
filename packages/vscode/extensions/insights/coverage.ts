/**
 * Coverage, with nothing to ask for: every debug session that reports coverage — every tsval run, from the terminal or
 * F5 — leaves its file marked when it ends, and when it pauses: a bar in the gutter for each line that ran, another for
 * each line that didn't, and on hover how often it ran. Editing the file clears its marks (they'd be stale); the next
 * run brings them back.
 *
 * It takes a session's `coverage` custom event (its final coverage, just before it ends) and, when it stops, its
 * `getCoverage` custom request (coverage so far): a CoverageReport — every statement the program can run, with how often
 * it ran. tsval's are exact (every statement passes through its interpreter); another adapter can report the same.
 */
import type { CoverageReport } from "../worker-pod/debug-protocol";
import * as vscode from "vscode";

/** A gutter bar, as VS Code's own coverage draws one. */
function bar(color: string): vscode.Uri {
	return vscode.Uri.parse("data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="20"><rect x="5" width="3" height="20" fill="${color}"/></svg>`));
}

/** Each line's coverage: whether every statement that starts on it ran, and how often its first one did. */
function lines(report: CoverageReport): Map<number, { "ran": boolean; "count": number }> {
	const byLine = new Map<number, { "ran": boolean; "count": number }>();

	for (const { start, count } of report.statements) {
		const line = byLine.get(start[0]);

		byLine.set(start[0], line === undefined ? { "ran": count > 0, "count": count } : { "ran": line.ran && count > 0, "count": line.count });
	}

	return byLine;
}

export function registerCoverage(context: vscode.ExtensionContext): void {
	const ran = vscode.window.createTextEditorDecorationType({ "gutterIconPath": bar("#2ea04370"), "gutterIconSize": "contain", "overviewRulerColor": "#2ea04340", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const missed = vscode.window.createTextEditorDecorationType({ "gutterIconPath": bar("#f85149c0"), "gutterIconSize": "contain", "overviewRulerColor": "#f85149a0", "overviewRulerLane": vscode.OverviewRulerLane.Left, "backgroundColor": "#f8514910", "isWholeLine": true });
	/** The latest coverage, by file path. */
	const reports = new Map<string, CoverageReport>();

	const draw = (editor: vscode.TextEditor): void => {
		const report = reports.get(editor.document.uri.path);
		const ranLines: vscode.DecorationOptions[] = [];
		const missedLines: vscode.DecorationOptions[] = [];

		for (const [line, { "ran": didRun, count }] of report === undefined ? [] : lines(report)) {
			if (line < editor.document.lineCount) {
				const range = editor.document.lineAt(line).range;

				(didRun ? ranLines : missedLines).push({ "range": range, "hoverMessage": didRun ? `Ran ${count}×` : "Didn't run" });
			}
		}

		editor.setDecorations(ran, ranLines);
		editor.setDecorations(missed, missedLines);
	};

	const show = (report: CoverageReport | undefined): void => {
		if (report === undefined || report.statements.length === 0) {
			return;
		}

		reports.set(report.file, report);

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.path === report.file) {
				draw(editor);
			}
		}
	};

	context.subscriptions.push(ran, missed,
		// A session's final coverage, as it ends.
		vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
			if (event.event === "coverage") {
				show(event.body as CoverageReport);
			}
		}),
		// Paused: what has run so far.
		vscode.debug.onDidChangeActiveStackItem((item) => {
			if (item !== undefined && item.session.type === "tsval") {
				void Promise.resolve(item.session.customRequest("getCoverage")).then((report) => { show(report as CoverageReport); }, () => undefined);
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				draw(editor);
			}
		}),
		// Edited: the marks no longer match the lines.
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0 && reports.delete(event.document.uri.path)) {
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document === event.document) {
						draw(editor);
					}
				}
			}
		})
	);
}
