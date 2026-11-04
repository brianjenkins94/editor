/**
 * Features and their tests (packages/silo/README.md, *Tests by feature, in your face*), a side bar of its own: the feature
 * ledger's features by their status, each opening to its test files and those to their tests, each with how it last came out
 * here, and a button that runs them in the debugger. A feature is what you look at; its tests are under it. A test's outcome
 * is its kept trace's (test-runs.ts, `tests.outcomes`) until this session runs it, when it's the run's, with its time.
 *
 * Its data is the ledger as the workspace has it, read again as it changes. A workspace with no ledger has nothing to show.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { LedgerEntry } from "@brianjenkins94/util/silo/ledger";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import { createRpcClient } from "@brianjenkins94/hub";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { parseLedger } from "@brianjenkins94/util/silo/ledger";
import { isTestFile } from "./terminal/commands/node/node";

const ROOT = "/workspace";

/** The statuses, in the order they're shown; the first opens by itself. */
const STATUSES = ["active", "experiment", "parked", "removed"];

/** A test as it last came out. */
interface Outcome { "id": string; "file": string; "outcome": string; "ms"?: number; "error"?: string }

/** A row of the tree. */
type Row =
	| { "kind": "status"; "status": string; "features": [string, LedgerEntry][] }
	| { "kind": "feature"; "name": string; "entry": LedgerEntry }
	| { "kind": "file"; "file": string }
	| { "kind": "test"; "test": Outcome };

/** What a run answers (test-runs.ts): a question, what it's still doing, or each file's tests. */
interface Answer {
	"run"?: string;
	"running"?: string;
	"ask"?: { "message": string; "key": string };
	"files"?: { "file": string; "stalled"?: string; "error"?: string; "output"?: string; "tests": Outcome[] }[];
}

const passed = (test: Outcome): boolean => test.outcome === "pass";
const titleOf = (test: Outcome): string => test.id.split(" › ").slice(1).join(" › ");

