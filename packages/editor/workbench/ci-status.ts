/**
 * How a commit did in CI, for agents: `ci.status` { commit?, run?, job?, lines? } answers from GitHub Actions — a
 * commit's runs (each workflow's status and conclusion, and the jobs of each that didn't pass, a failed job's failed
 * steps among them), a run's jobs, or one job: its log up to its first error (else its end), its `##[error]` lines and the tests its node:test
 * report failed (lib's `nodeTestOutcomes`, the test ledger's reading). Its reader: agents' `ci_status`.
 *
 * The repository is the workspace's github.com origin (git-engine.ts `githubRemote`), the commit HEAD unless one is
 * given (a short sha is expanded from the history here). The shell asks GitHub (`github.actions`, shell/github.ts):
 * through the API's proxy signed in with GitHub, otherwise with no credential, a public repository's runs and no logs.
 * What GitHub refused is said with why, as this sign-in sees it.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { nodeTestOutcomes } from "@brianjenkins94/util/silo/outcomes";
import * as engine from "./git-engine";

/** The runs asked for a commit, at most; a log's lines shown by default, and at most; its error lines listed. */
const RUNS = 20;
const LINES = 200;
const MOST_LINES = 2000;
const ERRORS = 50;

/** A run that passed (or had nothing to do): its jobs aren't asked. */
const PASSED = new Set(["success", "skipped", "neutral"]);

/** What the shell answers (`github.actions`): GitHub's, or its refusal. */
export interface Asked {
	"signedIn"?: boolean;
	"refused"?: { "status": number; "message": string };
	// eslint-disable-next-line ts/naming-convention -- GitHub's wire field
	"workflow_runs"?: Record<string, unknown>[];
	"jobs"?: Record<string, unknown>[];
	"log"?: string;
}

export type Ask = (request: Record<string, unknown>) => Promise<Asked>;

/** Why GitHub refused, for what this sign-in can see. */
function refusal(asked: Asked): string {
	const message = asked.refused?.message ?? "GitHub refused";

	if (asked.signedIn !== true) {
		return `${message} — signed out (or signed in without GitHub), only a public repository's runs can be read, and no logs: sign in with GitHub`;
	}

	return asked.refused?.status === 403 || asked.refused?.status === 404 ? `${message} — the sign-in's GitHub App may not have Actions (read) on this repository (packages/api/README.md, *The proxy*)` : message;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A run as an agent reads it. */
function runOf(run: Record<string, unknown>): Record<string, unknown> {
	return { "id": run.id, "workflow": run.name, "event": run.event, "branch": run.head_branch, "status": run.status, "conclusion": run.conclusion, "attempt": run.run_attempt, "started": run.run_started_at, "updated": run.updated_at, "url": run.html_url };
}

/** A job as an agent reads it: the steps that failed, by name. */
function jobOf(job: Record<string, unknown>): Record<string, unknown> {
	const steps = Array.isArray(job.steps) ? job.steps as Record<string, unknown>[] : [];
	const failed = steps.filter((step) => step.conclusion === "failure").map((step) => step.name);

	return { "id": job.id, "name": job.name, "status": job.status, "conclusion": job.conclusion, "started": job.started_at, "completed": job.completed_at, ...failed.length === 0 ? {} : { "failedSteps": failed }, "url": job.html_url };
}

/** A job's log read for an agent: `lines` of it (timestamps and colors off) up to its first error, else its last; its
 *  error lines; the tests it failed. */
export function logOf(log: string, lines = LINES): { "lines": { "total": number; "shown": number }; "failedTests": string[]; "errors": string[]; "log": string } {
	const all = log.replaceAll(/\u001B\[[\d;]*m/gu, "").split(/\r?\n/u).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/u, ""));

	while (all.length > 0 && all.at(-1) === "") {
		all.pop();
	}

	// (up to its first error, where the step that failed ends — after it is the runner's cleanup — or its last)
	const first = all.findIndex((line) => line.startsWith("##[error]"));
	const end = first === -1 ? all.length : first + 1;
	const shown = all.slice(Math.max(0, end - Math.min(Math.max(1, lines), MOST_LINES)), end);
	const failed = nodeTestOutcomes(all.join("\n")).filter(({ outcome }) => outcome === "fail").map(({ titles }) => titles.join(" › "));

	return { "lines": { "total": all.length, "shown": shown.length }, "failedTests": [...new Set(failed)], "errors": all.filter((line) => line.startsWith("##[error]")).slice(0, ERRORS).map((line) => line.slice("##[error]".length)), "log": shown.join("\n") };
}

