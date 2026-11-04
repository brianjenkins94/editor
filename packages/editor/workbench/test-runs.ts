/**
 * Tests for agents: which tests a change reaches, and their results as data (RUNNING.md, *Tests*). Their readers:
 * agents' `runs_affected` and `runs_tests`.
 *
 * - `tests.affected` { paths? }: the tests whose last run here ran code in the changed files (`tests.reach`), or that are in
 *   one — each with its last outcome, and `stale`: the file has changed since that run (a whole file is all it goes by, not
 *   its lines). And the test files with no reach kept (`untraced`): what they reach isn't known until they run, so an answer
 *   without them isn't the whole of it.
 * - `tests.run` { files?, affected? }: test files run one at a time, as `node --test` runs each (in the debugger), and
 *   each test's result: its outcome, what it threw, what a failed assertion compared, its time, and how it came out
 *   last before this run. `affected` runs the files of the affected tests that are stale. A capability stop (a gated
 *   call the policy leaves undecided) isn't left waiting on a person who isn't watching: one `approved` names (its
 *   key, `runs_tests:<scope>`) is allowed, this once; the first that isn't ends the run there, and the run answers with
 *   its question (`ask`) — which runs_tests puts to the person through debug-mcp (BERNARD, JUDICIAL, then them), and
 *   is called again with it approved. A run waits for the editor to be up (readiness.ts: the workspace, the debugger
 *   and the packages' versions), and says what it's still waiting on if that takes longer than READY_MS. And a file's run that does
 *   nothing for STALL_MS — no debug session, no output, no question, no word it's computing (the run contract's `busy`)
 *   — is stuck: it's ended, and says where (`stalled`).
 *
 *   A run is the editor's, not its call's: the call answers within ANSWER_MS — the run's results, or, while it goes on,
 *   its id, what it's doing and for how long, and the files done so far (`running`) — and `{ run }` waits on it again.
 *   So a run that's slow, stuck before a file's clock starts, or in a tab that went away reads as that to an agent,
 *   rather than as its tool call never coming back.
 * - `tests.reach`: what each test last ran, by file and line, kept here (`.silo/local/reach/`, this machine's).
 * - `tests.history`: the runs kept here (`.silo/local/runs.jsonl`, this machine's): each file's run, when, how long, each
 *   test's outcome and time, and what it did to the world (its effects). What the table of features and tests reads.
 */
import type { Effect, TestReport, TestsEvent } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { GitReader } from "./git-service";
import type { NodeRunner } from "./node-runner";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { waitFor } from "./readiness";
import { isTestFile } from "./terminal/commands/node/node";

const ROOT = "/workspace";

/** The files a test's trace can be on. */
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/** How long a run waits for the editor to come up before it says what it's waiting on. */
const READY_MS = 300_000;

/** How long a call waits on its run before it answers with where the run is (it goes on, asked again by its id): well
 *  inside what an agent's tool call waits for, so a run that's slow, stuck or gone reads as that and not as silence. */
const ANSWER_MS = 50_000;

/** Where runs are kept, and how many of each file's; and what each test last ran, by its file. */
const HISTORY = ".silo/local/runs.jsonl";
const REACH = ".silo/local/reach";
const KEPT_RUNS = 30;

/** Runs kept to be asked about by id: the latest that have ended, and any still going. */
const KEPT = 20;

/** How long a file's run may do nothing (no session, output, question or `busy`) before it's ended as stuck. */
const STALL_MS = 120_000;

/** How long working out the affected tests may take — their traces and a search of the workspace — before a
 *  run goes on without (named files: how each test came out before) or says so (none named). */
const AFFECTED_MS = 60_000;

/** A run's output kept, at most (its end): enough to see why a file failed to load. */
const OUTPUT = 4000;

/** `work`, or a rejection with `message` once `ms` pass without it. */
async function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => { reject(new Error(message)); }, ms);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

