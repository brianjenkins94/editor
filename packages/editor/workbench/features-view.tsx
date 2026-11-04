/** @jsxImportSource preact */
/**
 * Features and tests (packages/silo/README.md, *Tests by feature, in your face*), a table in the panel: each feature of the
 * ledger, with its test files under it, each opening to its tests. A file's row says what kind of test it is, whether it can't
 * run beside the others and why, the effects its last run had, how much code it reaches and how much of that only it does, when
 * it last passed and failed, how long it typically takes, whether code it ran has changed since, and a button that runs it. Tests
 * are meant to run at once, so only one that can't says anything in that column.
 *
 * What it says comes from the ledger and the runs kept here (test-runs.ts, `tests.history`); a file not run here says so.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type { LedgerEntry } from "@brianjenkins94/util/silo/ledger";
import type { JSX } from "preact";
import type * as vscodeApi from "vscode";
import type { RunRecord } from "./test-runs";
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import { createRpcClient } from "@brianjenkins94/hub";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { parseLedger } from "@brianjenkins94/util/silo/ledger";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { featuresViewStyles } from "theme/styles/features-view";
import { isTestFile } from "./terminal/commands/node/node";
import "theme/components/badge";
import "theme/components/button";
import "theme/components/checkbox";
import "theme/components/relative-time";
import "theme/components/spinner";

const ROOT = "/workspace";

/** What kind of test a file is: where it runs. */
type Kind = "unit" | "UI spec" | "browser suite" | "not a test";

/** What a run answers (test-runs.ts): a question, what it's still doing, or each file's tests. */
interface Answer { "run"?: string; "running"?: string; "ask"?: { "message": string; "key": string } }

/** What the table draws: the ledger's features, each file's kind, and the runs kept. */
interface Model {
	"features": [string, LedgerEntry][];
	"files": Map<string, string[]>;
	"kinds": Map<string, Kind>;
	"history": RunRecord[];
	/** What each test file reaches, in lines of code, and how many of them no other file does. */
	"reach": Map<string, { "lines": number; "only": number }>;
	/** The test files whose code has changed since they last ran. */
	"touched": Set<string>;
}

const KIND_TITLE: Record<Kind, string> = {
	"unit": "Runs in the debugger, its code stepped and traced.",
	"UI spec": "Runs in the debugger, driving an editor of its own in a window of its own.",
	"browser suite": "Started from outside the editor, by a real browser: CI's, or node --test here.",
	"not a test": "A helper or fixture the ledger names among its tests."
};

/** What a file's imports say it is: its text may mention another kind (a test's own data can). */
function kindOf(text: string): Kind {
	const importing = text.split("\n").filter((line) => line.startsWith("import "));
	const imports = (what: string): boolean => importing.some((line) => line.includes(what));

	if (imports("architecture-harness")) {
		return "browser suite";
	}

	if (imports("@playwright/test")) {
		return "UI spec";
	}

	return imports("node:test") || imports("vitest") ? "unit" : "not a test";
}

const median = (values: number[]): number | undefined => values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)];