export function installFeaturesView(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);
	const changed = new vscode.EventEmitter<undefined>();
	const ledgerUri = vscode.Uri.file(`${ROOT}/${ledgerPath()}`);
	/** Each test file's tests as they last came out; a file's run here replaces what its traces said. */
	const outcomes = new Map<string, Outcome[]>();
	/** What a file's last run here said instead of tests: it couldn't run them. */
	const failures = new Map<string, string>();
	/** Test folders the ledger names, walked: its files. */
	const folders = new Map<string, string[]>();
	const approved: string[] = [];
	const running = new Set<string>();
	let features: [string, LedgerEntry][] = [];

	/** The test files a ledger's `tests` entry is: itself, or what's in the folder it names. */
	const filesIn = async (entry: string): Promise<string[]> => {
		const uri = vscode.Uri.file(`${ROOT}/${entry}`);
		const type = await Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat) => stat.type, () => undefined);

		if (type !== vscode.FileType.Directory) {
			return [entry];
		}

		const found = folders.get(entry) ?? (await vscode.workspace.findFiles(new vscode.RelativePattern(uri, "**/*"), "**/node_modules/**")).map((each) => vscode.workspace.asRelativePath(each, false)).filter((path) => isTestFile(path)).sort((one, other) => one.localeCompare(other));

		folders.set(entry, found);

		return found;
	};

	const filesOf = async (entry: LedgerEntry): Promise<string[]> => [...new Set((await Promise.all((entry.tests ?? []).map(filesIn))).flat())];

	/** The ledger and how its tests last came out, read again. */
	const read = async (): Promise<void> => log.span("editor.workbench.features-view.read", { "path": ledgerPath() }, async (span) => {
		const text = await Promise.resolve(vscode.workspace.fs.readFile(ledgerUri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

		features = text === undefined ? [] : Object.entries(parseLedger(text));
		folders.clear();

		const { tests } = await rpc.request("tests.outcomes", {}, { "timeoutMs": 60_000, "waitForResponderMs": 60_000 }) as { "tests": Outcome[] };
		const byFile = Map.groupBy(tests, (test) => test.file);

		for (const [file, ofFile] of byFile) {
			outcomes.set(file, ofFile);
		}

		span.end({ "count": features.length, "tests": tests.length });
		changed.fire(undefined);
	});

	/** A sentence of how `files` came out: what passed, failed, and hasn't run here. */
	const summaryOf = (files: string[]): string => {
		if (files.length === 0) {
			return "no tests";
		}

		const tests = files.flatMap((file) => outcomes.get(file) ?? []);
		const failing = tests.filter((test) => !passed(test)).length + files.filter((file) => failures.has(file)).length;
		const notRun = files.filter((file) => !outcomes.has(file) && !failures.has(file)).length;

		return [`${String(files.length)} ${files.length === 1 ? "file" : "files"}`, tests.length === 0 ? "" : `${String(tests.length - tests.filter((test) => !passed(test)).length)} passing`, failing === 0 ? "" : `${String(failing)} failing`, notRun === 0 ? "" : `${String(notRun)} not run`].filter((part) => part !== "").join(" · ");
	};

	const iconOf = (files: string[]): vscodeApi.ThemeIcon => {
		if (files.some((file) => running.has(file))) {
			return new vscode.ThemeIcon("loading~spin");
		}

		if (files.length === 0) {
			return new vscode.ThemeIcon("circle-slash");
		}

		const tests = files.flatMap((file) => outcomes.get(file) ?? []);

		if (tests.some((test) => !passed(test)) || files.some((file) => failures.has(file))) {
			return new vscode.ThemeIcon("testing-failed-icon", new vscode.ThemeColor("testing.iconFailed"));
		}

		return files.every((file) => outcomes.has(file)) ? new vscode.ThemeIcon("testing-passed-icon", new vscode.ThemeColor("testing.iconPassed")) : new vscode.ThemeIcon("testing-unset-icon");
	};

	const provider: vscodeApi.TreeDataProvider<Row> = {
		"onDidChangeTreeData": changed.event,
		"getTreeItem": async (row) => {
			switch (row.kind) {
				case "status": {
					const item = new vscode.TreeItem(row.status, row.status === STATUSES[0] ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);

					item.description = String(row.features.length);
					item.contextValue = "status";

					return item;
				}

				case "feature": {
					const files = await filesOf(row.entry);
					const item = new vscode.TreeItem(row.name, files.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);

					item.description = summaryOf(files);
					item.tooltip = row.entry.what ?? row.entry.why;
					item.iconPath = iconOf(files);
					item.contextValue = files.length === 0 ? "feature" : "runnable";

					return item;
				}

				case "file": {
					const tests = outcomes.get(row.file) ?? [];
					const item = new vscode.TreeItem(row.file.split("/").at(-1) ?? row.file, tests.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
					const ms = tests.reduce((sum, test) => sum + (test.ms ?? 0), 0);

					item.description = failures.get(row.file) ?? (tests.length === 0 ? "not run" : `${String(tests.filter(passed).length)} of ${String(tests.length)}${ms === 0 ? "" : ` · ${String(Math.round(ms))} ms`}`);
					item.tooltip = row.file;
					item.iconPath = iconOf([row.file]);
					item.contextValue = "runnable";
					item.command = { "title": "Open", "command": "vscode.open", "arguments": [vscode.Uri.file(`${ROOT}/${row.file}`)] };

					return item;
				}

				default: {
					const item = new vscode.TreeItem(titleOf(row.test), vscode.TreeItemCollapsibleState.None);

					item.description = row.test.ms === undefined ? "" : `${String(Math.round(row.test.ms))} ms`;
					item.tooltip = row.test.error ?? row.test.id;
					item.iconPath = passed(row.test) ? new vscode.ThemeIcon("testing-passed-icon", new vscode.ThemeColor("testing.iconPassed")) : new vscode.ThemeIcon("testing-failed-icon", new vscode.ThemeColor("testing.iconFailed"));

					return item;
				}
			}
		},
		"getChildren": async (row) => {
			if (row === undefined) {
				return STATUSES.flatMap((status) => {
					const ofStatus = features.filter(([, entry]) => entry.status === status);

					return ofStatus.length === 0 ? [] : [{ "kind": "status" as const, "status": status, "features": ofStatus }];
				});
			}

			switch (row.kind) {
				case "status": return row.features.map(([name, entry]) => ({ "kind": "feature" as const, "name": name, "entry": entry }));
				case "feature": return (await filesOf(row.entry)).map((file) => ({ "kind": "file" as const, "file": file }));
				case "file": return (outcomes.get(row.file) ?? []).map((test) => ({ "kind": "test" as const, "test": test }));
				default: return [];
			}
		}
	};

	/** `files` run in the debugger, one at a time: each one's tests, or what stopped it. A capability stop is put to the person. */
	const run = async (files: string[]): Promise<void> => log.span("editor.workbench.features-view.run", { "count": files.length }, async (span) => {
		for (const file of files) {
			running.add(file);
		}

		changed.fire(undefined);

		try {
			await vscode.window.withProgress({ "location": { "viewId": "editor.features" } }, async () => {
				let answer = await rpc.request("tests.run", { "files": files, "approved": approved }, { "timeoutMs": 120_000, "waitForResponderMs": 60_000 }) as Answer;

				for (;;) {
					if (answer.ask !== undefined) {
						if (await vscode.window.showWarningMessage(answer.ask.message, "Allow") !== "Allow") {
							break;
						}

						approved.push(answer.ask.key);
						answer = await rpc.request("tests.run", { "files": files, "approved": approved }, { "timeoutMs": 120_000 }) as Answer;
					} else if (answer.running === undefined) {
						break;
					} else {
						answer = await rpc.request("tests.run", { "run": answer.run }, { "timeoutMs": 120_000 }) as Answer;
					}

					for (const ran of answer.files ?? []) {
						outcomes.set(ran.file, ran.tests);
						running.delete(ran.file);
						changed.fire(undefined);
					}
				}

				for (const ran of answer.files ?? []) {
					outcomes.set(ran.file, ran.tests);

					if (ran.tests.length === 0) {
						outcomes.delete(ran.file);
						failures.set(ran.file, ran.stalled ?? ran.error ?? ran.output?.trim().split("\n").at(-1) ?? "it ran no tests");
					} else {
						failures.delete(ran.file);
					}
				}

				const tests = (answer.files ?? []).flatMap((ran) => ran.tests);

				span.end({ "count": tests.length, "failed": tests.filter((test) => !passed(test)).length });
			});
		} finally {
			for (const file of files) {
				running.delete(file);
			}

			changed.fire(undefined);
		}
	});

	vscode.window.createTreeView("editor.features", { "treeDataProvider": provider, "showCollapseAll": true });
	vscode.commands.registerCommand("editor.features.refresh", read);
	vscode.commands.registerCommand("editor.features.run", async (row: Row) => {
		if (row.kind === "file") {
			await run([row.file]);
		} else if (row.kind === "feature") {
			await run(await filesOf(row.entry));
		}
	});

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(ROOT), ledgerPath()));

	for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
		event(() => {
			void read();
		});
	}

	void read();
}
