import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type { CiRun, TestOutcome, TestStanding } from "@brianjenkins94/util/silo/outcomes";
import type * as vscodeApi from "vscode";
import type { Ask } from "./ci-status";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { nodeTestOutcomes, standings } from "@brianjenkins94/util/silo/outcomes";
import { refusal } from "./ci-status";
import * as engine from "./git-engine";

const ROOT = "/workspace";
const KEPT = ".silo/local/ci/outcomes.json";

const RUNS = 20;

const QUIET = 3;

const LISTED = 100;

const READER = 2;

export type Kept = Record<string, TestOutcome[]>;

export async function ciRuns(ask: Ask, repository: string, branch: string, kept: Kept, runs = RUNS): Promise<{ "runs": CiRun[]; "refused"?: string }> {
	const listed = await ask({ "repository": repository, "branch": branch, "limit": LISTED });

	if (listed.refused !== undefined) {
		return {
			"runs": [],
			"refused": refusal(listed)
		};
	}

	if (listed.signedIn !== true) {
		return { "runs": [], "refused": "CI's logs need the editor signed in with GitHub, and it isn't" };
	}

	let refused: string | undefined;
	const testsOf = async (job: Record<string, unknown>): Promise<TestOutcome[]> => {
		const id = String(job.id);

		if (Object.hasOwn(kept, id)) {
			return kept[id];
		}

		if (job.conclusion === "skipped") {
			return [];
		}

		const read = await ask({ "repository": repository, "job": job.id });

		if (read.refused !== undefined || read.log === undefined) {
			if (read.refused?.status === 404 || read.refused?.status === 410) {
				kept[id] = [];
			} else {
				refused ??= refusal(read);
			}

			return [];
		}

		const tests = testsInLog(read.log);

		if (job.status === "completed") {
			kept[id] = tests;
		}

		return tests;
	};

	const completed = (listed.workflow_runs ?? []).filter((run) => run.status === "completed" && run.head_branch === branch);
	const read = await Promise.all([
		...Map.groupBy(completed, (run) => String(run.name)).values()
	].map(async (ofWorkflow) => {
		const its: CiRun[] = [];
		let reported = false;

		for (const [index, run] of ofWorkflow.slice(0, runs).entries()) {
			if (index === QUIET && !reported) {
				break;
			}

			const { jobs = [] } = await ask({ "repository": repository, "run": run.id, "attempts": true });
			const byAttempt = Map.groupBy(jobs, (job) => Number(job.run_attempt ?? 1));
			const attempts = await Promise.all([...byAttempt].map(async ([attempt, ofAttempt]) => ({
				"attempt": attempt,
				"jobs": await Promise.all(ofAttempt.map(async (job) => ({
					"name": String(job.name),
					"conclusion": job.conclusion as string | null,
					"tests": await testsOf(job)
				})))
			})));

			reported ||= attempts.some(({ "jobs": ofAttempt }) => ofAttempt.some((job) => job.tests.length > 0));
			its.push({
				"id": String(run.id),
				"commit": String(run.head_sha),
				"at": String(run.created_at),
				...typeof run.html_url === "string"
					? { "url": run.html_url }
					: {},
				"attempts": attempts
			});
		}

		return its;
	}));

	return {
		"runs": read.flat(),
		...refused === undefined
			? {}
			: { "refused": refused }
	};
}

const PNPM_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z )?((?:\.|[\w@.-]*\/[\w@./-]*) [\w:.-]+): (.*)$/u;

