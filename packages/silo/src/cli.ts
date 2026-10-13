/**
 * silo — the command line. What a program's code says about it, derived and never kept by hand:
 *
 *   silo features [repo] [--json]                      every way into the program, found in its code
 *   silo history [repo] [--since …] [--until …] [--json] what changed, told from the code's snapshots — not from
 *                [--analyzer auto|oxc|typescript]        commit messages, which are never read; the code read by the
 *                                                        repository's TypeScript when it's ≥ 7.1, else by oxc
 *
 * The logic is @brianjenkins94/util/silo (features, history, git-snapshots): pure, so the editor runs the same code in
 * the browser over its own workspace. This file is only the desktop's way to ask: git, the disk, and stdout.
 */
import type { CoverageStep } from "@brianjenkins94/util/silo/coverage";
import type { Analyzer } from "@brianjenkins94/util/silo/graph";
import type { Step } from "@brianjenkins94/util/silo/history";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { ensureBaseline, ensureSiloDir, loadBaseline, siloPaths } from "@brianjenkins94/util/silo/audit";
import { coverageMarkdown, coverageReplay } from "@brianjenkins94/util/silo/coverage";
import { beyondBaseline } from "@brianjenkins94/util/silo/evidence";
import { featuresOf } from "@brianjenkins94/util/silo/features";
import { gitObjects, gitSnapshots } from "@brianjenkins94/util/silo/git-snapshots";
import { featuresMarkdown, historyMarkdown, includeByDefault, replay } from "@brianjenkins94/util/silo/history";
import { oxcAnalyzer, waysIn } from "@brianjenkins94/util/silo/oxc";
import { loadRuns } from "@brianjenkins94/util/silo/runs";
import { typescriptAnalyzer } from "@brianjenkins94/util/silo/typescript";

/** The repository a path is in. */
function repoOf(directory: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], { "cwd": path.resolve(directory), "encoding": "utf8" }).trim();
}

/** The program's features now: its tracked files as they are on disk. */
export function currentFeatures(repo: string): ReturnType<typeof featuresOf> {
	const files = execFileSync("git", ["ls-files"], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).split("\n").filter((file) => file !== "" && includeByDefault(file));

	return featuresOf(files.flatMap((file) => {
		try {
			return [{ "file": file, "ways": waysIn(file, fs.readFileSync(path.join(repo, file))) }];
		} catch {
			return []; // deleted on disk, not yet in git
		}
	}));
}

/** Which analyzer reads the code: `typescript` (the repository's TypeScript, ≥ 7.1), `oxc`, or `auto` — TypeScript's when
 *  there is one, else oxc's. */
export type AnalyzerChoice = "auto" | "oxc" | "typescript";

/** The steps of a span of the history (its baseline, the commit before it, comes first and tells nothing). */
export async function historyOf(repo: string, options: { "since"?: string; "until"?: string; "ref"?: string; "analyzer"?: AnalyzerChoice } = {}): Promise<Step[]> {
	const choice = options.analyzer ?? "auto";
	const analyzer: Analyzer | undefined = choice === "oxc" ? undefined : await typescriptAnalyzer({ "root": repo });

	if (choice === "typescript" && analyzer === undefined) {
		throw new Error("--analyzer typescript needs TypeScript 7.1 or later installed in the repository");
	}

	const objects = gitObjects(repo);
	const steps: Step[] = [];

	try {
		for await (const step of replay(gitSnapshots(repo, options), objects.read, { "analyzer": analyzer ?? oxcAnalyzer() })) {
			steps.push(step);
		}
	} finally {
		objects.close();
		analyzer?.close?.();
	}

	return steps;
}

/** Where each span of a text is, as BABLR names them — the ids runtime evidence is keyed by (the editor's BABLR worker
 *  does the same). Undefined for a text BABLR's grammar doesn't take. */
