/**
 * How each test has come out in CI (packages/silo/README.md, *Tests by feature, in your face*: "A test ledger"): the
 * branch's latest completed runs of each workflow on the workspace's GitHub origin, every attempt's jobs, and the tests
 * each job's log reported (lib's `nodeTestOutcomes`), folded into each test's standing (lib's `standings`: its last
 * verdict, its streak, its flakes, when it last failed). Nothing is recorded for it: GitHub keeps the runs and their logs.
 *
 * - `ci.outcomes` { branch? }: those standings, the workspace's branch unless asked of another (none, and `origin` false,
 *   for a workspace with no github.com origin). What the table of features and tests reads (features-view.tsx), each
 *   standing joined to the test file it's of (`fileOf`).
 *
 * A finished job's tests are kept here (`.silo/local/ci/outcomes.json`, this machine's: a finished log never changes), so
 * only runs since are asked of GitHub again. A workflow whose latest QUIET runs' logs report no tests (a deploy's) isn't
 * read further back. The shell asks GitHub, as ci-status.ts's does (`github.actions`): logs need the sign-in to be GitHub's.
 */
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

/** Each workflow's runs read, at most: a streak of 20 is a test's rest (packages/silo/README.md, decision 17). */
const RUNS = 20;

/** How many of a workflow's latest runs may report no tests before it's taken for one that runs none. */
const QUIET = 3;

/** The runs GitHub lists in one ask, every workflow's: enough to hold RUNS of each of a few. */
const LISTED = 100;

/** Which reading of a log what's kept is (testsInLog): kept by another, it's read again. */
const READER = 2;

/** What a finished job's log reported, by its id. */
export type Kept = Record<string, TestOutcome[]>;

/**
 * The latest RUNS completed runs of each of `branch`'s workflows, each attempt's jobs with the tests their logs reported.
 * A job in `kept` isn't asked again; a finished job read is added to it. GitHub's refusal of the list is said
 * (`refused`); a log refused reads as no tests, and says why too.
 */
export async function ciRuns(ask: Ask, repository: string, branch: string, kept: Kept, runs = RUNS): Promise<{ "runs": CiRun[]; "refused"?: string }> {
	const listed = await ask({ "repository": repository, "branch": branch, "limit": LISTED });

	if (listed.refused !== undefined) {
		return {
			"runs": [],
			"refused": refusal(listed)
		};
	}

	// (a log needs the sign-in to be GitHub's: without, every job's would be refused, each one of GitHub's 60 an hour)
	if (listed.signedIn !== true) {
		return { "runs": [], "refused": "CI's logs need the editor signed in with GitHub, and it isn't" };
	}

	let refused: string | undefined;
	const testsOf = async (job: Record<string, unknown>): Promise<TestOutcome[]> => {
		const id = String(job.id);

		if (Object.hasOwn(kept, id)) {
			return kept[id];
		}

		// (a job that never ran has no log)
		if (job.conclusion === "skipped") {
			return [];
		}

		const read = await ask({ "repository": repository, "job": job.id });

		if (read.refused !== undefined || read.log === undefined) {
			// (a log GitHub no longer has, or never had — a job cancelled before it started — is no tests, for good)
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
	// (each workflow's runs read beside the others', its own one after another: whether it reports tests is known in order)
	const read = await Promise.all([
		...Map.groupBy(completed, (run) => String(run.name)).values()
	].map(async (ofWorkflow) => {
		const its: CiRun[] = [];
		let reported = false;

		for (const [index, run] of ofWorkflow.slice(0, runs).entries()) {
			// (a workflow whose latest runs reported no tests: a build's, a deploy's — not one whose last run failed to
			// install, as an architecture run can)
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

/** A workspace's script's line as pnpm prints it, run in each package (`pnpm -r`): `<package's folder> <script>: <line>`,
 *  after the log's timestamp. */
const PNPM_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z )?((?:\.|[\w@.-]*\/[\w@./-]*) [\w:.-]+): (.*)$/u;

/** The tests a job's log reported (node:test's spec reporter, lib's `nodeTestOutcomes`): its colours off, and a package's
 *  lines read apart from another's, pnpm printing them as they come, each after its package's name. */
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
	].flatMap((lines) => nodeTestOutcomes(lines.join("\n")));
}

/** The test file a standing is of: one whose name is its first title (a suite that names each test by its file, as
 *  test/in-editor.mjs does its specs), else the one file that declares a test of that title. */
export function fileOf(standing: Pick<TestStanding, "id">, titles: Map<string, Set<string>>): string | undefined {
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

	return declaring.length === 1
		? declaring[0][0]
		: undefined;
}

/** The titles a test file declares, as literals (`test("…"`, `it(`, `describe(`, `suite(`), as a reporter prints them. */
export function titlesOf(text: string): Set<string> {
	return new Set([
		...text.matchAll(/\b(?:test|it|describe|suite)(?:\.(?:only|skip|todo|serial))?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/gu)
	].map((match) => match[2].replaceAll(/\\(.)/gu, "$1")));
}

export function installCiOutcomes(vscode: typeof vscodeApi, hub: Hub, log: Observed["log"]): void {
	const shell = createRpcClient(hub);
	const ask: Ask = async (request) => shell.request("github.actions", request, { "timeoutMs": 60_000 });
	const keptUri = vscode.Uri.file(`${ROOT}/${KEPT}`);

	serve(hub, "ci.outcomes", async (args) => {
		const { branch } = (args ?? {}) as { "branch"?: unknown };
		const repository = /github\.com\/(.+)\.git$/u.exec(await engine.githubRemote() ?? "")?.[1];

		if (repository === undefined) {
			// (no CI to speak of: nothing said, rather than a line above the table in every workspace that isn't GitHub's)
			return { "standings": [], "runs": 0, "origin": false };
		}

		const on = typeof branch === "string" && branch !== ""
			? branch
			: (await engine.branches()).current ?? "main";

		return log.span("editor.workbench.ci-outcomes.read", { "caller": "ci.outcomes", "op": "standings" }, async (span) => {
			// (what an older reading of the logs kept is read again: `reader` says which)
			const file = await Promise.resolve(vscode.workspace.fs.readFile(keptUri)).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as { "reader"?: number; "jobs"?: Kept }, () => ({}));
			const kept = file.reader === READER
				? file.jobs ?? {}
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
