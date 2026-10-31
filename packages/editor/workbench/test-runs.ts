/**
 * Tests for agents: which tests a change reaches, and their results as data (RUNNING.md, *Tests*). Their readers:
 * agents' `runs_affected` and `runs_tests`.
 *
 * - `tests.affected` { paths? }: the tests whose kept traces (`.silo/local/traces/<file>.jsonl`: what each test ran of
 *   each file) ran code in the changed files — each with its last outcome, and `stale` when its trace ran a declaration
 *   the file no longer has (a BABLR span id gone from its spans: it hasn't run on this code), as a save's selection
 *   (live-run.ts `reachedRuns`) judges it. And the test files no trace names (`untraced`): what they reach isn't known
 *   until they run, so an answer without them isn't the whole of it.
 * - `tests.run` { files?, affected? }: test files run one at a time, as `node --test` runs each (in the debugger), and
 *   each test's result: its outcome, what it threw, what a failed assertion compared, its time, and how it came out
 *   last before this run. `affected` runs the files of the affected tests that are stale. A capability stop (a gated
 *   call the policy leaves undecided) isn't left waiting on a person who isn't watching: one `approved` names (its
 *   key, `runs_tests:<scope>`) is allowed, this once; the first that isn't ends the run there, and the run answers with
 *   its question (`ask`) — which runs_tests puts to the person through debug-mcp (BERNARD, JUDICIAL, then them), and
 *   is called again with it approved. A run waits for the editor to be up (readiness.ts: the workspace and the
 *   debugger), and says what it's still waiting on if that takes longer than READY_MS.
 */
import type { TestReport, TestsEvent } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import type * as vscodeApi from "vscode";
import type { Bablr } from "./bablr";
import type { GitReader } from "./git-service";
import type { NodeRunner } from "./node-runner";
import { serve } from "@brianjenkins94/hub";
import { localTracesPath } from "@brianjenkins94/util/silo/layout";
import { parseTraces } from "@brianjenkins94/util/silo/traces";
import { waitFor } from "./readiness";
import { isTestFile } from "./terminal/commands/node/node";

const ROOT = "/workspace";

/** The files a test's trace can be on. */
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/** How long a run waits for the editor to come up before it says what it's waiting on. */
const READY_MS = 300_000;

/** A run's output kept, at most (its end): enough to see why a file failed to load. */
const OUTPUT = 4000;

/** The question a run's capability stop asks (observability's PageToolAsk). */
interface Asked { "message": string; "key": string; "scope": string; "request": Record<string, unknown> }

/** A gated call's silo scope (lib util/silo/enforce): `fs:<op>:<path>`, `net:<host>`, `exec:<program>`. */
function scopeOf(capability: string, resource: string): string {
	if (capability === "net") {
		try {
			return `net:${new URL(resource).host}`;
		} catch {
			return `net:${resource === "" ? "*" : resource}`;
		}
	}

	return `${capability}:${resource === "" ? "*" : resource}`;
}

/** A test a change reaches. */
interface Affected {
	"id": string;
	"file": string;
	"outcome": string;
	"at": string;
	"stale": boolean;
	"reaches": string[];
}

