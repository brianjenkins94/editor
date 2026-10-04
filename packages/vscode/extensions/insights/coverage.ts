/**
 * Coverage, with nothing to ask for: every debug session that reports coverage — every tsval run, from the terminal or
 * F5 — leaves its file marked when it ends, and when it pauses: a bar in the gutter for each line that ran, another for
 * each line that didn't, and on hover how often it ran.
 *
 * Two sources, the freshest first:
 *  - the session's own report — its `coverage` custom event (its final coverage, just before it ends) and, when it stops,
 *    its `getCoverage` custom request (coverage so far): every statement the program can run, with how often it ran.
 *    Exact for the text that ran, so editing the file drops it.
 *  - the evidence kept in git (RUNTIME-EVIDENCE.md): `.silo/evidence/<user>/<environment>/<file>.jsonl`, written as each
 *    run ends, keyed on BABLR spans — everyone's runs, in every environment, folded together. It outlives the session and
 *    follows the code: a statement you didn't touch keeps its marks when code around it moves or changes; one you edited
 *    loses them until it runs again. The open document's spans come from the editor's BABLR worker (worker-pod's
 *    `editor.bablr.spans` command); a file BABLR's grammar doesn't take yet has no evidence, only its sessions' reports.
 */
import type { Observation } from "@brianjenkins94/util/silo/evidence";
import type { CoverageReport } from "../worker-pod/debug-protocol";
import { parseEvidence, SILO_DIR } from "@brianjenkins94/util/silo/evidence";
import * as vscode from "vscode";

/** A span's evidence, every user's and environment's folded together. */
interface SpanEvidence { "ever": number; "runs": number; "lastAt": string }

/** What evidence says of a line: whether every evidenced statement starting on it ran, in how many runs, and when last. */
interface LineEvidence extends SpanEvidence { "ran": boolean }

/** The text's BABLR spans, from the editor's one BABLR worker through worker-pod's command; undefined where there's no such
 *  command (VS Code without the editor) or BABLR's grammar doesn't take the text. */
async function spansOf(source: string): Promise<{ "id": string; "start": number; "end": number }[] | undefined> {
	try {
		return await vscode.commands.executeCommand<{ "id": string; "start": number; "end": number }[] | undefined>("editor.bablr.spans", source);
	} catch {
		return undefined;
	}
}

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
	/** The latest session's coverage, by file path — until the file is edited. */
	const reports = new Map<string, CoverageReport>();
	/** The evidence kept for each file (by workspace-relative path), read when first shown and again when it changes. */
	const evidence = new Map<string, Promise<Map<string, SpanEvidence>>>();

	const evidenceOf = (path: string): Promise<Map<string, SpanEvidence>> => {
		let known = evidence.get(path);

		if (known === undefined) {
			known = (async () => {
				const bySpan = new Map<string, SpanEvidence>();

				// `.silo/evidence/<user>/<environment>/<file>.jsonl`, read where the layout puts it rather than searched for.
				const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
				const folders = async (uri: vscode.Uri): Promise<string[]> => Promise.resolve(vscode.workspace.fs.readDirectory(uri)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => []);
				const evidence = vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`);
				const files: vscode.Uri[] = [];

				for (const user of await folders(evidence)) {
					for (const environment of await folders(vscode.Uri.joinPath(evidence, user))) {
						files.push(vscode.Uri.joinPath(evidence, user, environment, `${path}.jsonl`));
					}
				}

				for (const uri of files) {
					const text = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");

					for (const observation of parseEvidence(text).filter((each: Observation) => each.kind === "reached")) {
						const before = bySpan.get(observation.span);

						bySpan.set(observation.span, { "ever": (before?.ever ?? 0) + observation.ever, "runs": (before?.runs ?? 0) + observation.runs, "lastAt": before !== undefined && before.lastAt > observation.lastAt ? before.lastAt : observation.lastAt });
					}
				}

				return bySpan;
			})().catch(() => new Map<string, SpanEvidence>());
			evidence.set(path, known);
		}

		return known;
	};

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

	/** The evidence's marks for the document as it is now: each evidenced span found in it, on the line it starts. */
	const evidenceMarks = async (document: vscode.TextDocument): Promise<Map<number, LineEvidence> | undefined> => {
		const known = await evidenceOf(vscode.workspace.asRelativePath(document.uri, false));

		if (known.size === 0) {
			return new Map();
		}

		const version = document.version;
		const anchors = await spansOf(document.getText());

		if (anchors === undefined || document.version !== version) {
			return anchors === undefined ? new Map() : undefined; // unparsable: nothing to show; edited since: a newer draw follows
		}

		const byLine = new Map<number, LineEvidence>();

		for (const anchor of anchors) {
			const span = known.get(anchor.id);

			if (span !== undefined) {
				const line = document.positionAt(anchor.start).line;
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
	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/evidence/**/*.jsonl`);
	const changed = (uri: vscode.Uri): void => {
		// `.silo/evidence/<user>/<environment>/<file>.jsonl` → <file>
		const file = /\/\.silo\/evidence\/[^/]+\/[^/]+\/(.+)\.jsonl$/u.exec(uri.path)?.[1];

		if (file !== undefined && evidence.delete(file)) {
			redraw();
		}
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

	context.subscriptions.push(ran, missed, watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
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