/** The question a run's capability stop asks (observability's PageToolAsk). */
interface Asked { "message": string; "key": string; "scope": string; "request": Record<string, unknown> }

/** A test file's result, as a run answers it. */
interface Ran { "file": string; "exitCode": number; "ms": number; "tests": { "id": string; "outcome": string }[] }

/** Statements as the lines they cover, as few ranges as they make (first and last line, from 0). */
function rangesOf(statements: [[number, number], [number, number]][]): [number, number][] {
	const ranges: [number, number][] = [];

	for (const [[from], [to]] of statements.toSorted(([one], [other]) => one[0] - other[0])) {
		const last = ranges.at(-1);

		if (last !== undefined && from <= last[1] + 1) {
			last[1] = Math.max(last[1], to);
		} else {
			ranges.push([from, to]);
		}
	}

	return ranges;
}

/** One file's run, as it's kept: what the table of features and tests reads. */
export interface RunRecord {
	"file": string;
	"at": string;
	"ms": number;
	"exitCode": number;
	"stalled"?: string;
	"tests": { "id": string; "outcome": string; "ms"?: number; "error"?: string }[];
	"effects": Effect[];
}

/** A run of test files (tests.run): what it was asked, what it's doing, each file's result as it comes, and its end. */
interface Batch {
	"id": string;
	"args": Record<string, unknown>;
	"now"?: { "doing": string; "since": number };
	"ran": Ran[];
	"controller": AbortController;
	"done": Promise<void>;
	"result"?: Record<string, unknown>;
	"error"?: Error;
}

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

