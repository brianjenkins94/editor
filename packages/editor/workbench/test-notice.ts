import type { Skip, TestReport } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { FileRun } from "./test-runs";
import { serve } from "@brianjenkins94/hub";
import { waitFor } from "./readiness";
import { isTestFile } from "./terminal/commands/node/node";

const ROOT = "/workspace";

const KEPT = ".silo/local/notice";

const LEDGER = ".silo/features.json";

const READY_MS = 300_000;

const BUDGET_MS = 90_000;

const MISSED_LISTED = 20;

export type RunFile = (file: string, signal: AbortSignal, approved: string[], stopAll: () => void, imports?: string[], skip?: Skip) => Promise<FileRun>;

export interface Candidate { "key": string; "skip": Skip; "tests": string[] }

export interface Tried { "tests": string[]; "noticed": string[]; "skipped": number }

export interface NoticeKept { "file": string; "at": string; "digests": Record<string, string>; "tried": Record<string, Tried> }

export interface Noticing { "id": string; "tried": number; "noticed": number; "missed": string[] }

export interface Noticed {
	"file": string;
	"statements": number;
	"tried": number;
	"left": number;
	"tests": Noticing[];
	"none": string[];
	"failing"?: string[];
	"asks"?: string;
}

export function keyOf(path: string, line: number, character: number): string {
	return `${path}:${String(line + 1)}:${String(character + 1)}`;
}

