/**
 * Coverage, with nothing to ask for: every debug session that reports coverage — every tsval run, from the terminal or
 * F5 — leaves its file marked when it ends, and when it pauses: in the notes margin's strip (live-values.ts), a mark
 * beside each line that ran, another beside each line that didn't, and on hover how often it ran; and the same colors in
 * the scrollbar. Not in the gutter: VS Code won't set a breakpoint where another extension's icon is (its
 * `marginFreeFromNonDebugDecorations`), so the glyph margin stays the breakpoints'.
 *
 * Two sources, the freshest first:
 *  - the session's own report — its `coverage` custom event (its final coverage, just before it ends) and, when it stops,
 *    its `getCoverage` custom request (coverage so far): every statement the program can run, with how often it ran, in
 *    the text that ran (sent with it). Each statement is anchored there (anchors.ts: its BABLR span) and marked on the
 *    line it's on now, so it follows its code through edits and cosmetic changes — a reformat keeps every mark; a
 *    statement edited past recognizing loses its.
 *  - the evidence kept in git (RUNTIME-EVIDENCE.md; read through the insights extension's evidence store, here with core's
 *    own API): everyone's runs, in every environment, folded together. It outlives the session and follows the code: a
 *    statement you didn't touch keeps its marks when code around it moves or changes; one you edited loses them until it
 *    runs again. A file BABLR's grammar doesn't take yet has no evidence, only its sessions' reports.
 *
 * Runs in the workbench realm (core), with the workbench's own extension API.
 */
import type * as vscodeApi from "vscode";
import type { PaneMark } from "@brianjenkins94/monaco-vscode-api/main";
import type { EvidenceStore } from "./extensions/insights/evidence";
import type { CoverageReport } from "./extensions/worker-pod/debug-protocol";
import { Anchors, offsetOf } from "./anchors";

/** What evidence says of a line: whether every evidenced statement starting on it ran, in how many runs, and when last. */
interface LineEvidence { "ever": number; "runs": number; "lastAt": string; "ran": boolean }

/** Each line's coverage: whether every statement that starts on it ran, and how often its first one did — each
 *  statement on the line `lineOf` says it's on now (undefined: its code is gone). */
function lines(report: CoverageReport, lineOf: (index: number) => number | undefined): Map<number, { "ran": boolean; "count": number }> {
	const byLine = new Map<number, { "ran": boolean; "count": number }>();

	for (const [index, { count }] of report.statements.entries()) {
		const at = lineOf(index);

		if (at !== undefined) {
			const line = byLine.get(at);

			byLine.set(at, line === undefined ? { "ran": count > 0, "count": count } : { "ran": line.ran && count > 0, "count": line.count });
		}
	}

	return byLine;
}

/** Mark each editor's lines in its margin's strip (`mark`: by file URI) and its scrollbar, as sessions report and
 *  evidence changes. */
export function installCoverage(vscode: typeof vscodeApi, store: EvidenceStore, mark: (uri: string, marks: PaneMark[]) => void): void {
	// The scrollbar's marks: a decoration with no gutter icon, so breakpoints can still be set on the line.
	const ran = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#2ea04340", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const missed = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#f85149a0", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	/** The latest session's coverage, by file path, with its statements' anchors in the text that ran. */
	const reports = new Map<string, { "report": CoverageReport; "anchors"?: Anchors }>();
	const paint = (editor: vscodeApi.TextEditor, marks: Iterable<[number, { "ran": boolean; "hover": string }]>): void => {
		const shown: PaneMark[] = [];
		const ranLines: vscodeApi.Range[] = [];
		const missedLines: vscodeApi.Range[] = [];

		for (const [line, { "ran": didRun, hover }] of marks) {
			if (line < editor.document.lineCount) {
				shown.push({ "line": line, "kind": didRun ? "coverage-ran" : "coverage-missed", "title": hover });
				(didRun ? ranLines : missedLines).push(editor.document.lineAt(line).range);
			}
		}

		mark(editor.document.uri.toString(), shown);
		editor.setDecorations(ran, ranLines);
		editor.setDecorations(missed, missedLines);
	};

	/** The evidence's marks for the document as it is now: each statement with evidence found in it, on the line it starts. */
	const evidenceMarks = async (document: vscodeApi.TextDocument): Promise<Map<number, LineEvidence> | undefined> => {
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

	const draw = (editor: vscodeApi.TextEditor): void => {
		const known = reports.get(editor.document.uri.path);

		if (known !== undefined) {
			const { report, anchors } = known;
			const version = editor.document.version;
			// Each statement by its anchor (its head, for one with a body), else its own range.
			const ranges = anchors === undefined ? [] : report.statements.map(({ start, end, anchor }): [number, number] => anchor ?? [offsetOf(anchors.text, start), offsetOf(anchors.text, end)]);

			// Where each statement is now (as it ran, with no text to anchor in).
			void (anchors === undefined ? Promise.resolve(report.statements.map(({ start }) => start[0])) : anchors.lines(editor.document.getText(), ranges)).then((now) => {
				if (editor.document.version === version && reports.get(editor.document.uri.path) === known) {
					paint(editor, [...lines(report, (index) => now[index])].map(([line, { "ran": didRun, count }]) => [line, { "ran": didRun, "hover": didRun ? `Ran ${count}×` : "Didn't run" }]));
				}
			});

			return;
		}

		void evidenceMarks(editor.document).then((marks) => {
			if (marks !== undefined && !reports.has(editor.document.uri.path)) {
				paint(editor, [...marks].map(([line, each]) => [line, { "ran": each.ran, "hover": each.ran ? `Ran in ${each.ever} run${each.ever === 1 ? "" : "s"} since it last changed · last ${new Date(each.lastAt).toLocaleString()}` : `Didn't run in ${Math.max(1, Math.round(each.runs))} recent run${Math.round(each.runs) > 1 ? "s" : ""}` }]));
			}
		});
	};

	const redraw = (document?: vscodeApi.TextDocument): void => {
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

		reports.set(report.file, { "report": report, ...report.source === undefined ? {} : { "anchors": new Anchors(vscode, report.file, report.source) } });

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.path === report.file) {
				draw(editor);
			}
		}
	};

	store.onDidChange(() => { redraw(); });
	// A session's final coverage, as it ends.
	vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
		if (event.event === "coverage") {
			show(event.body as CoverageReport);
		}
	});
	// Paused: what has run so far.
	vscode.debug.onDidChangeActiveStackItem((item) => {
		if (item !== undefined && item.session.type === "tsval") {
			void Promise.resolve(item.session.customRequest("getCoverage")).then((report) => { show(report as CoverageReport); }, () => undefined);
		}
	});
	vscode.window.onDidChangeVisibleTextEditors((editors) => {
		for (const editor of editors) {
			draw(editor);
		}
	});
	// Edited: every mark follows its statement's span — the session's and the evidence's alike.
	vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.contentChanges.length === 0) {
			return;
		}

		clearTimeout(typing);
		typing = setTimeout(() => { redraw(event.document); }, 400);
	});
	redraw();
}
