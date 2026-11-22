import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type * as vscodeApi from "vscode";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { nodeTestOutcomes } from "@brianjenkins94/util/silo/outcomes";
import * as engine from "./git-engine";

const RUNS = 20;
const LINES = 200;
const MOST_LINES = 2000;
const ERRORS = 50;

const PASSED = new Set(["success", "skipped", "neutral"]);

export interface Asked {
	"signedIn"?: boolean;
	"refused"?: { "status": number; "message": string };
	// eslint-disable-next-line ts/naming-convention -- GitHub's wire field
	"workflow_runs"?: Record<string, unknown>[];
	"jobs"?: Record<string, unknown>[];
	"log"?: string;
}

export type Ask = (request: Record<string, unknown>) => Promise<Asked>;

export function refusal(asked: Asked): string {
	const message = asked.refused?.message ?? "GitHub refused";

	if (asked.signedIn !== true) {
		return `${message} — signed out (or signed in without GitHub), only a public repository's runs can be read, and no logs: sign in with GitHub`;
	}

	return asked.refused?.status === 403 || asked.refused?.status === 404
		? `${message} — the sign-in's GitHub App may not have Actions (read) on this repository (packages/api/README.md, *The proxy*)`
		: message;
}

function text(value: unknown): string | undefined {
	return typeof value === "string"
		? value
		: undefined;
}

function runOf(run: Record<string, unknown>): Record<string, unknown> {
	return {
		"id": run.id,
		"workflow": run.name,
		"event": run.event,
		"branch": run.head_branch,
		"status": run.status,
		"conclusion": run.conclusion,
		"attempt": run.run_attempt,
		"started": run.run_started_at,
		"updated": run.updated_at,
		"url": run.html_url
	};
}

function jobOf(job: Record<string, unknown>): Record<string, unknown> {
	const steps = Array.isArray(job.steps)
		? job.steps as Record<string, unknown>[]
		: [];
	const failed = steps.filter((step) => step.conclusion === "failure").map((step) => step.name);

	return {
		"id": job.id,
		"name": job.name,
		"status": job.status,
		"conclusion": job.conclusion,
		"started": job.started_at,
		"completed": job.completed_at,
		...failed.length === 0
			? {}
			: { "failedSteps": failed },
		"url": job.html_url
	};
}

export function logOf(log: string, lines = LINES): { "lines": { "total": number; "shown": number }; "failedTests": string[]; "errors": string[]; "log": string } {
	const all = log.replaceAll(/\u001B\[[\d;]*m/gu, "").split(/\r?\n/u).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/u, ""));

	while (all.length > 0 && all.at(-1) === "") {
		all.pop();
	}

	const first = all.findIndex((line) => line.startsWith("##[error]"));
	const end = first === -1
		? all.length
		: first + 1;
	const shown = all.slice(Math.max(0, end - Math.min(Math.max(1, lines), MOST_LINES)), end);
	const failed = nodeTestOutcomes(all.join("\n")).filter(({ outcome }) => outcome === "fail").map(({ titles }) => titles.join(" › "));

	return {
		"lines": { "total": all.length, "shown": shown.length },
		"failedTests": [
			...new Set(failed)
		],
		"errors": all.filter((line) => line.startsWith("##[error]")).slice(0, ERRORS).map((line) => line.slice("##[error]".length)),
		"log": shown.join("\n")
	};
}

export async function ciStatus(ask: Ask, query: { "repository": string; "commit"?: string; "run"?: number; "job"?: number; "lines"?: number }): Promise<Record<string, unknown>> {
	const { repository, commit, run, job, lines } = query;

	if (job !== undefined) {
		const asked = await ask({ "repository": repository, "job": job });

		return asked.refused === undefined
			? {
					"repository": repository,
					"job": job,
					...logOf(asked.log ?? "", lines)
				}
			: {
					"repository": repository,
					"job": job,
					"error": refusal(asked)
				};
	}

	if (run !== undefined) {
		const asked = await ask({ "repository": repository, "run": run });

		return asked.refused === undefined
			? {
					"repository": repository,
					"run": run,
					"jobs": (asked.jobs ?? []).map(jobOf)
				}
			: {
					"repository": repository,
					"run": run,
					"error": refusal(asked)
				};
	}

	const asked = await ask({ "repository": repository, "commit": commit, "limit": RUNS });

	if (asked.refused !== undefined) {
		return {
			"repository": repository,
			"commit": commit,
			"error": refusal(asked)
		};
	}

	const runs: Record<string, unknown>[] = [];

	for (const each of asked.workflow_runs ?? []) {
		const summary = runOf(each);

		if (!PASSED.has(text(each.conclusion) ?? "") && typeof each.id === "number") {
			const jobs = await ask({ "repository": repository, "run": each.id });

			summary.jobs = jobs.refused === undefined
				? (jobs.jobs ?? []).map(jobOf)
				: refusal(jobs);
		}

		runs.push(summary);
	}

	return {
		"repository": repository,
		"commit": commit,
		"runs": runs,
		...runs.length === 0
			? { "none": "no runs for this commit: it isn't pushed, or CI hasn't started on it yet" }
			: {}
	};
}

