/**
 * Tests for agents: which tests a change reaches, and their results as data (RUNNING.md, *Tests*). Their readers:
 * agents' `runs_affected` and `runs_tests`.
 *
 * - `tests.affected` { paths? }: the tests whose last run here ran the lines changed since the last commit (`tests.reach`;
 *   a file git doesn't have yet, or one named that hasn't changed, all of it), or that are in a changed test file — each with
 *   its last outcome, and `stale`: the file has changed since that run. And for each changed file, why it selected what it
 *   did (`why`, `selectionOf`): a test, lines a test ran, lines no test ran, code no test here runs, what every test runs
 *   under (config), or not code — so a change nothing here checks says so, rather than selecting nothing. And the test
 *   files with no reach kept that a run here would trace, a unit test or a spec (`untraced`, the first UNTRACED_LISTED, and
 *   how many more): what they reach isn't known until they run, so an answer without them isn't the whole of it; and how
 *   many browser suites there are (`outside`), run from outside the editor, whose reach isn't known here. A test folder's
 *   helpers and fixtures aren't tests (kindOf).
 * - `tests.run` { files?, affected? }: test files run one at a time, as `node --test` runs each (in the debugger), and
 *   each test's result: its outcome, what it threw, what a failed assertion compared, its time and statements, how it
 *   came out last before this run, and — passed, but by more than `run.tests.slowerBy` over its typical — `slower`. `affected` runs the files of the affected tests that are stale. A capability stop (a gated
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
 *   test's outcome and time, and what it did to the world (its effects, the run's and each test's). What the table of features and tests reads.
 */
import type { Effect, TestReport, TestsEvent } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { GitReader } from "./git-service";
import type { NodeRunner } from "./node-runner";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { alignedRows, hunksOf } from "../shared/git-hunks";
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

/** How many untraced test files an answer names: a repository's can be hundreds (the editor's, 185 unit tests and specs),
 *  more than an agent's tool answer holds; the rest are counted (`untracedLeftOut`). */
const UNTRACED_LISTED = 50;

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
interface Ran { "file": string; "exitCode": number; "ms": number; "tests": { "id": string; "outcome": string }[]; "output"?: string }

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
	"tests": { "id": string; "outcome": string; "ms"?: number; "statements"?: number; "error"?: string; "effects"?: Effect[] }[];
	"effects": Effect[];
	/** Why a file that failed without a failed test did: the end of what it said. */
	"output"?: string;
}

/** How a test ran slower than it typically does: by how much (a percentage), measured how, and its typical. */
export interface Slower { "by": number; "measure": "statements" | "time"; "typical": number }

/** How many earlier passing runs a time is compared with: a time varies with what ran beside it, so one isn't enough. (A
 *  count of statements doesn't: one is.) */
const TIMED_RUNS = 3;

/** The middle of `values`. */
const median = (values: number[]): number => values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)] ?? 0;

/**
 * How much slower test `id` ran in `latest` than it typically does — the median of the `earlier` runs it passed in — when
 * by more than `percent` (setting `run.tests.slowerBy`). By its statements, where they're counted (its work: what ran
 * beside it doesn't change it); else by its time, once it has TIMED_RUNS earlier passes to go by. Undefined when it
 * isn't, or there's nothing to go by.
 */