function pathOf(file: string): string {
	return file.replace(/^\/workspace\//u, "");
}

function textAt(text: string, [startLine, startCharacter]: [number, number], [endLine, endCharacter]: [number, number]): string {
	const lines = text.split("\n");

	return startLine === endLine
		? (lines[startLine] ?? "").slice(startCharacter, endCharacter)
		: [
				(lines[startLine] ?? "").slice(startCharacter),
				...lines.slice(startLine + 1, endLine),
				(lines[endLine] ?? "").slice(0, endCharacter)
			].join("\n");
}

export function candidatesOf(file: string, tests: TestReport[], textOf: (path: string) => string | undefined, own: (path: string) => boolean): Candidate[] {
	const found = new Map<string, Candidate & { "own": boolean }>();

	for (const test of tests.filter((each) => each.outcome === "pass")) {
		const id = [file, ...test.titles].join(" › ");

		for (const ran of test.files) {
			const path = pathOf(ran.file);
			const text = textOf(path);

			if (path === file || isTestFile(path) || path.includes("node_modules/") || text === undefined) {
				continue;
			}

			for (const [start, end] of ran.statements) {
				if (/^(?:;|debugger;?$|(?:export\s+)?(?:const|let|var|using|await\s+using)\s)/u.test(textAt(text, start, end).trim())) {
					continue;
				}

				const key = keyOf(path, start[0], start[1]);
				const candidate = found.get(key) ?? {
					"key": key,
					"skip": { "file": ran.file, "line": start[0], "character": start[1] },
					"tests": [],
					"own": own(path)
				};

				if (!candidate.tests.includes(id)) {
					candidate.tests.push(id);
				}

				found.set(key, candidate);
			}
		}
	}

	return [
		...found.values()
	].toSorted((one, other) => Number(other.own) - Number(one.own) || one.skip.file.localeCompare(other.skip.file) || one.skip.line - other.skip.line || one.skip.character - other.skip.character).map(({ key, skip, "tests": reaching }) => ({ "key": key, "skip": skip, "tests": reaching }));
}

export function noticingOf(kept: NoticeKept, ids: string[]): Noticing[] {
	return ids.map((id) => {
		const tried = Object.entries(kept.tried).filter(([, each]) => each.skipped > 0 && each.tests.includes(id));
		const missed = tried.filter(([, each]) => !each.noticed.includes(id)).map(([key]) => key);

		return {
			"id": id,
			"tried": tried.length,
			"noticed": tried.length - missed.length,
			"missed": missed.slice(0, MISSED_LISTED)
		};
	});
}

export function prunedOf(kept: NoticeKept | undefined, file: string, digests: Record<string, string>): NoticeKept {
	if (kept === undefined || kept.digests[file] !== digests[file]) {
		return {
			"file": file,
			"at": new Date().toISOString(),
			"digests": digests,
			"tried": {}
		};
	}

	const tried = Object.fromEntries(Object.entries(kept.tried).filter(([key]) => {
		const path = key.slice(0, key.indexOf(":"));

		return kept.digests[path] !== undefined && kept.digests[path] === digests[path];
	}));

	return {
		"file": file,
		"at": kept.at,
		"digests": digests,
		"tried": tried
	};
}

export function triedOf(candidate: Candidate, run: FileRun, file: string): Tried {
	const outcomes = new Map(run.tests.map((test) => [
		[file, ...test.titles].join(" › "),
		test.outcome
	]));

	return {
		"tests": candidate.tests,
		"noticed": candidate.tests.filter((id) => outcomes.get(id) !== "pass"),
		"skipped": run.skipped ?? 0
	};
}

async function digestOf(text: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));

	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function installTestNotice(vscode: typeof vscodeApi, hub: Hub, log: Logger, runFile: RunFile): void {
	const decoder = new TextDecoder();
	const read = async (path: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(`${ROOT}/${path}`))).then((bytes) => decoder.decode(bytes), () => undefined);
	const keptUri = (file: string): vscodeApi.Uri => vscode.Uri.file(`${ROOT}/${KEPT}/${file}.json`);
	const diagnostics = vscode.languages.createDiagnosticCollection("tests-notice");
	const ownPaths = async (file: string): Promise<string[]> => {
		const ledger = JSON.parse(await read(LEDGER) ?? "{}") as Record<string, { "paths"?: string[]; "tests"?: string[] }>;

		return Object.values(ledger).filter((feature) => feature.tests?.includes(file) === true).flatMap((feature) => feature.paths ?? []);
	};

	const mark = async (file: string, tests: Noticing[]): Promise<void> => {
		const text = await read(file) ?? "";
		const lines = text.split("\n");

		diagnostics.set(vscode.Uri.file(`${ROOT}/${file}`), tests.filter((test) => test.tried > 0 && test.noticed === 0).map((test) => {
			const title = test.id.split(" › ").at(-1) ?? "";
			const line = Math.max(0, lines.findIndex((each) => each.includes(JSON.stringify(title)) || each.includes(`'${title}'`) || each.includes(`\`${title}\``)));
			const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, lines[line]?.length ?? 0), `This test noticed none of the ${String(test.tried)} statements it runs broken, each skipped in turn: a drop candidate, for you to decide.`, vscode.DiagnosticSeverity.Information);

			diagnostic.source = "tests";

			return diagnostic;
		}));
	};

	const notice = async (file: string, signal: AbortSignal, budgetMs: number): Promise<Noticed> => log.span("editor.workbench.test-notice.check", { "path": file }, async (span) => {
		const waiting = await waitFor(["workspace", "debugger", "versions"], READY_MS, signal);

		if (waiting.length > 0) {
			throw new Error(`the editor is still starting, waiting on ${waiting.join(" and ")}`);
		}

		const stopAll = (): void => undefined;
		const first = await runFile(file, signal, [], stopAll);
		const ids = first.tests.map((test) => [file, ...test.titles].join(" › "));
		const empty = {
			"file": file,
			"statements": 0,
			"tried": 0,
			"left": 0,
			"tests": [],
			"none": []
		};

		if (first.asked !== undefined) {
			span.end({ "asked": true });

			return { ...empty, "asks": `${first.asked.message} Decide it with runs_tests or a run of the file first.` };
		}

		const failing = first.tests.filter((test) => test.outcome === "fail").map((test) => [file, ...test.titles].join(" › "));

		if (first.exitCode !== 0 || failing.length > 0) {
			span.end({ "failing": failing.length });

			return {
				...empty,
				"failing": failing.length > 0
					? failing
					: [file]
			};
		}

		const paths = [
			...new Set(first.tests.flatMap((test) => test.files.map((ran) => pathOf(ran.file))))
		];
		const texts = new Map(await Promise.all(paths.map(async (path) => [path, await read(path)] as const)));
		const owned = await ownPaths(file);
		const candidates = candidatesOf(file, first.tests, (path) => texts.get(path), (path) => owned.some((own) => (own.endsWith("/")
			? path.startsWith(own)
			: path === own)));
		const digests = Object.fromEntries(await Promise.all([
			file,
			...new Set(candidates.map((candidate) => pathOf(candidate.skip.file)))
		].map(async (path) => [path, await digestOf(texts.get(path) ?? await read(path) ?? "")] as const)));
		const kept = prunedOf(await read(`${KEPT}/${file}.json`).then((text) => (text === undefined
			? undefined
			: JSON.parse(text) as NoticeKept)), file, digests);
		const started = performance.now();
		let mutants = 0;

		for (const candidate of candidates) {
			if (signal.aborted || performance.now() - started > budgetMs) {
				break;
			}

			if (Object.hasOwn(kept.tried, candidate.key)) {
				continue;
			}

			const run = await log.span("editor.workbench.test-notice.mutant", { "path": candidate.key, "count": candidate.tests.length }, async (mutant) => {
				const ran = await runFile(file, signal, [], stopAll, [], candidate.skip);

				mutant.end({ "skipped": ran.skipped ?? 0, "ms": ran.ms });

				return ran;
			});

			if (signal.aborted || run.asked !== undefined) {
				continue;
			}

			kept.tried[candidate.key] = triedOf(candidate, run, file);
			kept.at = new Date().toISOString();
			mutants += 1;
			await vscode.workspace.fs.writeFile(keptUri(file), new TextEncoder().encode(JSON.stringify(kept)));
		}

		const keys = new Set(candidates.map((candidate) => candidate.key));
		const tests = noticingOf({ ...kept, "tried": Object.fromEntries(Object.entries(kept.tried).filter(([key]) => keys.has(key))) }, ids);
		const tried = candidates.filter((candidate) => Object.hasOwn(kept.tried, candidate.key)).length;
		const noticed: Noticed = {
			"file": file,
			"statements": candidates.length,
			"tried": tried,
			"left": candidates.length - tried,
			"tests": tests,
			"none": tests.filter((test) => test.tried > 0 && test.noticed === 0).map((test) => test.id)
		};

		await mark(file, tests);
		span.end({
			"count": candidates.length,
			"mutants": mutants,
			"left": noticed.left,
			"none": noticed.none.length
		});

		return noticed;
	});

	serve(hub, "tests.notice", async (args) => {
		const { file, budgetMs } = (args ?? {}) as { "file"?: unknown; "budgetMs"?: unknown };

		if (typeof file !== "string") {
			throw new TypeError("tests.notice: a test file is wanted");
		}

		return notice(pathOf(file), new AbortController().signal, typeof budgetMs === "number"
			? budgetMs
			: BUDGET_MS);
	});

	vscode.commands.registerCommand("editor.tests.notice", async (given?: unknown) => {
		const uri = given instanceof vscode.Uri
			? given
			: vscode.window.activeTextEditor?.document.uri;
		const file = uri === undefined
			? undefined
			: vscode.workspace.asRelativePath(uri, false);

		if (file === undefined || !isTestFile(file)) {
			void vscode.window.showInformationMessage("Open a test file first: its tests are run with each statement they reach skipped in turn.");

			return undefined;
		}

		const noticed = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": `What ${file}'s tests notice broken`, "cancellable": true }, async (_progress, token) => {
			const controller = new AbortController();

			token.onCancellationRequested(() => {
				controller.abort();
			});

			return notice(file, controller.signal, BUDGET_MS);
		});

		void vscode.window.showInformationMessage(saidOf(noticed));

		return noticed;
	});
}

export function saidOf(noticed: Noticed): string {
	if (noticed.asks !== undefined) {
		return noticed.asks;
	}

	if (noticed.failing !== undefined) {
		return `Not checked: ${noticed.failing.join(", ")} ${noticed.failing.length === 1
			? "doesn't"
			: "don't"} pass, and only a passing test says what it notices.`;
	}

	const every = noticed.tests.filter((test) => test.tried > 0 && test.noticed === test.tried).length;
	const some = noticed.tests.filter((test) => test.noticed > 0 && test.noticed < test.tried).length;
	const left = noticed.left > 0
		? ` ${String(noticed.left)} left: run it again to try them.`
		: "";

	return `${String(noticed.tried)} of the ${String(noticed.statements)} statements its tests run skipped, each in turn: ${String(every)} ${every === 1
		? "test noticed"
		: "tests noticed"} every one, ${String(some)} some, ${String(noticed.none.length)} none (in Problems, for you to decide).${left}`;
}