const LOOK_MS = 15_000;
const GOING_MS = 60_000;
const UNSEEN_TRIES = 5;

export interface Summary {
	"state": "passed" | "failed" | "going" | "none" | "refused";
	"text": string;
	"tooltip": string;
}

export function summaryOf(asked: Asked, commit: string): Summary {
	const short = commit.slice(0, 7);

	if (asked.refused !== undefined) {
		return { "state": "refused", "text": "$(warning) CI", "tooltip": `CI for ${short}: ${refusal(asked)}` };
	}

	const latest = new Map<string, Record<string, unknown>>();

	for (const run of asked.workflow_runs ?? []) {
		const name = text(run.name) ?? JSON.stringify(run.id);

		if (!latest.has(name)) {
			latest.set(name, run);
		}
	}

	const runs = [
		...latest.values()
	];

	if (runs.length === 0) {
		return { "state": "none", "text": "$(circle-outline) CI", "tooltip": `No CI runs for ${short}: it isn't pushed, or CI hasn't started on it yet` };
	}

	const lines = runs.map((run) => `${text(run.name) ?? ""}: ${text(run.conclusion) ?? text(run.status) ?? ""}`);
	const failed = runs.filter((run) => run.status === "completed" && !PASSED.has(text(run.conclusion) ?? "")).map((run) => text(run.name) ?? "");
	const going = runs.some((run) => run.status !== "completed");
	const tooltip = `CI for ${short}\n${lines.join("\n")}`;

	if (failed.length > 0) {
		return { "state": "failed", "text": `$(error) CI: ${failed.join(", ")}${going ? " $(sync~spin)" : ""}`, "tooltip": tooltip };
	}

	return going
		? { "state": "going", "text": "$(sync~spin) CI", "tooltip": tooltip }
		: { "state": "passed", "text": "$(check) CI", "tooltip": tooltip };
}

export function logText(name: string, repository: string, job: number, read: ReturnType<typeof logOf>): string {
	return [
		`${name}: ${repository}, job ${String(job)}`,
		...read.failedTests.length === 0
			? []
			: [
					"",
					"Tests that failed:",
					...read.failedTests.map((test) => `  ✖ ${test}`)
				],
		...read.errors.length === 0
			? []
			: [
					"",
					"Errors:",
					...read.errors.map((error) => `  ${error}`)
				],
		"",
		`── its last ${String(read.lines.shown)} of ${String(read.lines.total)} lines, up to its first error ──`,
		read.log,
		""
	].join("\n");
}

function opOf(request: Record<string, unknown>): string {
	if (typeof request.job === "number") {
		return "job";
	}

	return typeof request.run === "number"
		? "run"
		: "runs";
}

function iconOf(state: { "status"?: string; "conclusion"?: string | null }): string {
	if (state.status !== "completed") {
		return "$(sync~spin)";
	}

	return PASSED.has(state.conclusion ?? "")
		? "$(check)"
		: "$(error)";
}