export function slowerOf(earlier: RunRecord[], id: string, latest: { "ms"?: number; "statements"?: number }, percent: number): Slower | undefined {
	const passes = earlier.flatMap((run) => run.tests.filter((test) => test.id === id && test.outcome === "pass"));
	const counted = passes.flatMap((test) => (test.statements === undefined ? [] : [test.statements]));
	const timed = passes.flatMap((test) => (test.ms === undefined ? [] : [test.ms]));
	const compared = latest.statements !== undefined && counted.length > 0
		? { "measure": "statements" as const, "now": latest.statements, "typical": median(counted) }
		: latest.ms !== undefined && timed.length >= TIMED_RUNS ? { "measure": "time" as const, "now": latest.ms, "typical": median(timed) } : undefined;

	if (compared === undefined || compared.typical <= 0) {
		return undefined;
	}

	const by = Math.round((compared.now / compared.typical - 1) * 100);

	return by > percent ? { "by": by, "measure": compared.measure, "typical": compared.typical } : undefined;
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

/** What kind of test a file is: where it runs. */
export type Kind = "unit" | "UI spec" | "browser suite" | "not a test";

/** What a file's imports say it is: its text may mention another kind (a test's own data can). */
export function kindOf(text: string): Kind {
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

/** A test a change reaches. */
interface Affected {
	"id": string;
	"file": string;
	"outcome": string;
	"at": string;
	"stale": boolean;
	"reaches": string[];
}

/** What every test runs under: its packages, its compiler's settings, what its program may do. */
const CONFIG = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|\.npmrc|tsconfig[^/]*\.json)$|^\.silo\/policy\.json$/u;

/** A changed file, and its changed lines (from 0, first and last, on either side of the change); none, all of it. */
export interface Change { "path": string; "lines"?: [number, number][] }

/** Why a changed file selected what it did: it's a test (itself); tests ran its changed lines (those); tests ran it but not
 *  those lines, or none here runs it at all (nothing checks the change); every test runs under it (config: what it
 *  reaches isn't lines); or it isn't code. */
export type Why = "test" | "lines run" | "lines not run" | "not run" | "config" | "not code";

/** The lines `head` → `working` changed, on both sides (a test's reach may be of either text): what a hunk removes and
 *  adds, or, where it only adds or only removes, the lines either side of it. From 0, as a test's reach is. */
export function changedLines(head: string, working: string): [number, number][] {
	const lines: [number, number][] = [];

	for (const hunk of hunksOf("", head, working, alignedRows(head, working))) {
		for (const side of [hunk.head, hunk.working]) {
			lines.push(side.lines === 0 ? [Math.max(0, side.start - 1), side.start] : [side.start - 1, side.start + side.lines - 2]);
		}
	}

	return lines;
}

/** Which tests `changes` select, by what each test last ran (`reach`: its id's each code file's lines), and why each change
 *  selected what it did. A test is selected by a change to its own file, or to lines it ran. */
export function selectionOf(changes: Change[], reach: Record<string, Record<string, [number, number][]>>, isTest: (path: string) => boolean): { "tests": Map<string, string[]>; "why": { "path": string; "why": Why; "tests": number }[] } {
	const tests = new Map<string, string[]>();
	const why = changes.map(({ path, lines }) => {
		if (isTest(path)) {
			const own = Object.keys(reach).filter((id) => id.split(" › ")[0] === path);

			for (const id of own) {
				tests.set(id, [...tests.get(id) ?? [], path]);
			}

			return { "path": path, "why": "test" as Why, "tests": own.length };
		}

		if (CONFIG.test(path)) {
			return { "path": path, "why": "config" as Why, "tests": 0 };
		}

		if (!CODE.test(path)) {
			return { "path": path, "why": "not code" as Why, "tests": 0 };
		}

		const ranIt = Object.entries(reach).filter(([, files]) => Object.hasOwn(files, path));
		const ranLines = ranIt.filter(([, files]) => lines === undefined || files[path].some(([from, to]) => lines.some(([first, last]) => first <= to && from <= last)));

		for (const [id] of ranLines) {
			tests.set(id, [...tests.get(id) ?? [], path]);
		}

		return { "path": path, "why": (ranIt.length === 0 ? "not run" : ranLines.length === 0 ? "lines not run" : "lines run") as Why, "tests": ranLines.length };
	});

	return { "tests": tests, "why": why };
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

	/** Each test-named file's kind (kindOf), read once, and again once it's changed. */
	const kindsKnown = new Map<string, Kind>();
	const kindOfFile = async (path: string): Promise<Kind> => {
		let kind = kindsKnown.get(path);

		if (kind === undefined) {
			kind = kindOf(await read(path) ?? "");
			kindsKnown.set(path, kind);
		}

		return kind;
	};
	const codeWatcher = vscode.workspace.createFileSystemWatcher("**/*.{js,mjs,cjs,ts,mts,cts}");

	for (const event of [codeWatcher.onDidChange, codeWatcher.onDidCreate, codeWatcher.onDidDelete]) {
		event((uri) => {
			kindsKnown.delete(vscode.workspace.asRelativePath(uri, false));
		});
	}

	/** The tests a change reaches. What's changed, unless `paths` says: a walk of the whole tree (git's `whole`), as what's
	 *  run of it acts on it — or, `glance`, of what the change watcher has told so far, for a view drawn again as it does. */
	const affected = async (paths?: string[], glance = false): Promise<{ "tests": Affected[]; "changed": string[]; "why": { "path": string; "why": Why; "tests": number }[]; "untraced": string[]; "untracedLeftOut"?: number; "outside": number }> => {
		const changed = paths ?? (await git.status({ "whole": !glance })).files.filter((change) => change.status !== "D").map((change) => change.path);
		// (each changed code file's lines against the last commit; one git hasn't, or named and not changed, is all of it)
		const changes = await Promise.all(changed.map(async (path): Promise<Change> => {
			if (!CODE.test(path) || isTestFile(path)) {
				return { "path": path };
			}

			const texts = await git.file(path).catch(() => undefined);

			return texts === undefined || texts.head === "" || texts.head === texts.working ? { "path": path } : { "path": path, "lines": changedLines(texts.head, texts.working) };
		}));
		const reach = await readReach();
		const selected = selectionOf(changes, reach, isTestFile);
		const lastRuns = new Map((await readHistory()).map((run) => [run.file, run]));
		const changedAt = new Map(await Promise.all([...new Set([...selected.tests.values()].flat())].map(async (path): Promise<[string, number]> => [path, await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${ROOT}/${path}`))).then((stat) => stat.mtime, () => 0)])));
		const tests = [...selected.tests].map(([id, reaches]): Affected => {
			const file = id.split(" › ")[0];
			const run = lastRuns.get(file);
			const at = run?.at ?? "";

			return { "id": id, "file": file, "outcome": run?.tests.find((test) => test.id === id)?.outcome ?? "", "at": at, "stale": reaches.some((path) => (changedAt.get(path) ?? 0) > Date.parse(at === "" ? "0" : at)), "reaches": reaches };
		});

		const traced = new Set(Object.keys(reach).map((id) => id.split(" › ")[0]));
		const testFiles = (await vscode.workspace.findFiles("**/*.{js,mjs,cjs,ts,mts,cts}", "**/{node_modules,.*}/**")).map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((path) => isTestFile(path));
		// (of those with no reach, what running here would trace — a unit test, a spec — and the browser suites, run from
		// outside, whose reach isn't known here; a test folder's helpers and fixtures aren't tests)
		const kinds = await Promise.all(testFiles.filter((path) => !traced.has(path)).map(async (path): Promise<[string, Kind]> => [path, await kindOfFile(path)]));
		const untraced = kinds.filter(([, kind]) => kind === "unit" || kind === "UI spec").map(([path]) => path).sort((left, right) => left.localeCompare(right));
		const outside = kinds.filter(([, kind]) => kind === "browser suite").length;

		return {
			"tests": tests.sort((left, right) => Number(right.stale) - Number(left.stale) || left.id.localeCompare(right.id)),
			"changed": changed,
			"why": selected.why,
			"untraced": untraced.slice(0, UNTRACED_LISTED),
			...untraced.length > UNTRACED_LISTED ? { "untracedLeftOut": untraced.length - UNTRACED_LISTED } : {},
			"outside": outside
		};
	};

	serve(hub, "tests.affected", async (args) => {
		const { paths, glance } = (args ?? {}) as { "paths"?: unknown; "glance"?: unknown };

		return affected(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string").map((path) => path.replace(/^\/workspace\//u, "")) : undefined, glance === true);
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
	const runFile = async (file: string, signal: AbortSignal, approved: string[], stopAll: () => void): Promise<{ "exitCode": number; "ms": number; "tests": TestReport[]; "effects": Effect[]; "output": string; "attached": boolean; "asked"?: Asked; "stalled"?: string }> => {
		const controller = new AbortController();
		const stop = (): void => {
			controller.abort();
		};

		signal.addEventListener("abort", stop, { "once": true });

		// (stopped from outside — runs_stop, the run's Stop — the whole run stops, as Ctrl+C stops `node --test`, not only this
		// file; a stall or a question stops this file alone)
		const run = runner.runs.start({ "title": `node --test ${file}`, "kind": "task", "cwd": ROOT, "origin": { "other": "an agent (runs_tests)" }, "entry": `${ROOT}/${file}`, "runtime": "tsval" }, stopAll);
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

	/** A file that failed without a failed test: it didn't get to run them (a syntax error, a throw at its top level), so
	 *  it's itself the failure, as `node --test` counts one. */
	const diedOutsideATest = (exitCode: number, tests: { "outcome": string }[]): boolean => exitCode !== 0 && !tests.some((test) => test.outcome === "fail");

	const counted = (ran: Ran[]): { "files": number; "pass": number; "fail": number; "skip": number } => {
		const outcomes = ran.flatMap((file) => file.tests.map((test) => test.outcome));

		return { "files": ran.length, "pass": outcomes.filter((outcome) => outcome === "pass").length, "fail": outcomes.filter((outcome) => outcome === "fail").length + ran.filter((file) => diedOutsideATest(file.exitCode, file.tests)).length, "skip": outcomes.filter((outcome) => outcome === "skip" || outcome === "todo").length };
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

			// (a file that isn't there fails, as node --test's does, rather than running nothing and passing: kept nowhere)
			if (!await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${ROOT}/${file}`))).then(() => true, () => false)) {
				batch.ran.push({ "file": file, "exitCode": 1, "ms": 0, "tests": [], "output": `Could not find '${ROOT}/${file}'` });

				continue;
			}

			const result = await runFile(file, signal, approvals, () => { batch.controller.abort(); });

			// (a question for the person: the run ends here, to go on from this file once it's answered — `rest`)
			if (result.asked !== undefined) {
				return { "ask": result.asked, "rest": chosen.slice(index) };
			}

			// (each test against its own earlier runs, before this one's kept among them)
			const earlier = (await readHistory()).filter((run) => run.file === file);
			const percent = vscode.workspace.getConfiguration("run.tests").get<number>("slowerBy", 25);

			await keepReach(file, result.tests);
			await keep({
				"file": file,
				"at": new Date().toISOString(),
				"ms": result.ms,
				"exitCode": result.exitCode,
				...result.stalled === undefined ? {} : { "stalled": result.stalled },
				"tests": result.tests.map((test) => ({ "id": [file, ...test.titles].join(" › "), "outcome": test.outcome, ...test.ms === undefined ? {} : { "ms": test.ms }, ...test.statements === undefined ? {} : { "statements": test.statements }, ...test.error === undefined ? {} : { "error": test.error }, ...test.effects === undefined ? {} : { "effects": test.effects } })),
				"effects": result.effects,
				...diedOutsideATest(result.exitCode, result.tests) ? { "output": result.output } : {}
			});

			batch.ran.push({
				"file": file,
				"exitCode": result.exitCode,
				"ms": result.ms,
				...result.attached ? {} : { "error": "the debugger couldn't take it" },
				...result.stalled === undefined ? {} : { "stalled": result.stalled },
				"tests": result.tests.map((test) => {
					const id = [file, ...test.titles].join(" › ");
					// (a test that passed but did more than it used to, or took longer: said, as a failure is)
					const slower = test.outcome === "pass" ? slowerOf(earlier, id, test, percent) : undefined;

					return { "id": id, "outcome": test.outcome, ...test.error === undefined ? {} : { "error": test.error }, ...test.assertion === undefined ? {} : { "assertion": test.assertion }, ...test.ms === undefined ? {} : { "ms": test.ms }, ...test.statements === undefined ? {} : { "statements": test.statements }, ...slower === undefined ? {} : { "slower": slower }, ...last.has(id) ? { "before": last.get(id) } : {} };
				}),
				...diedOutsideATest(result.exitCode, result.tests) ? { "output": result.output } : {}
			});
		}

		return {
			"files": batch.ran,
			"counts": counted(batch.ran),
			// (stopped: the files after it not run)
			...signal.aborted ? { "stopped": "stopped: the files after the one it stopped in weren't run" } : {},
			...chosen.length === 0 ? { "nothing": listed.length === 0 ? "no affected test is stale: name files to run them anyway" : "no files" } : {}
		};
	};

	/** The runs, by id, to be asked about again: any still going, and the latest of the rest. */
	const batches = new Map<string, Batch>();
	/** A batch of `args`; or `resumed`'s, going on — its id, and what it ran before its question, kept. */
	const startBatch = (args: Record<string, unknown>, resumed?: Batch): Batch => {
		const batch: Batch = { "id": resumed?.id ?? crypto.randomUUID().slice(0, 8), "args": args, "ran": [...resumed?.ran ?? []], "controller": new AbortController(), "done": Promise.resolve() };

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

		// A run its question stopped, answered — asked again by its id, or with the same files (as a tool's call is made
		// again, the approval added): it goes on from the file that asked, the ones before it kept.
		const answers = (each: Batch | undefined): each is Batch => {
			const asked = (each?.result as { "ask"?: Asked } | undefined)?.ask;

			return asked !== undefined && Array.isArray(approved) && approved.includes(asked.key);
		};

		batch ??= typeof run === "string" ? undefined : [...batches.values()].reverse().find((each) => answers(each) && JSON.stringify(each.args["files"] ?? null) === JSON.stringify(given["files"] ?? null));

		if (answers(batch)) {
			const { rest } = batch.result as { "rest"?: string[] };

			batch = startBatch({ ...batch.args, ...rest === undefined ? {} : { "files": rest }, "approved": approved }, batch);
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
