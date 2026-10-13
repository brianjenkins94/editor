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
import type { Analyzer } from "@brianjenkins94/util/silo/graph";
import type { Step } from "@brianjenkins94/util/silo/history";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { featuresOf, waysIn } from "@brianjenkins94/util/silo/features";
import { gitObjects, gitSnapshots } from "@brianjenkins94/util/silo/git-snapshots";
import { featuresMarkdown, historyMarkdown, includeByDefault, replay } from "@brianjenkins94/util/silo/history";
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
		for await (const step of replay(gitSnapshots(repo, options), objects.read, analyzer === undefined ? {} : { "analyzer": analyzer })) {
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
