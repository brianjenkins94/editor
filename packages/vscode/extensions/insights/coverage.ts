/**
 * Coverage, with nothing to ask for: every debug session that reports coverage — every tsval run, from the terminal or
 * F5 — leaves its file marked when it ends, and when it pauses: a bar in the gutter for each line that ran, another for
 * each line that didn't, and on hover how often it ran.
 *
 * Two sources, the freshest first:
 *  - the session's own report — its `coverage` custom event (its final coverage, just before it ends) and, when it stops,
 *    its `getCoverage` custom request (coverage so far): every statement the program can run, with how often it ran.
 *    Exact for the text that ran, so editing the file drops it.
 *  - the evidence kept in git (RUNTIME-EVIDENCE.md; read through evidence.ts): everyone's runs, in every environment,
 *    folded together. It outlives the session and follows the code: a statement you didn't touch keeps its marks when
 *    code around it moves or changes; one you edited loses them until it runs again. A file BABLR's grammar doesn't take
 *    yet has no evidence, only its sessions' reports.
 */
import type { CoverageReport } from "../worker-pod/debug-protocol";
import type { EvidenceStore } from "./evidence";
import * as vscode from "vscode";

/** What evidence says of a line: whether every evidenced statement starting on it ran, in how many runs, and when last. */
interface LineEvidence { "ever": number; "runs": number; "lastAt": string; "ran": boolean }

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

export function registerCoverage(context: vscode.ExtensionContext, store: EvidenceStore): void {
	const ran = vscode.window.createTextEditorDecorationType({ "gutterIconPath": bar("#2ea04370"), "gutterIconSize": "contain", "overviewRulerColor": "#2ea04340", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const missed = vscode.window.createTextEditorDecorationType({ "gutterIconPath": bar("#f85149c0"), "gutterIconSize": "contain", "overviewRulerColor": "#f85149a0", "overviewRulerLane": vscode.OverviewRulerLane.Left, "backgroundColor": "#f8514910", "isWholeLine": true });
	/** The latest session's coverage, by file path — until the file is edited. */
	const reports = new Map<string, CoverageReport>();
	const paint = (editor: vscode.TextEditor, marks: Iterable<[number, { "ran": boolean; "hover": string }]>): void => {
		const ranLines: vscode.DecorationOptions[] = [];
		const missedLines: vscode.DecorationOptions[] = [];

		for (const [line, { "ran": didRun, hover }] of marks) {
			if (line < editor.document.lineCount) {
				(didRun ? ranLines : missedLines).push({ "range": editor.document.lineAt(line).range, "hoverMessage": hover });
			}
		}

		editor.setDecorations(ran, ranLines);
		editor.setDecorations(missed, missedLines);
	};

	/** The evidence's marks for the document as it is now: each statement with evidence found in it, on the line it starts. */
	const evidenceMarks = async (document: vscode.TextDocument): Promise<Map<number, LineEvidence> | undefined> => {
		const placed = await store.placed(document);

		if (placed === undefined) {
			return undefined; // edited since: a newer draw follows
		}

		const byLine = new Map<number, LineEvidence>();

		for (const { start, evidence } of placed) {
			const span = evidence.reached;

			if (span !== undefined) {
				const line = document.positionAt(start).line;
				const before = byLine.get(line);

				byLine.set(line, before === undefined ? { ...span, "ran": span.ever > 0 } : { ...before, "ran": before.ran && span.ever > 0 });
			}
		}

		return byLine;
	};

	const draw = (editor: vscode.TextEditor): void => {
		const report = reports.get(editor.document.uri.path);

		if (report !== undefined) {
			paint(editor, [...lines(report)].map(([line, { "ran": didRun, count }]) => [line, { "ran": didRun, "hover": didRun ? `Ran ${count}×` : "Didn't run" }]));

			return;
		}

		void evidenceMarks(editor.document).then((marks) => {
			if (marks !== undefined && !reports.has(editor.document.uri.path)) {
				paint(editor, [...marks].map(([line, mark]) => [line, { "ran": mark.ran, "hover": mark.ran ? `Ran in ${mark.ever} run${mark.ever === 1 ? "" : "s"} since it last changed · last ${new Date(mark.lastAt).toLocaleString()}` : `Didn't run in ${Math.max(1, Math.round(mark.runs))} recent run${Math.round(mark.runs) > 1 ? "s" : ""}` }]));
			}
		});
	};

	const redraw = (document?: vscode.TextDocument): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			if (document === undefined || editor.document === document) {
				draw(editor);
			}
		}
	};
	// Typing: draw once it pauses (BABLR re-reads the whole file).
	let typing: ReturnType<typeof setTimeout> | undefined;

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

	context.subscriptions.push(ran, missed, store.onDidChange(() => { redraw(); }),
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
		// Edited: the session's marks no longer match the lines; the evidence's follow the spans.
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length === 0) {
				return;
			}

			reports.delete(event.document.uri.path);
			clearTimeout(typing);
			typing = setTimeout(() => { redraw(event.document); }, 400);
		})
	);
}