export function installTestRuns(vscode: typeof vscodeApi, hub: Hub, git: GitReader, bablr: Bablr, runner: NodeRunner): void {
	const decoder = new TextDecoder();
	const read = async (path: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => decoder.decode(bytes), () => undefined);
	const tracesOf = async (path: string): Promise<RunTrace[]> => parseTraces(await read(localTracesPath(path)) ?? "").filter((trace) => trace.test !== undefined);

	/** Every test a trace names, by its file: what's been run here. */
	const tracedTestFiles = async (): Promise<Set<string>> => {
		const files = new Set<string>();
		// (walked: a search leaves dot folders out)
		const walk = async (folder: vscodeApi.Uri): Promise<void> => {
			for (const [name, type] of await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch(() => [] as [string, vscodeApi.FileType][])) {
				const uri = vscode.Uri.joinPath(folder, name);

				if (type === vscode.FileType.Directory) {
					await walk(uri);
				} else if (name.endsWith(".jsonl")) {
					for (const trace of parseTraces(decoder.decode(await vscode.workspace.fs.readFile(uri)))) {
						if (trace.test !== undefined) {
							files.add(trace.test.id.split(" › ")[0]);
						}
					}
				}
			}
		};

		await walk(vscode.Uri.file(`${ROOT}/.silo/local/traces`));

		return files;
	};

	const affected = async (paths?: string[]): Promise<{ "tests": Affected[]; "changed": string[]; "untraced": string[] }> => {
		const changed = paths ?? (await git.status()).files.filter((change) => change.status !== "D").map((change) => change.path);
		const tests = new Map<string, Affected>();

		for (const path of changed.filter((each) => CODE.test(each))) {
			const traces = await tracesOf(path);
			const text = traces.length === 0 ? undefined : await read(path);
			const ids = text === undefined ? undefined : new Set((await bablr.spans(text).catch(() => [])).map((span) => span.id));

			for (const trace of traces) {
				const { test } = trace;
				const stale = ids !== undefined && ids.size > 0 && (trace.declarations ?? []).some((id) => !ids.has(id));
				const known = tests.get(test.id);

				// (a test's latest trace on each file: its outcome is its last run's)
				if (known === undefined || trace.at > known.at) {
					tests.set(test.id, { "id": test.id, "file": test.id.split(" › ")[0], "outcome": test.outcome, "at": trace.at, "stale": stale || known?.stale === true, "reaches": [...new Set([...known?.reaches ?? [], path])] });
				} else {
					known.stale ||= stale;
					known.reaches = [...new Set([...known.reaches, path])];
				}
			}
		}

		const traced = await tracedTestFiles();
		const testFiles = (await vscode.workspace.findFiles("**/*.{js,mjs,cjs,ts,mts,cts}", "**/{node_modules,.*}/**")).map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((path) => isTestFile(path));

		return {
			"tests": [...tests.values()].sort((left, right) => Number(right.stale) - Number(left.stale) || left.id.localeCompare(right.id)),
			"changed": changed,
			"untraced": testFiles.filter((path) => !traced.has(path)).sort((left, right) => left.localeCompare(right))
		};
	};

	serve(hub, "tests.affected", async (args) => {
		const { paths } = (args ?? {}) as { "paths"?: unknown };

		return affected(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string").map((path) => path.replace(/^\/workspace\//u, "")) : undefined);
	});

	/** One test file's run, in the debugger: its tests as the run tells them (its `tests` event), and its output's end. A
	 *  capability stop `approved` names is allowed, this once; another ends the run (`asked`: its question). */
	const runFile = async (file: string, signal: AbortSignal, approved: string[]): Promise<{ "exitCode": number; "ms": number; "tests": TestReport[]; "output": string; "attached": boolean; "asked"?: Asked }> => {
		const controller = new AbortController();
		const stop = (): void => {
			controller.abort();
		};

		signal.addEventListener("abort", stop, { "once": true });

		const run = runner.runs.start({ "title": `node --test ${file}`, "kind": "task", "cwd": ROOT, "origin": { "other": "an agent (runs_tests)" }, "entry": `${ROOT}/${file}`, "runtime": "tsval" }, stop);
		let reported: TestsEvent | undefined;
		let asked: Asked | undefined;
		let output = "";
		const listening = vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
			if (event.session.configuration["__runId"] !== run.id) {
				return;
			}

			if (event.event === "tests") {
				reported = event.body as TestsEvent;
			} else if (event.event === "ask") {
				const { line, callee, capability, resource, "file": where = `${ROOT}/${file}` } = event.body as { "line": number; "callee": string; "capability": string; "resource": string; "file"?: string };
				const scope = scopeOf(capability, resource);
				const key = `runs_tests:${scope}`;

				if (approved.includes(key)) {
					void Promise.resolve(vscode.commands.executeCommand("editor.capability.decide", event.session.id, "allow-once")).catch(stop);
				} else {
					const at = `${where.replace(/^\/workspace\//u, "")}:${String(line + 1)}`;

					asked = { "message": `A test run (${file}) reaches ${scope} at ${at}: \`${callee}\`. Allow it for runs_tests?`, "key": key, "scope": scope, "request": { "kind": scope.slice(0, scope.indexOf(":")), "scope": scope, "resource": resource, "call": callee, "at": at } };
					stop();
				}
			}
		});
		const started = performance.now();

		try {
			const debugged = await runner.debug(`${ROOT}/${file}`, ROOT, {}, {
				"runId": run.id,
				"signal": controller.signal,
				"onOutput": (_stream, text) => {
					output = (output + text).slice(-OUTPUT);
				}
			});

			run.end(debugged.attached ? debugged.exitCode : 1, controller.signal.aborted);

			return { "exitCode": debugged.attached ? debugged.exitCode : 1, "ms": Math.round(performance.now() - started), "tests": reported?.tests ?? [], "output": output, "attached": debugged.attached, ...asked === undefined ? {} : { "asked": asked } };
		} finally {
			listening.dispose();
			signal.removeEventListener("abort", stop);
		}
	};

	serve(hub, "tests.run", async (args, { signal }) => {
		const { files, "affected": onlyAffected, approved } = (args ?? {}) as { "files"?: unknown; "affected"?: unknown; "approved"?: unknown };
		const approvals = Array.isArray(approved) ? approved.filter((key): key is string => typeof key === "string") : [];
		// (the editor up first: a run started before the debugger can take it waits out its timeout, saying nothing)
		const waiting = await waitFor(["workspace", "debugger"], READY_MS, signal);

		if (waiting.length > 0) {
			throw new Error(`the editor is still starting — after ${String(READY_MS / 1000)} s, waiting on ${waiting.join(" and ")} (readiness.ts)`);
		}

		const listed = Array.isArray(files) ? files.filter((file): file is string => typeof file === "string").map((file) => file.replace(/^\/workspace\//u, "")) : [];
		const before = onlyAffected === true || listed.length === 0 ? await affected() : undefined;
		const chosen = listed.length > 0 ? listed : [...new Set((before?.tests ?? []).filter((test) => test.stale).map((test) => test.file))];
		// (how each test came out last, before this run: a test newly failing reads differently from one failing all along)
		const last = new Map((before ?? await affected(chosen)).tests.map((test) => [test.id, test.outcome]));
		const ran = [];

		for (const file of chosen) {
			if (signal.aborted) {
				break;
			}

			const result = await runFile(file, signal, approvals);

			// (a question for the person: the run ends here, to be run again once it's answered)
			if (result.asked !== undefined) {
				return { "ask": result.asked };
			}

			ran.push({
				"file": file,
				"exitCode": result.exitCode,
				"ms": result.ms,
				...result.attached ? {} : { "error": "the debugger couldn't take it" },
				"tests": result.tests.map((test) => {
					const id = [file, ...test.titles].join(" › ");

					return { "id": id, "outcome": test.outcome, ...test.error === undefined ? {} : { "error": test.error }, ...test.assertion === undefined ? {} : { "assertion": test.assertion }, ...test.ms === undefined ? {} : { "ms": test.ms }, ...last.has(id) ? { "before": last.get(id) } : {} };
				}),
				// (a file that failed without a failed test didn't run its tests: its output says why)
				...result.exitCode !== 0 && !result.tests.some((test) => test.outcome === "fail") ? { "output": result.output } : {}
			});
		}

		const outcomes = ran.flatMap((file) => file.tests.map((test) => test.outcome));

		return {
			"files": ran,
			"counts": { "files": ran.length, "pass": outcomes.filter((outcome) => outcome === "pass").length, "fail": outcomes.filter((outcome) => outcome === "fail").length, "skip": outcomes.filter((outcome) => outcome === "skip" || outcome === "todo").length },
			...chosen.length === 0 ? { "nothing": listed.length === 0 ? "no affected test is stale: name files to run them anyway" : "no files" } : {}
		};
	});
}
