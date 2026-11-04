/**
 * Coverage, with nothing to ask for: every run a debugger reports on (its `coverage` event, as it ends) leaves its files marked,
 * in the Margin's gutter column, just left of the code (a pane view of its own into the Margin): a mark beside each line that ran
 * and beside each that didn't, saying how often, and the same colors in the scrollbar. Not in the glyph margin: VS Code won't set
 * a breakpoint where another extension's icon is, so that stays the breakpoints'.
 *
 * Each program's latest run of a file counts, so a line didn't run only if no run of any program reached it, and a test
 * suite's coverage adds up. Each statement is found again in the text as it is now (anchors.ts, its BABLR span), so a mark
 * follows its code through edits and a reformat; one edited past recognizing loses its mark until it runs again.
 *
 * Runs this session only: kept across a reload, they'd need the statements that didn't run, which the run record doesn't hold.
 */
import type { CoverageEvent } from "@brianjenkins94/editor-api";
import type { PaneMark } from "@brianjenkins94/editor-api/pane";
import { Anchors, offsetOf } from "@brianjenkins94/editor-api/anchors";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import * as vscode from "vscode";

/** The view coverage is, into the Margin. */
const VIEW = "coverage";

/** How long after typing stops the marks are found again: BABLR reads the whole file. */
const TYPING_MS = 400;

/** A file's latest report from each program that ran it, with its text to find statements from. */
type Reports = Map<string, { "report": CoverageEvent; "anchors": Anchors }>;

/** A line's coverage: whether every statement starting on it ran, some did, and how often the most-run one did. */
interface Line { "all": boolean; "some": boolean; "count": number }

function markOf(line: number, { all, some, count }: Line): PaneMark {
	const at = { "lines": [line, line] as [number, number] };

	if (all) {
		return { "at": at, "kind": "ran", "title": `Ran ${String(count)}×` };
	}

	return some ? { "at": at, "kind": "partial", "title": "Partly ran: some of it didn't" } : { "at": at, "kind": "missed", "title": "Didn't run" };
}

export function installCoverage(context: vscode.ExtensionContext): void {
	// (the scrollbar's: a decoration with no gutter icon, so breakpoints can still be set on the line)
	const ran = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#2ea04340", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const missed = vscode.window.createTextEditorDecorationType({ "overviewRulerColor": "#f85149a0", "overviewRulerLane": vscode.OverviewRulerLane.Left });
	const reports = new Map<string, Reports>();
	const marked = new Map<string, PaneMark[]>();

	/** Each line of `document` by what ran of it, in every report of it: a statement ran if any report's did. */
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
		// (in the scrollbar, a line that only partly ran is one with something that didn't)
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