/** A duration, as someone reads one. */
const lasted = (ms: number | undefined): string => (ms === undefined ? "" : ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The run in `runs` (latest last) that came out `passed`. */
const lastWhere = (runs: RunRecord[], passed: boolean): RunRecord | undefined => runs.findLast((run) => (run.tests.length > 0 && run.tests.every((test) => test.outcome === "pass")) === passed);

/** Code a test's reach counts: not a test's own, nor what's installed. */
const isCode = (path: string): boolean => !path.includes("node_modules/") && !isTestFile(path);

/** What each test file reaches, from what each test ran. */
function reachOf(reach: Record<string, Record<string, [number, number][]>>): Model["reach"] {
	const byFile = new Map<string, Set<string>>();
	const reachers = new Map<string, Set<string>>();

	for (const [id, files] of Object.entries(reach)) {
		const file = id.split(" › ")[0];
		const lines = byFile.get(file) ?? new Set();

		byFile.set(file, lines);

		for (const [code, ranges] of Object.entries(files).filter(([path]) => isCode(path))) {
			for (const [from, to] of ranges) {
				for (let line = from; line <= to; line += 1) {
					const key = `${code}:${String(line)}`;

					lines.add(key);
					reachers.set(key, (reachers.get(key) ?? new Set()).add(file));
				}
			}
		}
	}

	return new Map([...byFile].map(([file, lines]) => [file, { "lines": lines.size, "only": [...lines].filter((key) => reachers.get(key)?.size === 1).length }]));
}

/** Why `file` can't run beside the others, if it can't: what stops it, or what it touches that another does too. */
function blockOf(file: string, kind: Kind, writers: Map<string, Set<string>>, runs: RunRecord[]): string | undefined {
	if (kind === "browser suite") {
		return "started from outside";
	}

	const wrote = runs.at(-1)?.effects.filter((effect) => effect.capability === "fs:write") ?? [];

	for (const { resource } of wrote) {
		const other = [...writers.get(resource) ?? []].find((each) => each !== file);

		if (other !== undefined) {
			return `writes ${resource}, as ${other.split("/").at(-1) ?? other} does`;
		}
	}

	return undefined;
}

function Effects({ run }: { "run": RunRecord | undefined }): JSX.Element | null {
	const byKind = Map.groupBy(run?.effects ?? [], (effect) => effect.capability);

	return (
		<span class="wa-cluster wa-gap-3xs">
			{[...byKind].map(([capability, effects]) => (
				<wa-badge key={capability} appearance="outlined" variant={capability === "page:goto" || capability.endsWith(":write") ? "warning" : "neutral"} title={effects.map((effect) => `${effect.resource} (${String(effect.calls)}×, ${effect.how})`).join("\n")}>
					{capability} {String(effects.length)}
				</wa-badge>
			))}
		</span>
	);
}

function When({ run }: { "run": RunRecord | undefined }): JSX.Element | null {
	return run === undefined ? null : <wa-relative-time date={run.at} title={run.at} />;
}

function Table({ model, running, onRun, onOpen }: { "model": Model; "running": Set<string>; "onRun": (files: string[]) => void; "onOpen": (file: string) => void }): JSX.Element {
	const [all, setAll] = useState(false);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const runsOf = Map.groupBy(model.history, (run) => run.file);
	const writers = new Map<string, Set<string>>();

	for (const [file, runs] of runsOf) {
		for (const { capability, resource } of runs.at(-1)?.effects ?? []) {
			if (capability === "fs:write") {
				writers.set(resource, (writers.get(resource) ?? new Set()).add(file));
			}
		}
	}

	const runnable = (file: string): boolean => {
		const kind = model.kinds.get(file);

		return kind === "unit" || kind === "UI spec";
	};
	const shown = model.features.filter(([name]) => all || (model.files.get(name) ?? []).length > 0);

	return (
		<div class="fv">
			<div class="wa-cluster wa-gap-s">
				<wa-checkbox size="small" checked={all} onChange={() => { setAll(!all); }}>Show features with no tests</wa-checkbox>
				<span class="wa-caption-s">{`${String(shown.length)} of ${String(model.features.length)} features`}</span>
				{model.touched.size === 0 ? null : <wa-button size="small" variant="brand" aria-label="Run touched" onClick={() => { onRun([...model.touched]); }}>{`Run the ${String(model.touched.size)} touched`}</wa-button>}
			</div>
			<table class="fv-table">
				<thead>
					<tr><th>Test</th><th>Type</th><th>Can't run in parallel</th><th>Effects</th><th>Reach</th><th>Last passed</th><th>Last failed</th><th>Typical</th><th /></tr>
				</thead>
				<tbody>
					{shown.flatMap(([name, entry]) => {
						const files = model.files.get(name) ?? [];
						const failing = files.filter((file) => { const last = runsOf.get(file)?.at(-1); return last !== undefined && last.tests.some((test) => test.outcome !== "pass"); }).length;
						const toRun = files.filter(runnable);

						return [
							<tr key={name} class="fv-feature" title={entry.what ?? entry.why}>
								<td>{name}</td>
								<td colSpan={6}>
									<span class="wa-cluster wa-gap-3xs">
										{entry.status === "active" ? null : <wa-badge appearance="outlined" variant="neutral">{entry.status}</wa-badge>}
										<span>{files.length === 0 ? "no tests" : `${String(files.length)} ${files.length === 1 ? "file" : "files"}`}</span>
										{failing === 0 ? null : <wa-badge variant="danger">{`${String(failing)} failing`}</wa-badge>}
									</span>
								</td>
								<td />
								<td>{toRun.length === 0 ? null : <wa-button size="small" appearance="plain" aria-label={`Run ${name}`} onClick={() => { onRun(toRun); }}>Run</wa-button>}</td>
							</tr>,
							...files.flatMap((file) => {
								const runs = runsOf.get(file) ?? [];
								const last = runs.at(-1);
								const kind = model.kinds.get(file) ?? "not a test";
								const block = blockOf(file, kind, writers, runs);
								const typical = median(runs.filter((run) => run.tests.every((test) => test.outcome === "pass")).map((run) => run.ms));
								const opened = open.has(file);
								const reached = model.reach.get(file);

								return [
									<tr key={file}>
										<td class="fv-test" title={file}>
											<span class="fv-toggle" onClick={() => { const next = new Set(open); if (opened) { next.delete(file); } else { next.add(file); } setOpen(next); }}>{last === undefined ? "  " : opened ? "▾ " : "▸ "}</span>
											<a href="#" onClick={(event) => { event.preventDefault(); onOpen(file); }}>{file.split("/").findLast((part) => part !== "")}</a>
											{model.touched.has(file) ? <wa-badge variant="warning" title="Code it ran has changed since it last ran."> touched</wa-badge> : null}
										</td>
										<td title={KIND_TITLE[kind]}>{kind}</td>
										<td>{block === undefined ? null : <wa-badge variant="danger">{block}</wa-badge>}</td>
										<td><Effects run={last} /></td>
										<td title="Lines of code it ran, and how many no other test file runs.">
											{reached === undefined || reached.lines === 0 ? null : reached.only > 0 ? `${String(reached.lines)} lines · ${String(reached.only)} only here` : <span class="wa-cluster wa-gap-3xs">{`${String(reached.lines)} lines`}<wa-badge appearance="outlined" variant="neutral">nothing only here</wa-badge></span>}
										</td>
										<td><When run={lastWhere(runs, true)} /></td>
										<td><When run={lastWhere(runs, false)} /></td>
										<td>{last === undefined ? <span class="wa-caption-s">not run</span> : lasted(typical)}</td>
										<td>{running.has(file) ? <wa-spinner /> : runnable(file) ? <wa-button size="small" appearance="plain" aria-label={`Run ${file}`} onClick={() => { onRun([file]); }}>Run</wa-button> : null}</td>
									</tr>,
									...opened ? (last?.tests ?? []).map((test) => (
										<tr key={test.id} title={test.error}>
											<td class="fv-case">{test.id.split(" › ").slice(1).join(" › ")}</td>
											<td colSpan={6}>{test.outcome === "pass" ? null : <wa-badge variant="danger">{test.outcome}</wa-badge>}</td>
											<td>{lasted(test.ms)}</td>
											<td />
										</tr>
									)) : []
								];
							})
						];
					})}
				</tbody>
			</table>
		</div>
	);
}

export function installFeaturesView(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);
	const ledgerUri = vscode.Uri.file(`${ROOT}/${ledgerPath()}`);
	const approved: string[] = [];
	const running = new Set<string>();
	let model: Model = { "features": [], "files": new Map(), "kinds": new Map(), "history": [], "reach": new Map(), "touched": new Set() };
	const redraws = new Set<() => void>();
	const redraw = (): void => {
		for (const each of redraws) {
			each();
		}
	};

	const textOf = async (uri: vscodeApi.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	/** The test files a ledger's `tests` entry is: itself, or what's in the folder it names. */
	const filesIn = async (entry: string): Promise<string[]> => {
		const uri = vscode.Uri.file(`${ROOT}/${entry}`);
		const type = await Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat) => stat.type, () => undefined);

		if (type !== vscode.FileType.Directory) {
			return [entry];
		}

		return (await vscode.workspace.findFiles(new vscode.RelativePattern(uri, "**/*"), "**/node_modules/**")).map((each) => vscode.workspace.asRelativePath(each, false)).filter((path) => isTestFile(path)).toSorted((one, other) => one.localeCompare(other));
	};

	/** The ledger, what kind each of its tests is, and the runs kept, read again. */
	const read = async (): Promise<void> => log.span("editor.workbench.features-view.read", { "path": ledgerPath() }, async (span) => {
		const features = Object.entries(parseLedger(await textOf(ledgerUri))).toSorted(([one], [other]) => one.localeCompare(other));
		const files = new Map(await Promise.all(features.map(async ([name, entry]): Promise<[string, string[]]> => [name, [...new Set((await Promise.all((entry.tests ?? []).map(filesIn))).flat())]])));
		const kinds = new Map(await Promise.all([...new Set([...files.values()].flat())].map(async (file): Promise<[string, Kind]> => [file, kindOf(await textOf(vscode.Uri.file(`${ROOT}/${file}`)) ?? "")])));
		const { history } = await rpc.request("tests.history", {}, { "timeoutMs": 60_000, "waitForResponderMs": 60_000 }) as { "history": RunRecord[] };

		const { reach } = await rpc.request("tests.reach", {}, { "timeoutMs": 60_000 }) as { "reach": Record<string, Record<string, [number, number][]>> };
		const { "tests": affected } = await rpc.request("tests.affected", {}, { "timeoutMs": 60_000 }) as { "tests": { "file": string; "stale": boolean }[] };

		model = { "features": features, "files": files, "kinds": kinds, "history": history, "reach": reachOf(reach), "touched": new Set(affected.filter((test) => test.stale).map((test) => test.file)) };
		span.end({ "count": features.length, "tests": kinds.size, "runs": history.length });
		redraw();
	});

	/** `files` run in the debugger; a capability stop is put to the person, and on their yes the run starts again. */
	const run = async (files: string[]): Promise<void> => log.span("editor.workbench.features-view.run", { "count": files.length }, async (span) => {
		for (const file of files) {
			running.add(file);
		}

		redraw();

		try {
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
			}
		} finally {
			for (const file of files) {
				running.delete(file);
			}

			redraw();
			span.end({ "count": files.length });
		}
	});

	function View(): JSX.Element {
		const [, drawn] = useState(0);

		useEffect(() => {
			const again = (): void => { drawn((count) => count + 1); };

			redraws.add(again);
			// (what was read between its first draw and this)
			again();

			return () => { redraws.delete(again); };
		}, []);

		return <Table model={model} running={running} onRun={(files) => { void run(files); }} onOpen={(file) => { void vscode.window.showTextDocument(vscode.Uri.file(`${ROOT}/${file}`)); }} />;
	}

	registerCustomView({
		"id": "editor.features",
		"name": "Features and Tests",
		"location": ViewContainerLocation.Panel,
		"renderBody": (container: HTMLElement) => {
			featuresViewStyles();
			render(<View />, container);

			return { "dispose": () => { render(null, container); } };
		}
	});

	vscode.commands.registerCommand("editor.features.show", async () => {
		await vscode.commands.executeCommand("editor.features.focus");
		await read();
	});

	// (a save may have touched a test's code)
	vscode.workspace.onDidSaveTextDocument(() => {
		void read();
	});

	// (a run anyone started: an agent's, or one of the table's own)
	hub.subscribe("tests.kept", () => {
		void read();
	});

	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(ROOT), ledgerPath()));

	for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
		event(() => {
			void read();
		});
	}

	void read();
}
