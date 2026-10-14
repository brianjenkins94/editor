/**
 * silo — the command line. What a program's code says about it, derived and never kept by hand:
 *
 *   silo init [repo]                                   start keeping .silo/: the baseline, synced with what's installed
 *   silo install [package…] [--min-age 7] [--project …] install — nothing newer than a week — and sync the baseline
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
import { execFileSync, spawnSync } from "node:child_process";
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
 *  does the same). Throws, with BABLR's reason, for a text its grammar doesn't take. */
async function placeSpans(source: string): Promise<{ "id": string; "start": number; "end": number }[]> {
	const bablr = await import("@brianjenkins94/bablr") as { "cstSpansAsync": (source: string, language: string) => Promise<unknown>; "spanAnchors": (source: string, language: string, cst: unknown) => { "id": string; "type": string | null; "start": number; "end": number }[] };
	const cst = await bablr.cstSpansAsync(source, "Program");

	return bablr.spanAnchors(source, "Program", cst).filter((span) => span.type !== null).map(({ id, start, end }) => ({ "id": id, "start": start, "end": end }));
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
const projectFlag = { "format": String, "default": ".", "doc": "The project — the folder of its package.json (default: the current one); in a monorepo, the package's own." } as const;

/** The project a directory is in: the nearest folder up from it with a package.json (its own install, and its .silo/). */
function projectOf(directory: string): string {
	let at = path.resolve(directory);

	while (!fs.existsSync(path.join(at, "package.json"))) {
		const up = path.dirname(at);

		if (up === at) {
			throw new Error(`no package.json at or above ${path.resolve(directory)}`);
		}

		at = up;
	}

	return at;
}

/** How a project installs: by its lockfile — npm's first (a project installed with npm here and pnpm in CI has both),
 *  then pnpm's, then yarn's; npm with none. */
function packageManagerOf(root: string): "npm" | "pnpm" | "yarn" {
	if (fs.existsSync(path.join(root, "package-lock.json"))) {
		return "npm";
	}

	if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
		return "pnpm";
	}

	return fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
}

/**
 * `manager`'s install of `packages` (none: the project's own) that takes no version published in the last `days` days —
 * so `latest` means the latest a week old, a range the newest in it that's that old, every dependency's too. npm's
 * `--before` (a tag past the date falls back to the latest version at or before it); pnpm's `minimum-release-age`
 * (minutes).
 */
export function installCommand(manager: "npm" | "pnpm", packages: string[], days: number, now = Date.now()): string[] {
	if (manager === "pnpm") {
		return [packages.length === 0 ? "install" : "add", ...packages, `--config.minimum-release-age=${Math.round(days * 24 * 60)}`];
	}

	return ["install", ...packages, `--before=${new Date(now - days * 24 * 60 * 60 * 1000).toISOString()}`];
}

/** What `entry`'s version grew: the capabilities it can do that the one before it couldn't. */
function grewIn(entry: { "version"?: string; "grew"?: Record<string, string> }): string[] {
	return Object.entries(entry.grew ?? {}).filter(([, version]) => version === (entry.version ?? "")).map(([capability]) => capability);
}

const jsonFlag = { "format": Boolean, "default": false, "doc": "Print the data as JSON instead of a document." } as const;

