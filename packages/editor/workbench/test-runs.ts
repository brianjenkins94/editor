import type { CoverageEvent, Effect, Skip, TestReport, TestsEvent } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { GitService } from "./git-service";
import type { NodeRunner } from "./node-runner";
import type { RunFile } from "./test-notice";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { alignedRows, hunksOf } from "../shared/git-hunks";
import { waitFor } from "./readiness";
import { isTestFile } from "./terminal/commands/node/node";

const ROOT = "/workspace";

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

const READY_MS = 300_000;

const ANSWER_MS = 50_000;

const HISTORY = ".silo/local/runs.jsonl";
const REACH = ".silo/local/reach";
const COVERAGE = ".silo/local/coverage";
const KEPT_RUNS = 30;

const KEPT = 20;

const STALL_MS = 120_000;

const AFFECTED_MS = 60_000;

const COMMIT_READY_MS = 10_000;

const COMMIT_RUNS_MS = 120_000;

const UNTRACED_LISTED = 50;

const OUTPUT = 4000;

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

interface Asked { "message": string; "key": string; "scope": string; "request": Record<string, unknown> }

interface Ran { "file": string; "exitCode": number; "ms": number; "tests": { "id": string; "outcome": string }[]; "output"?: string }

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

export interface RunRecord {
	"file": string;
	"at": string;
	"ms": number;
	"exitCode": number;
	"stalled"?: string;
	"tests": { "id": string; "outcome": string; "ms"?: number; "statements"?: number; "error"?: string; "effects"?: Effect[] }[];
	"effects": Effect[];
	"output"?: string;
}

export interface FileRun { "exitCode": number; "ms": number; "tests": TestReport[]; "effects": Effect[]; "output": string; "attached": boolean; "statements"?: Record<string, Statements>; "asked"?: Asked; "stalled"?: string; "skipped"?: number }

export interface Slower { "by": number; "measure": "statements" | "time"; "typical": number }

const TIMED_RUNS = 3;

const median = (values: number[]): number => values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)] ?? 0;

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

export interface Statements { "ran": [number, number][]; "not": [number, number][] }

export interface CoverageKept { "at": string; "file"?: string; "files": Record<string, Statements> }

export function statementsOf(event: CoverageEvent): Record<string, Statements> {
	return Object.fromEntries([event, ...event.files ?? []].map((loaded) => [loaded.file.replace(/^\/workspace\//u, ""), loaded] as const).filter(([file]) => CODE.test(file) && !file.includes("node_modules/") && !isTestFile(file)).map(([file, loaded]) => [file, {
		"ran": loaded.statements.filter((statement) => statement.count > 0).map((statement) => statement.start),
		"not": loaded.statements.filter((statement) => statement.count === 0).map((statement) => statement.start)
	}]));
}

export function coverageOf(kept: CoverageKept[]): Map<string, { "statements": number; "ran": number; "by": string[] }> {
	const latest = new Map<string, { "at": string; "all": Set<string> }>();
	const ran = new Map<string, Set<string>>();
	const key = ([line, character]: [number, number]): string => `${String(line)}:${String(character)}`;

	for (const { at, files } of kept) {
		for (const [file, { "ran": its, not }] of Object.entries(files)) {
			if ((latest.get(file)?.at ?? "") < at) {
				latest.set(file, { "at": at, "all": new Set([...its, ...not].map(key)) });
			}

			ran.set(file, new Set([...ran.get(file) ?? [], ...its.map(key)]));
		}
	}

	const by = (file: string, all: Set<string>): string[] => [
		...new Set(kept.filter((run) => run.file !== undefined && (run.files[file]?.ran ?? []).some((statement) => all.has(key(statement)))).map((run) => run.file as string))
	].toSorted();

	return new Map([...latest].map(([file, { all }]) => [file, { "statements": all.size, "ran": [...ran.get(file) ?? []].filter((each) => all.has(each)).length, "by": by(file, all) }]));
}

export interface Contention {
	"test"?: string;
	"touches": "reads" | "writes";
	"resource": string;
	"other": string;
	"otherTest"?: string;
	"otherTouches": "reads" | "writes";
}

