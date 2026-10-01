/**
 * Insights — what a program did when it ran, shown with VS Code's own UI.
 *
 * Coverage (this half): "Run File with Coverage" runs the file under the tsval debugger without stopping at
 * breakpoints (`noDebug`), and reports the coverage it ends with through a TestController's coverage run — so VS Code
 * itself draws it: the gutters, the Explorer's percentages and the Test Coverage view; "Show Coverage So Far" does the same
 * for the active debug session, paused or running. The extension knows nothing of
 * how coverage is measured. It takes any debug session's `coverage` custom event (and a session's `getCoverage` custom
 * request answers the same mid-run): a CoverageReport — every statement the program can run, with how often it ran.
 * tsval's are exact (every statement passes through its interpreter); another adapter can report the same.
 */
import type { CoverageReport } from "../worker-pod/debug-protocol";
import * as vscode from "vscode";

/** A debug session started for a coverage run carries this in its configuration, so its events find their run. */
const RUN_KEY = "__insightsCoverageRun";

/** The statement detail behind each file's coverage, for when VS Code asks for it (opening the file, the gutters). */
const details = new WeakMap<vscode.FileCoverage, vscode.StatementCoverage[]>();

export function activate(context: vscode.ExtensionContext): void {
	const controller = vscode.tests.createTestController("insights.coverage", "Insights");
	const profile = controller.createRunProfile("Run with Coverage", vscode.TestRunProfileKind.Coverage, () => undefined, true);

	profile.loadDetailedCoverage = (_run, coverage) => Promise.resolve(details.get(coverage) ?? []);

	context.subscriptions.push(controller, vscode.commands.registerCommand("insights.runFileWithCoverage", async (resource?: vscode.Uri) => {
		const uri = resource ?? vscode.window.activeTextEditor?.document.uri;

		if (uri === undefined) {
			return;
		}

		const name = uri.path.split("/").pop() ?? uri.path;
		// Persisted: it stays in Test Results across a reload — and writing it creates VS Code's results folder, which
		// the store's occasional cleanup otherwise fails to find (an unhandled rejection) when nothing has been saved yet.
		const run = controller.createTestRun(new vscode.TestRunRequest(undefined, undefined, profile), "Coverage · " + name, true);

		try {
			const report = await runWithCoverage(uri);

			if (report === undefined) {
				run.appendOutput("The run ended without reporting coverage.\r\n");
			} else {
				run.addCoverage(fileCoverage(report));
			}
		} catch (error) {
			run.appendOutput(String(error) + "\r\n");
		} finally {
			run.end();
		}
	}), vscode.commands.registerCommand("insights.showSessionCoverage", async () => {
		// Paused mid-run (or still running): what has run so far, from the session's getCoverage.
		const session = vscode.debug.activeDebugSession;

		if (session === undefined) {
			return;
		}

		const run = controller.createTestRun(new vscode.TestRunRequest(undefined, undefined, profile), "Coverage · " + session.name + " (so far)", true);

		try {
			run.addCoverage(fileCoverage(await session.customRequest("getCoverage") as CoverageReport));
		} catch (error) {
			run.appendOutput(session.name + " didn't report coverage: " + String(error) + "\r\n");
		} finally {
			run.end();
		}
	}));
}

/** Run `uri` under tsval without stopping at breakpoints, and resolve with the coverage it ends with (undefined if the
 *  session ends without reporting any). */
async function runWithCoverage(uri: vscode.Uri): Promise<CoverageReport | undefined> {
	const id = crypto.randomUUID();
	const ours = (session: vscode.DebugSession): boolean => session.configuration[RUN_KEY] === id;
	const disposables: vscode.Disposable[] = [];
	const report = new Promise<CoverageReport | undefined>((resolve) => {
		disposables.push(
			vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
				if (ours(event.session) && event.event === "coverage") {
					resolve(event.body as CoverageReport);
				}
			}),
			// The coverage event comes before the session ends, so an end without one means there wasn't any.
			vscode.debug.onDidTerminateDebugSession((session) => {
				if (ours(session)) {
					resolve(undefined);
				}
			})
		);
	});

	try {
		const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "Coverage " + uri.path.split("/").pop(), "program": uri.path, [RUN_KEY]: id }, { "noDebug": true });

		if (!started) {
			throw new Error("couldn't start the tsval debugger");
		}

		return await report;
	} finally {
		for (const disposable of disposables) {
			disposable.dispose();
		}
	}
}

function fileCoverage(report: CoverageReport): vscode.FileCoverage {
	const statements = report.statements.map(({ start, end, count }) => new vscode.StatementCoverage(count, new vscode.Range(start[0], start[1], end[0], end[1])));
	const coverage = vscode.FileCoverage.fromDetails(vscode.Uri.file(report.file), statements);

	details.set(coverage, statements);

	return coverage;
}