export function testsInLog(log: string): TestOutcome[] {
	const byPackage = new Map<string, string[]>();

	for (const line of log.replaceAll(/\u001B\[[\d;]*m/gu, "").split(/\r?\n/u)) {
		const match = PNPM_LINE.exec(line);
		const [key, text] = match === null
			? ["", line]
			: [match[2], (match[1] ?? "") + match[3]];

		const lines = byPackage.get(key) ?? [];

		lines.push(text);
		byPackage.set(key, lines);
	}

	return [
		...byPackage.values()
	].flatMap((lines) => nodeTestOutcomes(lines.join("\n"))).filter(reported);
}

const reported = (test: TestOutcome): boolean => test.ms !== undefined;

export function fileOf(standing: Pick<TestStanding, "id">, titles: Map<string, Set<string | RegExp>>): string | undefined {
	const first = standing.id.split(" › ")[1];

	if (first === undefined) {
		return undefined;
	}

	const named = [
		...titles.keys()
	].filter((file) => file.split("/").at(-1) === first);

	if (named.length === 1) {
		return named[0];
	}

	const declaring = [...titles].filter(([, declared]) => declared.has(first));

	if (declaring.length > 0) {
		return declaring.length === 1
			? declaring[0][0]
			: undefined;
	}

	const fitting = [...titles].filter(([, declared]) => [...declared].some((title) => title instanceof RegExp && title.test(first)));

	return fitting.length === 1
		? fitting[0][0]
		: undefined;
}

const unescaped = (text: string): string => text.replaceAll(/\\(.)/gu, "$1");

const WORDS = 4;

export function titlesOf(text: string): Set<string | RegExp> {
	const quoted = String.raw`(["'\u0060])((?:(?!\1)[^\\]|\\.)*)\1`;
	const constants = new Map([
		...text.matchAll(new RegExp(String.raw`\b(?:const|let)\s+([\w$]+)\s*=\s*${quoted.replaceAll("\\1", "\\2")}`, "gu"))
	].map((match) => [match[1], match[3]]));
	const patternOf = (template: string, depth = 0): string => template.split(/(\$\{[^}]*\})/u).map((part) => {
		const name = /^\$\{\s*([\w$]+)\s*\}$/u.exec(part)?.[1];

		if (name !== undefined && constants.has(name) && depth < 2) {
			return patternOf(constants.get(name) ?? "", depth + 1);
		}

		return part.startsWith("${")
			? "\u0000"
			: unescaped(part).replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
	}).join("");
	const titles = new Set<string | RegExp>();
	const call = String.raw`\b(?:test|it|describe|suite)(?:\.(?:only|skip|todo|serial))?\(\s*(?:${quoted}|([\w$]+)\s*,)`;

	for (const match of text.matchAll(new RegExp(call, "gu"))) {
		if (match[1] === "\"" || match[1] === "'") {
			titles.add(unescaped(match[2]));

			continue;
		}

		const template = match[3] === undefined
			? match[2]
			: constants.get(match[3]);

		if (template === undefined) {
			continue;
		}

		const pattern = patternOf(template);

		if (!pattern.includes("\u0000")) {
			titles.add(unescaped(template));
		} else if (pattern.replaceAll("\u0000", "").replaceAll(/\\(.)/gu, "$1").trim().length >= WORDS) {
			titles.add(new RegExp(`^${pattern.replaceAll("\u0000", ".*")}$`, "su"));
		}
	}

	return titles;
}

export function installCiOutcomes(vscode: typeof vscodeApi, hub: Hub, log: Observed["log"]): void {
	const shell = createRpcClient(hub);
	const ask: Ask = async (request) => shell.request("github.actions", request, { "timeoutMs": 60_000 });
	const keptUri = vscode.Uri.file(`${ROOT}/${KEPT}`);

	serve(hub, "ci.outcomes", async (args) => {
		const { branch } = (args ?? {}) as { "branch"?: unknown };
		const repository = /github\.com\/(.+)\.git$/u.exec(await engine.githubRemote() ?? "")?.[1];

		if (repository === undefined) {
			return { "standings": [], "runs": 0, "origin": false };
		}

		const on = typeof branch === "string" && branch !== ""
			? branch
			: (await engine.branches()).current ?? "main";

		return log.span("editor.workbench.ci-outcomes.read", { "caller": "ci.outcomes", "op": "standings" }, async (span) => {
			const file = await Promise.resolve(vscode.workspace.fs.readFile(keptUri)).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as { "reader"?: number; "jobs"?: Kept }, () => ({}));
			const kept = file.reader === READER
				? Object.fromEntries(Object.entries(file.jobs ?? {}).map(([id, tests]) => [id, tests.filter(reported)]))
				: {};
			const before = Object.keys(kept).length;
			const read = await ciRuns(ask, repository, on, kept);

			if (Object.keys(kept).length > before) {
				await vscode.workspace.fs.writeFile(keptUri, new TextEncoder().encode(JSON.stringify({ "reader": READER, "jobs": kept })));
			}

			const answer = [
				...standings(read.runs).values()
			];

			span.end({ "count": answer.length, "runs": read.runs.length, "logs": Object.keys(kept).length - before });

			return {
				"standings": answer,
				"runs": read.runs.length,
				"branch": on,
				...read.refused === undefined
					? {}
					: { "refused": read.refused }
			};
		});
	});
}