function touchOf(effect: Effect): "reads" | "writes" | undefined {
	if (effect.how !== "made" || effect.decided === "layer") {
		return undefined;
	}

	return effect.capability === "fs:write" ? "writes" : effect.capability === "fs:read" ? "reads" : undefined;
}

export function contentionsOf(history: RunRecord[]): Map<string, Contention[]> {
	type Touch = { "file": string; "test"?: string; "touches": "reads" | "writes"; "resource": string };
	const byResource = new Map<string, Map<string, Touch>>();
	const add = (touch: Touch): void => {
		const touches = byResource.get(touch.resource) ?? new Map<string, Touch>();
		const known = touches.get(touch.file);

		if (known === undefined || (known.touches === "reads" && touch.touches === "writes") || (known.touches === touch.touches && known.test === undefined && touch.test !== undefined)) {
			touches.set(touch.file, touch);
		}

		byResource.set(touch.resource, touches);
	};

	for (const run of history) {
		const named = new Set<string>();

		for (const test of run.tests) {
			for (const effect of test.effects ?? []) {
				const touches = touchOf(effect);

				if (touches !== undefined) {
					named.add(`${touches}\0${effect.resource}`);
					add({ "file": run.file, "test": test.id, "touches": touches, "resource": effect.resource });
				}
			}
		}

		for (const effect of run.effects) {
			const touches = touchOf(effect);

			if (touches !== undefined && !named.has(`${touches}\0${effect.resource}`)) {
				add({ "file": run.file, "touches": touches, "resource": effect.resource });
			}
		}
	}

	const contentions = new Map<string, Contention[]>();

	for (const [resource, touches] of byResource) {
		for (const touch of touches.values()) {
			const others = [...touches.values()].filter((other) => other.file !== touch.file && (touch.touches === "writes" || other.touches === "writes"));
			for (const other of others) {
				const its = contentions.get(touch.file) ?? [];

				its.push({
					...touch.test === undefined ? {} : { "test": touch.test },
					"touches": touch.touches,
					"resource": resource,
					"other": other.file,
					...other.test === undefined ? {} : { "otherTest": other.test },
					"otherTouches": other.touches
				});
				contentions.set(touch.file, its);
			}
		}
	}

	for (const its of contentions.values()) {
		its.sort((one, other) => Number(one.touches === "reads") - Number(other.touches === "reads") || one.resource.localeCompare(other.resource) || one.other.localeCompare(other.other));
	}

	return contentions;
}

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

export type Kind = "unit" | "UI spec" | "browser suite" | "not a test";

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

interface Affected {
	"id": string;
	"file": string;
	"outcome": string;
	"at": string;
	"stale": boolean;
	"reaches": string[];
}

const CONFIG = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|\.npmrc|tsconfig[^/]*\.json)$|^\.silo\/policy\.json$/u;

export interface Change { "path": string; "lines"?: [number, number][] }

export type Why = "test" | "lines run" | "lines not run" | "not run" | "config" | "not code";

export function changedLines(head: string, working: string): [number, number][] {
	const lines: [number, number][] = [];

	for (const hunk of hunksOf("", head, working, alignedRows(head, working))) {
		for (const side of [hunk.head, hunk.working]) {
			lines.push(side.lines === 0 ? [Math.max(0, side.start - 1), side.start] : [side.start - 1, side.start + side.lines - 2]);
		}
	}

	return lines;
}

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

export function ranFirst(ran: readonly Ran[], asking: readonly string[], left: readonly string[]): string {
	const tests = ran.flatMap((file) => file.tests);
	const passed = tests.filter((test) => test.outcome === "pass").length;
	const failed = [...tests.filter((test) => test.outcome === "fail").map((test) => test.id), ...ran.filter((file) => file.exitCode !== 0 && !file.tests.some((test) => test.outcome === "fail")).map((file) => file.file)];
	const files = (list: readonly string[]): string => `${list.join(", ")}${list.length === 1 ? " hasn't" : " haven't"}`;

	return [
		...ran.length === 0 ? [] : [`Ran the touched tests that hadn't run since their code changed: ${String(passed)} passed${passed === 0 ? "" : ", vouched for"}${failed.length === 0 ? "" : `, ${String(failed.length)} failed (${failed.join(", ")})`}.`],
		...asking.length === 0 ? [] : [`${files(asking)}: ${asking.length === 1 ? "it asks" : "they ask"} for a capability, so CI runs ${asking.length === 1 ? "it" : "them"}.`],
		...left.length === 0 ? [] : [`${files(left)}: not in time, so CI runs ${left.length === 1 ? "it" : "them"}.`]
	].join(" ");
}