async function placeSpans(source: string): Promise<{ "id": string; "start": number; "end": number }[] | undefined> {
	const bablr = await import("@brianjenkins94/bablr") as { "cstSpansAsync": (source: string, language: string) => Promise<unknown>; "spanAnchors": (source: string, language: string, cst: unknown) => { "id": string; "type": string | null; "start": number; "end": number }[] };

	try {
		const cst = await bablr.cstSpansAsync(source, "Program");

		return cst === undefined ? undefined : bablr.spanAnchors(source, "Program", cst).filter((span) => span.type !== null).map(({ id, start, end }) => ({ "id": id, "start": start, "end": end }));
	} catch {
		return undefined;
	}
}

/** What the runs committed in a span of the history did, commit by commit (its baseline, the commit before it, first). */
export async function coverageOf(repo: string, options: { "since"?: string; "until"?: string; "ref"?: string; "analyzer"?: AnalyzerChoice } = {}): Promise<CoverageStep[]> {
	const choice = options.analyzer ?? "auto";
	const analyzer: Analyzer | undefined = choice === "oxc" ? undefined : await typescriptAnalyzer({ "root": repo });

	if (choice === "typescript" && analyzer === undefined) {
		throw new Error("--analyzer typescript needs TypeScript 7.1 or later installed in the repository");
	}

	const objects = gitObjects(repo);
	const steps: CoverageStep[] = [];

	try {
		for await (const step of coverageReplay(gitSnapshots(repo, options), objects.read, { "analyzer": analyzer ?? oxcAnalyzer(), "place": placeSpans })) {
			steps.push(step);
		}
	} finally {
		objects.close();
		analyzer?.close?.();
	}

	return steps;
}

const repoArgument = { "format": String, "default": ".", "positional": true, "doc": "A directory in the repository (default: the current one)." } as const;
const jsonFlag = { "format": Boolean, "default": false, "doc": "Print the data as JSON instead of a document." } as const;