export const app = subcommands({
	"name": "silo",
	"description": "What a program's code says about it — derived, never kept by hand.",
	"commands": [
		command({
			"name": "init",
			"description": "Start keeping .silo/ in a repository: its .gitignore and .gitattributes, and the baseline — what the code imports and what each installed package can do — as it is now; once it's there, synced with what's installed (a library added is taken as it is; what a new version can do more is recorded with the version that grew it, and asks at the call unless the policy allows it).",
			"config": juvy({ "repo": repoArgument }),
			"handler": async (config) => {
				const paths = siloPaths(repoOf(config.get("repo")));

				await ensureSiloDir(paths);

				const { created, baseline, changed } = await ensureBaseline(paths);
				const packages = Object.keys(baseline.packages).length;
				const imports = Object.values(baseline.consumer).reduce((count, workspace) => count + Object.keys(workspace).length, 0);
				const relative = path.relative(process.cwd(), paths.baseline);
				const where = relative.startsWith("..") ? paths.baseline : relative;

				process.stdout.write(created
					? `Made ${where}: ${imports} imports, ${packages} packages. Commit it: a change to what they can do is drift from here.\n`
					: `${where} is there (${imports} imports, ${packages} packages) — synced with what's installed: ${changed.added.length} added, ${changed.updated.length} updated, ${changed.grew.length} grew.\n`);
			}
		}),
		command({
			"name": "install",
			"description": "Install with the project's package manager, taking nothing published in the last week (--min-age days) — so `latest` means the latest a week old — then sync the baseline with what's installed: a library added is taken as it is; what a new version can do more is recorded with the version that grew it, and said — it asks at the call unless the policy allows it. Exits 1 when the install fails.",
			"config": juvy({
				"packages": { "format": Array, "default": [], "positional": "rest", "doc": "What to add (none: the project's own dependencies), as the package manager takes them: name, name@range, name@tag." },
				"min-age": { "format": Number, "default": 7, "doc": "The youngest a version may be, in days." },
				"project": projectFlag
			}),
			"handler": async (config) => {
				// (the project's own folder — in a monorepo, its package — never the repository's root)
				const repo = projectOf(config.get("project"));
				const manager = packageManagerOf(repo);

				if (manager === "yarn") {
					process.stderr.write("silo install: yarn isn't supported yet — set its npmMinimalAgeGate and run it yourself, then `silo init` to sync the baseline.\n");
					process.exitCode = 1;

					return;
				}

				const args = installCommand(manager, config.get("packages") as string[], config.get("min-age"));

				process.stdout.write(`${manager} ${args.join(" ")}\n`);

				const installed = spawnSync(manager, args, { "cwd": repo, "stdio": "inherit", "shell": process.platform === "win32" });

				if (installed.status !== 0) {
					process.exitCode = installed.status ?? 1;

					return;
				}

				// What was installed, against the baseline.
				const paths = siloPaths(repo);

				await ensureSiloDir(paths);

				const { created, baseline, changed } = await ensureBaseline(paths);
				const relative = path.relative(process.cwd(), paths.baseline);
				const where = relative.startsWith("..") ? paths.baseline : relative;

				if (created) {
					process.stdout.write(`Made ${where}: ${Object.keys(baseline.packages).length} packages, as they are. Commit it.\n`);

					return;
				}

				process.stdout.write(`${where}: ${changed.added.length} added (${changed.added.join(", ") || "none"}), ${changed.updated.length} updated.\n`);

				if (changed.grew.length > 0) {
					process.stderr.write(`Grew — a new version can do more than before (that asks at the call unless your policy allows it):\n${changed.grew.map((name) => `  ${name} ${baseline.packages[name]?.version ?? ""}: can also ${grewIn(baseline.packages[name] ?? { "caps": [] }).join(", ")}`).join("\n")}\n`);
				}
			}
		}),
		command({
			"name": "check",
			"description": "What the runs' packages did that the baseline doesn't account for — a capability a package couldn't do when it was added, or a package it doesn't have. Exits 1 when there's any.",
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
					process.stdout.write("Every package call the runs made is one the baseline accounts for.\n");
				} else {
					for (const each of found) {
						const what = each.kind === "new" ? "isn't in the baseline" : `may not ${each.capability}` + (each.grew === undefined ? "" : ` (grew in ${each.grew})`) + (each.baseline === undefined ? "" : ` (the baseline has ${each.baseline.version ?? "no version"})`);

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
			"description": "What the runs committed in .silo/ ran, commit by commit: what started running, what stopped, and what was reached and never ran — by feature, or by folder where no feature reaches it — and what changed alongside. Exits 1 when something ran that couldn't be parsed (so isn't counted).",
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

				// What ran but isn't counted, because its code couldn't be parsed: said again where it can't be missed, and
				// the command fails.
				const unparsed = span.flatMap((step) => Object.entries(step.unparsed).map(([file, why]) => `${step.snapshot.slice(0, 7)} ${file}: ${why}`));

				if (unparsed.length > 0) {
					process.stderr.write(`silo coverage: ${unparsed.length} file${unparsed.length === 1 ? "" : "s"} ran but couldn't be parsed, so what ran there isn't counted:\n${unparsed.map((line) => "  " + line).join("\n")}\n`);
					process.exitCode = 1;
				}
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