export function installTestRuns(vscode: typeof vscodeApi, hub: Hub, git: GitService, runner: NodeRunner): { "runFile": RunFile } {
	const rpc = createRpcClient(hub);
	const decoder = new TextDecoder();
	const read = async (path: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => decoder.decode(bytes), () => undefined);
	const keptIn = async (folder: string): Promise<unknown[]> => {
		const found: unknown[] = [];
		const walk = async (uri: vscodeApi.Uri): Promise<void> => {
			for (const [name, type] of await Promise.resolve(vscode.workspace.fs.readDirectory(uri)).catch(() => [] as [string, vscodeApi.FileType][])) {
				const each = vscode.Uri.joinPath(uri, name);

				if (type === vscode.FileType.Directory) {
					await walk(each);
				} else if (name.endsWith(".json")) {
					found.push(JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(each))));
				}
			}
		};

		await walk(vscode.Uri.file(`${ROOT}/${folder}`));

		return found;
	};
	const readReach = async (): Promise<Record<string, Record<string, [number, number][]>>> => Object.assign({}, ...await keptIn(REACH)) as Record<string, Record<string, [number, number][]>>;

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

	const affected = async (paths?: string[], glance = false): Promise<{ "tests": Affected[]; "changed": string[]; "why": { "path": string; "why": Why; "tests": number }[]; "untraced": string[]; "untracedLeftOut"?: number; "outside": number }> => {
		const changed = paths ?? (await git.status({ "whole": !glance })).files.filter((change) => change.status !== "D").map((change) => change.path);
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

	const keepReach = async (file: string, tests: TestReport[]): Promise<void> => {
		const reach = Object.fromEntries(tests.map((test) => [[file, ...test.titles].join(" › "), Object.fromEntries(test.files.map((ran) => [ran.file.replace(/^\/workspace\//u, ""), rangesOf(ran.statements)]))]));

		await vscode.workspace.fs.writeFile(vscode.Uri.file(`${ROOT}/${REACH}/${file}.json`), new TextEncoder().encode(JSON.stringify(reach)));
	};

	serve(hub, "tests.reach", async () => ({ "reach": await readReach() }));

	const keepCoverage = async (file: string, files: Record<string, Statements>): Promise<void> => {
		await vscode.workspace.fs.writeFile(vscode.Uri.file(`${ROOT}/${COVERAGE}/${file}.json`), new TextEncoder().encode(JSON.stringify({ "at": new Date().toISOString(), "file": file, "files": files } satisfies CoverageKept)));
	};

	serve(hub, "tests.coverage", async () => ({ "coverage": Object.fromEntries(coverageOf(await keptIn(COVERAGE) as CoverageKept[])) }));

	const runFile = async (file: string, signal: AbortSignal, approved: string[], stopAll: () => void, imports: string[] = [], skip?: Skip): Promise<FileRun> => {
		const controller = new AbortController();
		const stop = (): void => {
			controller.abort();
		};

		signal.addEventListener("abort", stop, { "once": true });

		const run = runner.runs.start({ "title": skip === undefined ? `node --test ${file}` : `node --test ${file} (${skip.file.replace(/^\/workspace\//u, "")}:${String(skip.line + 1)} skipped)`, "kind": "task", "cwd": ROOT, "origin": { "other": "an agent (runs_tests)" }, "entry": `${ROOT}/${file}`, "runtime": "tsval" }, stopAll);
		let reported: (TestsEvent & { "skipped"?: number }) | undefined;
		let covered: CoverageEvent | undefined;
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
			} else if (event.event === "coverage") {
				covered = event.body as CoverageEvent;
			} else if (event.event === "ask") {
				const { line, callee, capability, resource, resolved, "file": where = `${ROOT}/${file}` } = event.body as { "line": number; "callee": string; "capability": string; "resource": string; "resolved"?: boolean; "file"?: string };
				const scope = resolved === false ? scopeOf(capability, `<as ${file} works it out>`) : scopeOf(capability, resource);
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
				"noDebug": true,
				"runtimeArgs": imports.flatMap((each) => ["--import", each]),
				...skip === undefined ? {} : { "skip": skip },
				"signal": controller.signal,
				"onOutput": (_stream, text) => {
					output = (output + text).slice(-OUTPUT);
					active = performance.now();
				}
			});

			run.end(debugged.attached ? debugged.exitCode : 1, controller.signal.aborted);

			const { "effects": kept } = await rpc.request("run.effects", { "run": run.id }, { "timeoutMs": 5000, "waitForResponderMs": 5000 }).catch(() => ({ "effects": [] as Effect[] })) as { "effects": Effect[] };

			effects = [...effects, ...kept];

			return { "exitCode": debugged.attached && stalled === undefined ? debugged.exitCode : 1, "ms": Math.round(performance.now() - started), "effects": effects, "tests": reported?.tests ?? [], "output": output, "attached": debugged.attached, ...reported?.skipped === undefined ? {} : { "skipped": reported.skipped }, ...covered === undefined ? {} : { "statements": statementsOf(covered) }, ...asked === undefined ? {} : { "asked": asked }, ...stalled === undefined ? {} : { "stalled": stalled } };
		} finally {
			clearInterval(watching);
			starting.dispose();
			listening.dispose();
			signal.removeEventListener("abort", stop);
		}
	};

	const diedOutsideATest = (exitCode: number, tests: { "outcome": string }[]): boolean => exitCode !== 0 && !tests.some((test) => test.outcome === "fail");

	const counted = (ran: Ran[]): { "files": number; "pass": number; "fail": number; "skip": number } => {
		const outcomes = ran.flatMap((file) => file.tests.map((test) => test.outcome));

		return { "files": ran.length, "pass": outcomes.filter((outcome) => outcome === "pass").length, "fail": outcomes.filter((outcome) => outcome === "fail").length + ran.filter((file) => diedOutsideATest(file.exitCode, file.tests)).length, "skip": outcomes.filter((outcome) => outcome === "skip" || outcome === "todo").length };
	};

	const runAndKeep = async (file: string, signal: AbortSignal, approvals: string[], stopAll: () => void, last: ReadonlyMap<string, string>, imports: string[] = []): Promise<Ran | { "asked": Asked }> => {
		const result = await runFile(file, signal, approvals, stopAll, imports);

		if (result.asked !== undefined) {
			return { "asked": result.asked };
		}

		const earlier = (await readHistory()).filter((run) => run.file === file);
		const percent = vscode.workspace.getConfiguration("run.tests").get<number>("slowerBy", 25);

		await keepReach(file, result.tests);

		if (result.statements !== undefined) {
			await keepCoverage(file, result.statements);
		}
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

		return {
			"file": file,
			"exitCode": result.exitCode,
			"ms": result.ms,
			...result.attached ? {} : { "error": "the debugger couldn't take it" },
			...result.stalled === undefined ? {} : { "stalled": result.stalled },
			"tests": result.tests.map((test) => {
				const id = [file, ...test.titles].join(" › ");
				const slower = test.outcome === "pass" ? slowerOf(earlier, id, test, percent) : undefined;

				return { "id": id, "outcome": test.outcome, ...test.error === undefined ? {} : { "error": test.error }, ...test.assertion === undefined ? {} : { "assertion": test.assertion }, ...test.ms === undefined ? {} : { "ms": test.ms }, ...test.statements === undefined ? {} : { "statements": test.statements }, ...slower === undefined ? {} : { "slower": slower }, ...last.has(id) ? { "before": last.get(id) } : {} };
			}),
			...diedOutsideATest(result.exitCode, result.tests) ? { "output": result.output } : {}
		};
	};

	const runBatch = async (batch: Batch): Promise<Record<string, unknown>> => {
		const { files, "affected": onlyAffected, approved, imports } = batch.args as { "files"?: unknown; "affected"?: unknown; "approved"?: unknown; "imports"?: unknown };
		const approvals = Array.isArray(approved) ? approved.filter((key): key is string => typeof key === "string") : [];
		const preloads = Array.isArray(imports) ? imports.filter((each): each is string => typeof each === "string") : [];
		const { signal } = batch.controller;

		batch.now = { "doing": "waiting for the editor to be up (its workspace, its debugger and its packages' versions)", "since": performance.now() };

		const waiting = await waitFor(["workspace", "debugger", "versions"], READY_MS, signal);

		if (waiting.length > 0) {
			throw new Error(`the editor is still starting — after ${String(READY_MS / 1000)} s, waiting on ${waiting.join(" and ")} (readiness.ts)`);
		}

		const listed = Array.isArray(files) ? files.filter((file): file is string => typeof file === "string").map((file) => file.replace(/^\/workspace\//u, "")) : [];
		const tooLong = `working out the affected tests took over ${String(AFFECTED_MS / 1000)} s (their traces, the workspace's files)`;

		batch.now = { "doing": "working out the affected tests", "since": performance.now() };

		const before = onlyAffected === true || listed.length === 0 ? await within(affected(), AFFECTED_MS, tooLong) : undefined;
		const chosen = listed.length > 0 ? listed : [...new Set((before?.tests ?? []).filter((test) => test.stale).map((test) => test.file))];
		const last = new Map((before ?? await within(affected(chosen), AFFECTED_MS, tooLong).catch(() => ({ "tests": [] as Affected[] }))).tests.map((test) => [test.id, test.outcome]));

		for (const [index, file] of chosen.entries()) {
			if (signal.aborted) {
				break;
			}

			batch.now = { "doing": `running ${file} (${String(index + 1)} of ${String(chosen.length)})`, "since": performance.now() };

			if (!await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(`${ROOT}/${file}`))).then(() => true, () => false)) {
				batch.ran.push({ "file": file, "exitCode": 1, "ms": 0, "tests": [], "output": `Could not find '${ROOT}/${file}'` });

				continue;
			}

			const kept = await runAndKeep(file, signal, approvals, () => { batch.controller.abort(); }, last, preloads);

			if ("asked" in kept) {
				return { "ask": kept.asked, "rest": chosen.slice(index) };
			}

			batch.ran.push(kept);
		}

		return {
			"files": batch.ran,
			"counts": counted(batch.ran),
			...signal.aborted ? { "stopped": "stopped: the files after the one it stopped in weren't run" } : {},
			...chosen.length === 0 ? { "nothing": listed.length === 0 ? "no affected test is stale: name files to run them anyway" : "no files" } : {}
		};
	};

	git.beforeCommit(async (span) => {
		const waiting = await waitFor(["workspace", "debugger", "versions"], COMMIT_READY_MS);

		if (waiting.length > 0) {
			return `No tests ran first: the editor is still starting (${waiting.join(" and ")}), so CI runs them.`;
		}

		const found = await within(affected(), AFFECTED_MS, `working out the touched tests took over ${String(AFFECTED_MS / 1000)} s`);
		const files = [...new Set(found.tests.filter((test) => test.stale).map((test) => test.file))];

		span.info("touched", { "count": files.length });

		if (files.length === 0) {
			return undefined;
		}

		const controller = new AbortController();
		const last = new Map(found.tests.map((test) => [test.id, test.outcome]));
		const started = performance.now();
		const ran: Ran[] = [];
		const asking: string[] = [];
		const left: string[] = [];

		for (const file of files) {
			if (controller.signal.aborted || performance.now() - started > COMMIT_RUNS_MS) {
				left.push(file);

				continue;
			}

			const kept = await runAndKeep(file, controller.signal, [], () => { controller.abort(); }, last);

			if ("asked" in kept) {
				asking.push(file);
			} else {
				ran.push(kept);
			}
		}

		await Promise.resolve(vscode.commands.executeCommand("history.vouched")).catch(() => undefined);
		span.end({ "files": ran.length, "asking": asking.length, "left": left.length });

		return ranFirst(ran, asking, left);
	});

	const batches = new Map<string, Batch>();
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

		let timer: ReturnType<typeof setTimeout> | undefined;
		const answered = await Promise.race([batch.done.then(() => true), new Promise<boolean>((resolve) => {
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

	return { "runFile": runFile };
}