/** `ci.status`'s answer, from what `ask` (the shell, or a test's) answers. */
export async function ciStatus(ask: Ask, query: { "repository": string; "commit"?: string; "run"?: number; "job"?: number; "lines"?: number }): Promise<Record<string, unknown>> {
	const { repository, commit, run, job, lines } = query;

	if (job !== undefined) {
		const asked = await ask({ "repository": repository, "job": job });

		return asked.refused === undefined ? { "repository": repository, "job": job, ...logOf(asked.log ?? "", lines) } : { "repository": repository, "job": job, "error": refusal(asked) };
	}

	if (run !== undefined) {
		const asked = await ask({ "repository": repository, "run": run });

		return asked.refused === undefined ? { "repository": repository, "run": run, "jobs": (asked.jobs ?? []).map(jobOf) } : { "repository": repository, "run": run, "error": refusal(asked) };
	}

	const asked = await ask({ "repository": repository, "commit": commit, "limit": RUNS });

	if (asked.refused !== undefined) {
		return { "repository": repository, "commit": commit, "error": refusal(asked) };
	}

	const runs: Record<string, unknown>[] = [];

	// (the jobs of a run that didn't pass, or hasn't finished: where to look next)
	for (const each of asked.workflow_runs ?? []) {
		const summary = runOf(each);

		if (!PASSED.has(text(each.conclusion) ?? "") && typeof each.id === "number") {
			const jobs = await ask({ "repository": repository, "run": each.id });

			summary.jobs = jobs.refused === undefined ? (jobs.jobs ?? []).map(jobOf) : refusal(jobs);
		}

		runs.push(summary);
	}

	return { "repository": repository, "commit": commit, "runs": runs, ...runs.length === 0 ? { "none": "no runs for this commit: it isn't pushed, or CI hasn't started on it yet" } : {} };
}

export function installCiStatus(hub: Hub): void {
	const shell = createRpcClient(hub);
	const ask: Ask = async (request) => shell.request("github.actions", request, { "timeoutMs": 60_000 });

	serve(hub, "ci.status", async (args) => {
		const { commit, run, job, lines } = (args ?? {}) as { "commit"?: unknown; "run"?: unknown; "job"?: unknown; "lines"?: unknown };
		const repository = /github\.com\/(.+)\.git$/u.exec(await engine.githubRemote() ?? "")?.[1];

		if (repository === undefined) {
			throw new Error("the workspace has no github.com origin: CI's runs are its GitHub Actions'");
		}

		const wanted = typeof commit === "string" && commit.trim() !== "" ? commit.trim() : await engine.headCommit();
		// (a short sha, expanded from the history here: GitHub matches a run's whole sha)
		const full = wanted === undefined || /^[\da-f]{40}$/u.test(wanted) ? wanted : (await engine.history(500)).find(({ oid }) => oid.startsWith(wanted))?.oid;

		if (typeof job !== "number" && typeof run !== "number" && full === undefined) {
			throw new Error(wanted === undefined ? "the workspace has no commit yet" : `no commit ${wanted} in this history`);
		}

		return ciStatus(ask, { "repository": repository, ...full === undefined ? {} : { "commit": full }, ...typeof run === "number" ? { "run": run } : {}, ...typeof job === "number" ? { "job": job } : {}, ...typeof lines === "number" ? { "lines": lines } : {} });
	});
}