export const app = subcommands({
	"name": "silo",
	"description": "What a program's code says about it — derived, never kept by hand.",
	"commands": [
		command({
			"name": "init",
			"description": "Start keeping .silo/ in a repository: its .gitignore and .gitattributes, and the baseline — what the code imports and what each installed package can do — accepted as it is now.",
			"config": juvy({ "repo": repoArgument }),
			"handler": async (config) => {
				const paths = siloPaths(repoOf(config.get("repo")));

				await ensureSiloDir(paths);

				const { created, baseline } = await ensureBaseline(paths);
				const packages = Object.keys(baseline.packages).length;
				const imports = Object.values(baseline.consumer).reduce((count, workspace) => count + Object.keys(workspace).length, 0);
				const relative = path.relative(process.cwd(), paths.baseline);
				const where = relative.startsWith("..") ? paths.baseline : relative;

				process.stdout.write(created
					? `Made ${where}: ${imports} imports, ${packages} packages. Commit it: a change to what they can do is drift from here.\n`
					: `${where} is already there (${imports} imports, ${packages} packages) — left as it is: changing it is approving.\n`);
			}
		}),
		command({
			"name": "check",
			"description": "What the runs' packages did that the baseline doesn't account for — a capability not accepted of a package, or a package it doesn't have. Exits 1 when there's any.",
			"config": juvy({ "repo": repoArgument, "json": jsonFlag }),
			"handler": (config) => {
				const paths = siloPaths(repoOf(config.get("repo")));

				if (!fs.existsSync(paths.baseline)) {
					process.stderr.write("No baseline yet: `silo init` makes one.\n");
					process.exitCode = 1;

					return;
				}

				const found = beyondBaseline(loadRuns(paths), loadBaseline(paths).packages);

				if (config.get("json")) {
					process.stdout.write(JSON.stringify(found, undefined, "\t") + "\n");
				} else if (found.length === 0) {
					process.stdout.write("Every package call the runs made is one the baseline accepts.\n");
				} else {
					for (const each of found) {
						const what = each.kind === "new" ? "isn't in the baseline" : `may not ${each.capability}` + (each.accepted === undefined ? "" : ` (accepted at ${each.accepted.version ?? "no version"}: ${each.accepted.caps.join(", ") || "nothing"})`);

						process.stdout.write(`${each.package} ${what} — ${each.capability} ${each.resource}, ${each.how} ×${each.calls}, in ${each.run.user}'s run of ${each.run.entry} (${each.run.endedAt})\n`);
					}
				}

				if (found.length > 0) {
					process.exitCode = 1;
				}
			}
		}),
		command({
			"name": "coverage",
			"description": "What the runs committed in .silo/ ran, commit by commit: what started running, what stopped, and what was reached and never ran — by feature, or by folder where no feature reaches it — and what changed alongside.",
			"config": juvy({
				"repo": repoArgument,
				"since": { "format": String, "default": "", "doc": "Start of the span: anything git's --since takes. Default: the whole history." },
				"until": { "format": String, "default": "", "doc": "End of the span, as git's --until takes it. Default: now." },
				"ref": { "format": String, "default": "HEAD", "doc": "The branch or commit to walk back from." },
				"analyzer": { "format": ["auto", "oxc", "typescript"], "default": "auto", "doc": "What reads the code: the repository's TypeScript (7.1 or later), oxc, or auto." },
				"json": jsonFlag
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const since = config.get("since");
				const until = config.get("until");
				const steps = await coverageOf(repo, { "ref": config.get("ref"), "analyzer": config.get("analyzer") as AnalyzerChoice, ...since === "" ? {} : { "since": since }, ...until === "" ? {} : { "until": until } });
				const span = since === "" ? steps : steps.slice(1);

				process.stdout.write(config.get("json") ? JSON.stringify(span.map((step) => ({ ...step, "features": Object.fromEntries(step.features) })), undefined, "\t") + "\n" : coverageMarkdown(span, { "title": "Coverage of " + path.basename(repo) }));
			}
		}),
		command({
			"name": "features",
			"description": "Every way into the program — commands, views, settings, buttons, agent tools, hub requests… — found in its code.",
			"config": juvy({ "repo": repoArgument, "json": jsonFlag }),
			"handler": (config) => {
				const repo = repoOf(config.get("repo"));
				const features = [...currentFeatures(repo).values()];

				process.stdout.write(config.get("json") ? JSON.stringify(features, undefined, "\t") + "\n" : featuresMarkdown(features, { "title": "Features of " + path.basename(repo) }));
			}
		}),
		command({
			"name": "history",
			"description": "What changed, told from the code's snapshots (git's first-parent history) — never from commit messages.",
			"config": juvy({
				"repo": repoArgument,
				"since": { "format": String, "default": "", "doc": "Start of the span: anything git's --since takes (\"7 days ago\", 2026-10-05). Default: the whole history." },
				"until": { "format": String, "default": "", "doc": "End of the span, as git's --until takes it. Default: now." },
				"ref": { "format": String, "default": "HEAD", "doc": "The branch or commit to walk back from." },
				"analyzer": { "format": ["auto", "oxc", "typescript"], "default": "auto", "doc": "What reads the code: the repository's TypeScript (7.1 or later), oxc, or auto — TypeScript when there is one." },
				"json": jsonFlag
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const since = config.get("since"), until = config.get("until");
				const steps = await historyOf(repo, { "ref": config.get("ref"), "analyzer": config.get("analyzer") as AnalyzerChoice, ...since === "" ? {} : { "since": since }, ...until === "" ? {} : { "until": until } });
				const span = since === "" ? steps : steps.slice(1); // the baseline only gives the first commit something to compare with

				process.stdout.write(config.get("json") ? JSON.stringify(span, undefined, "\t") + "\n" : historyMarkdown(span, { "title": "History of " + path.basename(repo) }));
			}
		})
	]
});

if (isEntry(import.meta)) {
	await run(app);
}