export function installCiStatus(vscode: typeof vscodeApi, hub: Hub, log: Observed["log"]): void {
	const shell = createRpcClient(hub);
	const ask: Ask = async (request) => log.span("editor.workbench.ci-status.ask", {
		"op": opOf(request)
	}, async () => shell.request("github.actions", request, { "timeoutMs": 60_000 }));
	const repositoryOf = async (): Promise<string | undefined> => /github\.com\/(.+)\.git$/u.exec(await engine.githubRemote() ?? "")?.[1];

	serve(hub, "ci.status", async (args) => {
		const { commit, run, job, lines } = (args ?? {}) as { "commit"?: unknown; "run"?: unknown; "job"?: unknown; "lines"?: unknown };
		const repository = await repositoryOf();

		if (repository === undefined) {
			throw new Error("the workspace has no github.com origin: CI's runs are its GitHub Actions'");
		}

		const wanted = typeof commit === "string" && commit.trim() !== ""
			? commit.trim()
			: await engine.headCommit();
		const full = wanted === undefined || /^[\da-f]{40}$/u.test(wanted)
			? wanted
			: (await engine.history(500)).find(({ oid }) => oid.startsWith(wanted))?.oid;

		if (typeof job !== "number" && typeof run !== "number" && full === undefined) {
			throw new Error(wanted === undefined
				? "the workspace has no commit yet"
				: `no commit ${wanted} in this history`);
		}

		return ciStatus(ask, {
			"repository": repository,
			...full === undefined
				? {}
				: { "commit": full },
			...typeof run === "number"
				? { "run": run }
				: {},
			...typeof job === "number"
				? { "job": job }
				: {},
			...typeof lines === "number"
				? { "lines": lines }
				: {}
		});
	});

	const item = vscode.window.createStatusBarItem("editor.ci", vscode.StatusBarAlignment.Left, -10);
	let shown: { "commit": string; "summary": Summary; "tries": number; "next": number } | undefined;
	let asking = false;

	item.name = "CI";
	item.command = "editor.ci.show";

	const look = async (force = false): Promise<void> => {
		if (asking) {
			return;
		}

		asking = true;

		try {
			const repository = await repositoryOf();
			const head = repository === undefined
				? undefined
				: await engine.headCommit();

			if (repository === undefined || head === undefined) {
				shown = undefined;
				item.hide();

				return;
			}

			const again = shown?.commit === head && (shown.summary.state === "going" || (shown.summary.state === "none" && shown.tries < UNSEEN_TRIES)) && Date.now() >= shown.next;

			if (!force && shown?.commit === head && !again) {
				return;
			}

			const summary = summaryOf(await ask({ "repository": repository, "commit": head, "limit": RUNS }), head);

			shown = {
				"commit": head,
				"summary": summary,
				"tries": shown?.commit === head
					? shown.tries + 1
					: 1,
				"next": Date.now() + GOING_MS
			};
			item.text = summary.text;
			item.tooltip = summary.tooltip;
			item.backgroundColor = summary.state === "failed"
				? new vscode.ThemeColor("statusBarItem.errorBackground")
				: undefined;
			item.show();
		} catch {
		} finally {
			asking = false;
		}
	};

	setInterval(() => {
		void look();
	}, LOOK_MS);

	const logs = new Map<string, string>();

	vscode.workspace.registerTextDocumentContentProvider("ci-log", {
		"provideTextDocumentContent": (uri) => logs.get(uri.toString()) ?? ""
	});

	vscode.commands.registerCommand("editor.ci.show", async (commit?: unknown) => {
		const repository = await repositoryOf();
		const head = repository === undefined || (typeof commit === "string" && /^[\da-f]{40}$/u.test(commit))
			? commit as string | undefined
			: await engine.headCommit();

		if (repository === undefined || head === undefined) {
			void vscode.window.showInformationMessage(repository === undefined
				? "The workspace has no github.com origin: CI's runs are its GitHub Actions'."
				: "The workspace has no commit yet.");

			return;
		}

		type Item = vscodeApi.QuickPickItem & { "url"?: string; "job"?: { "id": number; "name": string } };
		const pick = vscode.window.createQuickPick<Item>();

		pick.title = `CI for ${head.slice(0, 7)}, ${repository}`;
		pick.placeholder = "A run opens on GitHub; a job, its log up to its first error";
		pick.busy = true;
		pick.show();
		void look(true);

		const status = await ciStatus(ask, { "repository": repository, "commit": head });
		const runs = ((status.runs ?? []) as { "workflow"?: string }[]).filter((run, index, all) => all.findIndex((other) => other.workflow === run.workflow) === index) as { "workflow"?: string; "status"?: string; "conclusion"?: string | null; "url"?: string; "jobs"?: { "id": number; "name": string; "conclusion"?: string | null; "status"?: string; "failedSteps"?: string[] }[] | string }[];
		const icon = iconOf;

		const indent = "\u00A0\u00A0\u00A0\u00A0";
		const jobsOf = (run: (typeof runs)[number]): Item[] => (typeof run.jobs === "string"
			? [
					{ "label": `${indent}$(warning) ${run.jobs}` }
				]
			: (run.jobs ?? []).filter((job) => job.status !== "completed" || !PASSED.has(job.conclusion ?? "")).map((job) => ({
					"label": `${indent}${icon(job)} ${job.name}`,
					"description": job.failedSteps === undefined
						? job.conclusion ?? job.status
						: `failed: ${job.failedSteps.join(", ")}`,
					"job": { "id": job.id, "name": job.name }
				})));

		if (typeof status.error === "string") {
			pick.items = [
				{ "label": "$(warning) GitHub refused", "detail": status.error }
			];
		} else if (runs.length === 0) {
			pick.items = [
				{
					"label": "$(circle-outline) No runs",
					"detail": typeof status.none === "string"
						? status.none
						: undefined
				}
			];
		} else {
			pick.items = runs.flatMap((run): Item[] => [
				{ "label": `${icon(run)} ${run.workflow ?? ""}`, "description": run.conclusion ?? run.status, "url": run.url },
				...jobsOf(run)
			]);
		}

		pick.busy = false;
		pick.onDidAccept(async () => {
			const [chosen] = pick.selectedItems;

			pick.hide();

			if (chosen?.job !== undefined) {
				const read = await ciStatus(ask, { "repository": repository, "job": chosen.job.id });

				if (typeof read.error === "string") {
					void vscode.window.showWarningMessage(read.error);

					return;
				}

				const uri = vscode.Uri.from({ "scheme": "ci-log", "path": `/${repository}/${String(chosen.job.id)}/${chosen.job.name.replaceAll("/", "-")}.log` });

				logs.set(uri.toString(), logText(chosen.job.name, repository, chosen.job.id, read as ReturnType<typeof logOf>));
				await vscode.window.showTextDocument(uri, { "preview": true });
			} else if (chosen?.url !== undefined) {
				await vscode.env.openExternal(vscode.Uri.parse(chosen.url));
			}
		});
		pick.onDidHide(() => {
			pick.dispose();
		});
	});

	void look();
}