export function installTestRuns(vscode: typeof vscodeApi, hub: Hub, git: GitReader, runner: NodeRunner): void {
	const rpc = createRpcClient(hub);
	const decoder = new TextDecoder();
	const read = async (path: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => decoder.decode(bytes), () => undefined);
	/** What each test last ran: each code file's lines, by the test's id. */
	const readReach = async (): Promise<Record<string, Record<string, [number, number][]>>> => {
		const reach: Record<string, Record<string, [number, number][]>> = {};
		const walk = async (folder: vscodeApi.Uri): Promise<void> => {
			for (const [name, type] of await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch(() => [] as [string, vscodeApi.FileType][])) {
				const uri = vscode.Uri.joinPath(folder, name);

				if (type === vscode.FileType.Directory) {
					await walk(uri);
				} else if (name.endsWith(".json")) {
					Object.assign(reach, JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(uri))));
				}
			}
		};

		await walk(vscode.Uri.file(`${ROOT}/${REACH}`));

		return reach;
	};

	const affected = async (paths?: string[]): Promise<{ "tests": Affected[]; "changed": string[]; "untraced": string[] }> => {
		const changed = paths ?? (await git.status({ "whole": true })).files.filter((change) => change.status !== "D").map((change) => change.path);
		const code = new Set(changed.filter((each) => CODE.test(each)));
		const reach = await readReach();
		const lastRuns = new Map((await readHistory()).map((run) => [run.file, run]));
		const changedAt = new Map(await Promise.all([...code].map(async (path): Promise<[string, number]> => [path, await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${ROOT}/${path}`))).then((stat) => stat.mtime, () => 0)])));
		const tests: Affected[] = [];

		for (const [id, files] of Object.entries(reach)) {
			const file = id.split(" › ")[0];
			const reaches = [...code].filter((path) => path === file || Object.hasOwn(files, path));

			if (reaches.length > 0) {
				const run = lastRuns.get(file);
				const at = run?.at ?? "";

				tests.push({ "id": id, "file": file, "outcome": run?.tests.find((test) => test.id === id)?.outcome ?? "", "at": at, "stale": reaches.some((path) => (changedAt.get(path) ?? 0) > Date.parse(at === "" ? "0" : at)), "reaches": reaches });
			}
		}

		const traced = new Set(Object.keys(reach).map((id) => id.split(" › ")[0]));
		const testFiles = (await vscode.workspace.findFiles("**/*.{js,mjs,cjs,ts,mts,cts}", "**/{node_modules,.*}/**")).map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((path) => isTestFile(path));

		return {
			"tests": tests.sort((left, right) => Number(right.stale) - Number(left.stale) || left.id.localeCompare(right.id)),
			"changed": changed,
			"untraced": testFiles.filter((path) => !traced.has(path)).sort((left, right) => left.localeCompare(right))
		};
	};

	serve(hub, "tests.affected", async (args) => {
		const { paths } = (args ?? {}) as { "paths"?: unknown };

		return affected(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string").map((path) => path.replace(/^\/workspace\//u, "")) : undefined);
	});

	/** The runs kept, oldest first; each write waits for the one before, as files run at once end at once. */
	let keeping: Promise<unknown> = Promise.resolve();
	const historyUri = vscode.Uri.file(`${ROOT}/${HISTORY}`);
	const readHistory = async (): Promise<RunRecord[]> => (await read(HISTORY) ?? "").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as RunRecord);
	const keep = async (record: RunRecord): Promise<void> => {
		keeping = keeping.then(async () => {
			const runs = [...await readHistory(), record];
			const ofThisFile = runs.filter((run) => run.file === record.file);
			const dropped = new Set(ofThisFile.slice(0, Math.max(0, ofThisFile.length - KEPT_RUNS)));

			await vscode.workspace.fs.writeFile(historyUri, new TextEncoder().encode(runs.filter((run) => !dropped.has(run)).map((run) => JSON.stringify(run) + "\n").join("")));
		}).catch(() => undefined);

		await keeping;
		hub.publish("tests.kept", { "file": record.file });
	};

	serve(hub, "tests.history", async () => ({ "history": await readHistory() }));

	/** What each test of `file` ran, its last run's: each code file's lines, as ranges. A file's run replaces its own. */
	const keepReach = async (file: string, tests: TestReport[]): Promise<void> => {
		const reach = Object.fromEntries(tests.map((test) => [[file, ...test.titles].join(" › "), Object.fromEntries(test.files.map((ran) => [ran.file.replace(/^\/workspace\//u, ""), rangesOf(ran.statements)]))]));

		await vscode.workspace.fs.writeFile(vscode.Uri.file(`${ROOT}/${REACH}/${file}.json`), new TextEncoder().encode(JSON.stringify(reach)));
	};

	serve(hub, "tests.reach", async () => ({ "reach": await readReach() }));

	/** One test file's run, in the debugger: its tests as the run tells them (its `tests` event), and its output's end. A
	 *  capability stop `approved` names is allowed, this once; another ends the run (`asked`: its question). One that
	 *  does nothing for STALL_MS ends too (`stalled`: where it was). */
	const runFile = async (file: string, signal: AbortSignal, approved: string[]): Promise<{ "exitCode": number; "ms": number; "tests": TestReport[]; "effects": Effect[]; "output": string; "attached": boolean; "asked"?: Asked; "stalled"?: string }> => {
		const controller = new AbortController();
		const stop = (): void => {
			controller.abort();
		};

		signal.addEventListener("abort", stop, { "once": true });

		const run = runner.runs.start({ "title": `node --test ${file}`, "kind": "task", "cwd": ROOT, "origin": { "other": "an agent (runs_tests)" }, "entry": `${ROOT}/${file}`, "runtime": "tsval" }, stop);
		let reported: TestsEvent | undefined;
		let effects: Effect[] = [];
		let asked: Asked | undefined;
		let stalled: string | undefined;
		let output = "";
		let session: vscodeApi.DebugSession | undefined;
		let active = performance.now();
		const starting = vscode.debug.onDidStartDebugSession((started) => {
			if (started.configuration["__runId"] === run.id) {
				session = started;
				active = performance.now();
			}
		});
		// (stuck: where it is — no session yet, or the session's top frame, as DAP says it — and the run ended)
		const watching = setInterval(() => {
			if (performance.now() - active < STALL_MS || stalled !== undefined) {
				return;
			}

			stalled = `nothing for ${String(STALL_MS / 1000)} s: no debug session started`;

			if (session === undefined) {
				stop();

				return;
			}

			const stuck = session;

			void (async () => {
				const { threads } = await stuck.customRequest("threads") as { "threads": { "id": number }[] };
				const { stackFrames } = await stuck.customRequest("stackTrace", { "threadId": threads[0]?.id, "levels": 1 }) as { "stackFrames"?: { "name": string; "line": number }[] };
				const [frame] = stackFrames ?? [];

				stalled = `nothing for ${String(STALL_MS / 1000)} s: the session ${frame === undefined ? "had no frame" : `at ${frame.name}, line ${String(frame.line)}`}`;
			})().catch(() => {
				stalled = `nothing for ${String(STALL_MS / 1000)} s: the session didn't say where it is`;
			}).finally(stop);
		}, 5000);
		const listening = vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
			if (event.session.configuration["__runId"] !== run.id) {
				return;
			}

			active = performance.now();

			if (event.event === "effects") {
				({ effects } = event.body as { "effects": Effect[] });
			} else if (event.event === "tests") {
				reported = event.body as TestsEvent;
			} else if (event.event === "ask") {
				const { line, callee, capability, resource, resolved, "file": where = `${ROOT}/${file}` } = event.body as { "line": number; "callee": string; "capability": string; "resource": string; "resolved"?: boolean; "file"?: string };
				// (a path not known before its line runs — `path.join(dir, name)` — is asked about as the test file's: keyed by
				// the expression, each such call was its own question, and each answer started the run over)
				const scope = resolved === false ? scopeOf(capability, `<as ${file} works it out>`) : scopeOf(capability, resource);
				// (a temporary file's name is made fresh each run — mkdtemp's — so its approval is for the run's temporary files:
				// keyed by the path, a re-run with it approved would ask again about a name it hasn't seen)
				const key = `runs_tests:${scope.replace(/^(fs:\w+:\/tmp\/).*$/u, "$1*")}`;

				if (approved.includes(key)) {
					void Promise.resolve(vscode.commands.executeCommand("editor.capability.decide", event.session.id, "allow-once")).catch(stop);
				} else {
					const at = `${where.replace(/^\/workspace\//u, "")}:${String(line + 1)}`;

					asked = { "message": resolved === false ? `A test run (${file}) reaches ${capability} at ${at}: \`${callee}\` (${resource}), a path it works out as it runs. Allow ${capability} for the paths ${file} works out, for runs_tests?` : `A test run (${file}) reaches ${scope} at ${at}: \`${callee}\`. Allow it for runs_tests?`, "key": key, "scope": scope, "request": { "kind": scope.slice(0, scope.indexOf(":")), "scope": scope, "resource": resource, "call": callee, "at": at } };
					stop();
				}
			}
		});
		const started = performance.now();

		try {
			const debugged = await runner.debug(`${ROOT}/${file}`, ROOT, {}, {
				"runId": run.id,
				// (unattended, as `node --test` is: a breakpoint left in a test would pause it with nobody to continue)
				"noDebug": true,
				"signal": controller.signal,
				"onOutput": (_stream, text) => {
					output = (output + text).slice(-OUTPUT);
					active = performance.now();
				}
			});

			run.end(debugged.attached ? debugged.exitCode : 1, controller.signal.aborted);

			// (a workspace file's call is the editor's to make and to keep, so it isn't among what the debugger told)
			const { "effects": kept } = await rpc.request("run.effects", { "run": run.id }, { "timeoutMs": 5000, "waitForResponderMs": 5000 }).catch(() => ({ "effects": [] as Effect[] })) as { "effects": Effect[] };

			effects = [...effects, ...kept];

			return { "exitCode": debugged.attached && stalled === undefined ? debugged.exitCode : 1, "ms": Math.round(performance.now() - started), "effects": effects, "tests": reported?.tests ?? [], "output": output, "attached": debugged.attached, ...asked === undefined ? {} : { "asked": asked }, ...stalled === undefined ? {} : { "stalled": stalled } };
		} finally {
			clearInterval(watching);
			starting.dispose();
			listening.dispose();
			signal.removeEventListener("abort", stop);
		}
	};

	const counted = (ran: Ran[]): { "files": number; "pass": number; "fail": number; "skip": number } => {
		const outcomes = ran.flatMap((file) => file.tests.map((test) => test.outcome));

		return { "files": ran.length, "pass": outcomes.filter((outcome) => outcome === "pass").length, "fail": outcomes.filter((outcome) => outcome === "fail").length, "skip": outcomes.filter((outcome) => outcome === "skip" || outcome === "todo").length };
	};

	/** A run of test files, to its end: what it's doing (`batch.now`) and each file's result as it comes (`batch.ran`). */
	const runBatch = async (batch: Batch): Promise<Record<string, unknown>> => {
		const { files, "affected": onlyAffected, approved } = batch.args as { "files"?: unknown; "affected"?: unknown; "approved"?: unknown };
		const approvals = Array.isArray(approved) ? approved.filter((key): key is string => typeof key === "string") : [];
		const { signal } = batch.controller;

		// (the editor up first: a run started before the debugger can take it waits out its timeout, saying nothing)
		batch.now = { "doing": "waiting for the editor to be up (its workspace, its debugger and its packages' versions)", "since": performance.now() };

		const waiting = await waitFor(["workspace", "debugger", "versions"], READY_MS, signal);

		if (waiting.length > 0) {
			throw new Error(`the editor is still starting — after ${String(READY_MS / 1000)} s, waiting on ${waiting.join(" and ")} (readiness.ts)`);
		}

		const listed = Array.isArray(files) ? files.filter((file): file is string => typeof file === "string").map((file) => file.replace(/^\/workspace\//u, "")) : [];
		// (no stall clock runs yet, and any of its steps can wait without end while the page is loading: a deadline)
		const tooLong = `working out the affected tests took over ${String(AFFECTED_MS / 1000)} s (their traces, the workspace's files)`;

		batch.now = { "doing": "working out the affected tests", "since": performance.now() };

		const before = onlyAffected === true || listed.length === 0 ? await within(affected(), AFFECTED_MS, tooLong) : undefined;
		const chosen = listed.length > 0 ? listed : [...new Set((before?.tests ?? []).filter((test) => test.stale).map((test) => test.file))];
		// (how each test came out last, before this run: a test newly failing reads differently from one failing all along —
		// without, when that can't be known in time)
		const last = new Map((before ?? await within(affected(chosen), AFFECTED_MS, tooLong).catch(() => ({ "tests": [] as Affected[] }))).tests.map((test) => [test.id, test.outcome]));

		for (const [index, file] of chosen.entries()) {
			if (signal.aborted) {
				break;
			}

			batch.now = { "doing": `running ${file} (${String(index + 1)} of ${String(chosen.length)})`, "since": performance.now() };

			const result = await runFile(file, signal, approvals);

			// (a question for the person: the run ends here, to be run again once it's answered)
			if (result.asked !== undefined) {
				return { "ask": result.asked };
			}

			await keepReach(file, result.tests);
			await keep({
				"file": file,
				"at": new Date().toISOString(),
				"ms": result.ms,
				"exitCode": result.exitCode,
				...result.stalled === undefined ? {} : { "stalled": result.stalled },
				"tests": result.tests.map((test) => ({ "id": [file, ...test.titles].join(" › "), "outcome": test.outcome, ...test.ms === undefined ? {} : { "ms": test.ms }, ...test.error === undefined ? {} : { "error": test.error } })),
				"effects": result.effects
			});

			batch.ran.push({
				"file": file,
				"exitCode": result.exitCode,
				"ms": result.ms,
				...result.attached ? {} : { "error": "the debugger couldn't take it" },
				...result.stalled === undefined ? {} : { "stalled": result.stalled },
				"tests": result.tests.map((test) => {
					const id = [file, ...test.titles].join(" › ");

					return { "id": id, "outcome": test.outcome, ...test.error === undefined ? {} : { "error": test.error }, ...test.assertion === undefined ? {} : { "assertion": test.assertion }, ...test.ms === undefined ? {} : { "ms": test.ms }, ...last.has(id) ? { "before": last.get(id) } : {} };
				}),
				// (a file that failed without a failed test didn't run its tests: its output says why)
				...result.exitCode !== 0 && !result.tests.some((test) => test.outcome === "fail") ? { "output": result.output } : {}
			});
		}

		return {
			"files": batch.ran,
			"counts": counted(batch.ran),
			...chosen.length === 0 ? { "nothing": listed.length === 0 ? "no affected test is stale: name files to run them anyway" : "no files" } : {}
		};
	};

	/** The runs, by id, to be asked about again: any still going, and the latest of the rest. */
	const batches = new Map<string, Batch>();
	const startBatch = (args: Record<string, unknown>): Batch => {
		const batch: Batch = { "id": crypto.randomUUID().slice(0, 8), "args": args, "ran": [], "controller": new AbortController(), "done": Promise.resolve() };

		batch.done = runBatch(batch).then((result) => {
			batch.result = result;
		}, (error: unknown) => {
			batch.error = error instanceof Error ? error : new Error(String(error));
		}).finally(() => {
			batch.now = undefined;
		});
		batches.set(batch.id, batch);

		// (the oldest that have ended: one still going is still being asked about, however many have started and ended since)
		const ended = [...batches].filter(([, each]) => each.result !== undefined || each.error !== undefined).map(([id]) => id);

		for (const id of ended.slice(0, Math.max(0, batches.size - KEPT))) {
			batches.delete(id);
		}

		return batch;
	};

	serve(hub, "tests.run", async (args, { signal }) => {
		const given = (args ?? {}) as Record<string, unknown>;
		const { run, approved, answerMs } = given;
		let batch = typeof run === "string" ? batches.get(run) : undefined;

		if (typeof run === "string" && batch === undefined) {
			throw new Error(`no test run ${run} here (this page keeps its latest ${String(KEPT)}; a reload forgets them)`);
		}

		// (its question answered: the same files again, from the start, with the approval)
		const asked = (batch?.result as { "ask"?: Asked } | undefined)?.ask;

		if (batch !== undefined && asked !== undefined && Array.isArray(approved) && approved.includes(asked.key)) {
			batch = startBatch({ ...batch.args, "approved": approved });
		}

		batch ??= startBatch(given);

		// The call waits on the run for ANSWER_MS at most: the run goes on without it, and is asked again by its id. (The
		// call going away — cancelled, its tab reloaded — leaves the run as it is.)
		let timer: ReturnType<typeof setTimeout> | undefined;
		const answered = await Promise.race([batch.done.then(() => true), new Promise<boolean>((resolve) => {
			// (sooner when asked: a test of the answer a run gives before it's done)
			timer = setTimeout(() => { resolve(false); }, typeof answerMs === "number" ? Math.min(answerMs, ANSWER_MS) : ANSWER_MS);
			signal.addEventListener("abort", () => { resolve(false); }, { "once": true });
		})]);

		clearTimeout(timer);

		if (!answered) {
			return { "run": batch.id, "running": batch.now === undefined ? "ending" : `${batch.now.doing}, for ${String(Math.round((performance.now() - batch.now.since) / 1000))} s`, "files": batch.ran, "counts": counted(batch.ran) };
		}

		if (batch.error !== undefined) {
			throw batch.error;
		}

		return { "run": batch.id, ...batch.result };
	});
}
