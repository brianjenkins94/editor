/**
 * silo — the command line. What a program's code says about it, derived and never kept by hand:
 *
 *   silo init [repo]                                   start keeping .silo/: the baseline, synced with what's installed
 *   silo install [package…] [--min-age 7] [--project …] install — nothing newer than a week — and sync the baseline
 *   silo features [repo] [--json]                      every way into the program, found in its code
 *   silo status <entry> <status> [why] [--key …] [--paths …] [--until …]
 *                                                      a decision about a feature, in the ledger (.silo/features.json)
 *   silo check [repo] [--prices] [--json]              the ledger's drift from the code (each with what deleting its
 *                                                        feature would free), the dormant ways in, and what the runs'
 *                                                        packages did beyond the baseline
 *   silo remove <entry> [why] [--key …] [--paths …]    take a feature out: what only it reaches, its manifest entries,
 *                                                        and a tombstone in the ledger — left for review
 *   silo restore <entry>                               bring a removed feature back, from its tombstone
 *   silo history [repo] [--since …] [--until …] [--json] what changed, told from the code's snapshots — not from
 *                                                        commit messages, which are never read
 *
 * The code is read by TypeScript — the one silo bundles (7.1), whatever the project has: its ways in, its declaration
 * graph, its import surface.
 *
 * The logic is @brianjenkins94/util/silo (features, history, git-snapshots): pure, so the editor runs the same code in
 * the browser over its own workspace. This file is only the desktop's way to ask: git, the disk, and stdout.
 */
import type { CoverageStep } from "@brianjenkins94/util/silo/coverage";
import type { Price } from "@brianjenkins94/util/silo/cost";
import type { Analyzer, DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { Drift, Ledger, LedgerStatus, WayCode } from "@brianjenkins94/util/silo/ledger";
import type { Step } from "@brianjenkins94/util/silo/history";
import type { GroupingScore } from "@brianjenkins94/util/silo/manifest";
import type { Rolldown } from "@brianjenkins94/util/silo/slice";
import type { TypeScriptModules } from "@brianjenkins94/util/silo/typescript";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { ensureBaseline, ensureSiloDir, loadBaseline, siloPaths } from "@brianjenkins94/util/silo/audit";
import { priceOf, priceText } from "@brianjenkins94/util/silo/cost";
import { coverageMarkdown, coverageReplay } from "@brianjenkins94/util/silo/coverage";
import { byFile, byFolder, byReach, byTests, testsFromRecords } from "@brianjenkins94/util/silo/derive";
import { beyondBaseline } from "@brianjenkins94/util/silo/evidence";
import { featuresOf } from "@brianjenkins94/util/silo/features";
import { gitObjects, gitSnapshots } from "@brianjenkins94/util/silo/git-snapshots";
import { featuresMarkdown, historyMarkdown, includeByDefault, replay } from "@brianjenkins94/util/silo/history";
import { ledgerPath, manifestPath } from "@brianjenkins94/util/silo/layout";
import { CI_RECORDS, dormantWays, drift, ledgerText, parseLedger, reachedFromRecords, removalOf, removalText, STATUSES, withStatus } from "@brianjenkins94/util/silo/ledger";
import { manifestDrift, parseManifest, scoreGrouping } from "@brianjenkins94/util/silo/manifest";
import { loadRuns } from "@brianjenkins94/util/silo/runs";
import { typescriptAnalyzer, typescriptModules } from "@brianjenkins94/util/silo/typescript";
import { rolldown } from "rolldown";

/** The repository a path is in. */
function repoOf(directory: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], { "cwd": path.resolve(directory), "encoding": "utf8" }).trim();
}

/** The TypeScript silo bundles (7.1): what reads the code, whatever the project has. */
async function bundledTypeScript(): Promise<TypeScriptModules> {
	const found = await typescriptModules(import.meta.dirname);

	if (found === undefined) {
		throw new Error("silo's own TypeScript (7.1) isn't installed beside it: reinstall silo");
	}

	return found;
}

/** Said when the code's use of a package grew — it reaches more through what it started using (`used`, ensureBaseline's:
 *  `workspace spec`), which asks at the call unless the policy allows it. */
function usedGrew(baseline: { "consumer": Record<string, Record<string, { "grew"?: Record<string, string> }>> }, used: string[]): void {
	if (used.length > 0) {
		process.stderr.write(`Grew — your code's use of a package reaches more than before (that asks at the call unless your policy allows it):\n${used.map((key) => {
			const workspace = key.slice(0, key.lastIndexOf(" "));
			const spec = key.slice(key.lastIndexOf(" ") + 1);
			const grew = Object.entries(baseline.consumer[workspace]?.[spec]?.grew ?? {});

			return `  ${spec}${workspace === "." ? "" : ` (${workspace})`}: can also ${grew.map(([capability, origin]) => `${capability} (${origin})`).join(", ")}`;
		}).join("\n")}\n`);
	}
}

/** TypeScript's analyzer of `repo`, with the TypeScript silo bundles. */
async function analyzerOf(repo: string): Promise<Analyzer> {
	const analyzer = await typescriptAnalyzer({ "root": repo, "typescript": await bundledTypeScript() });

	if (analyzer === undefined) {
		throw new Error("TypeScript couldn't read " + repo);
	}

	return analyzer;
}

/** The program now: its tracked files as they are on disk — its features, and its declaration graph. */
export async function currentProgram(repo: string): Promise<{ "features": ReturnType<typeof featuresOf>; "graph": DeclarationGraph }> {
	const files = execFileSync("git", ["ls-files"], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).split("\n").filter((file) => file !== "" && includeByDefault(file) && fs.existsSync(path.join(repo, file)));
	const analyzer = await analyzerOf(repo);

	try {
		// (each file by its path: read from disk, as it is now — deleted on disk but not yet in git, it's left out above)
		const { ways, graph } = await analyzer.analyze(new Map(files.map((file) => [file, file])), async (file) => fs.readFileSync(path.join(repo, file)));

		return { "features": featuresOf([...ways].map(([file, found]) => ({ "file": file, "ways": found }))), "graph": graph };
	} finally {
		analyzer.close?.();
	}
}

/** The program's features now. */
export async function currentFeatures(repo: string): Promise<ReturnType<typeof featuresOf>> {
	return (await currentProgram(repo)).features;
}

/** What deleting each of the ledger's entries would free (lib util/silo/cost): the code only it reaches, from every way in. */
export function prices(repo: string, ledger: Ledger, program: Awaited<ReturnType<typeof currentProgram>>): Map<string, Price> {
	const roots = [...program.features.values()].flatMap((feature) => feature.roots);
	const textOf = (file: string): string | undefined => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file)) : undefined);

	return new Map(Object.entries(ledger).filter(([, entry]) => entry.status !== "removed").map(([name, entry]) => [name, priceOf(program.graph, roots, { "roots": entry.key === undefined ? [] : program.features.get(entry.key)?.roots ?? [], ...entry.paths === undefined ? {} : { "paths": entry.paths } }, textOf)]));
}

/** The ways in that are dormant (lib util/silo/ledger `dormantWays`), each with its price: none without CI's records. */
function dormantOf(repo: string, ledger: Ledger, program: Awaited<ReturnType<typeof currentProgram>>): { "way": WayCode; "price": Price }[] {
	const records = path.join(repo, CI_RECORDS);
	const reached = reachedFromRecords(fs.existsSync(records) ? fs.readFileSync(records) : undefined);
	const textOf = (file: string): string | undefined => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file)) : undefined);

	return reached === undefined ? [] : dormantWays(program.features, program.graph, ledger, reached, textOf);
}

/** Today plus `days`, as `YYYY-MM-DD`. */
const daysOn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** `repo`'s ledger (.silo/features.json): none, when it has none. */
function ledgerOf(repo: string): Ledger {
	return parseLedger(fs.existsSync(path.join(repo, ledgerPath())) ? fs.readFileSync(path.join(repo, ledgerPath())) : undefined);
}

/** The feature ledger's drift from `repo` as it is (the checks that need no reach: lib util/silo/ledger). */
export async function ledgerDrift(repo: string, today = new Date().toISOString().slice(0, 10), program?: Awaited<ReturnType<typeof currentProgram>>): Promise<Drift[]> {
	const ledger = ledgerOf(repo);
	const files = execFileSync("git", ["ls-files"], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).split("\n").filter((file) => file !== "" && fs.existsSync(path.join(repo, file)));
	const read = (file: string): { "file": string; "text": string } => ({ "file": file, "text": fs.readFileSync(path.join(repo, file)) });
	const ways = [...(program ?? await currentProgram(repo)).features.values()].map((feature) => ({ "key": feature.key, "facet": feature.facet, "id": feature.id, "sides": feature.sides }));

	const exists = (each: string): boolean => fs.existsSync(path.join(repo, each));

	return [...drift(ledger, {
		"today": today,
		"ways": ways,
		"exists": exists,
		"docs": files.filter((file) => file.endsWith(".md")).map(read),
		"code": files.filter((file) => includeByDefault(file) && /\.[cm]?[jt]sx?$/u.test(file)).map(read)
	}), ...manifestDriftOf(repo, ways, exists)];
}

/** The feature manifest's drift from the ways in (lib util/silo/manifest): none without a manifest. Throws for one that
 *  isn't a manifest. */
function manifestDriftOf(repo: string, ways: Parameters<typeof manifestDrift>[1]["ways"], exists: (path: string) => boolean): Drift[] {
	if (!exists(manifestPath())) {
		return [];
	}

	const manifest = parseManifest(fs.readFileSync(path.join(repo, manifestPath())));

	if (manifest === undefined) {
		throw new Error(`${manifestPath()} isn't a manifest: areas of features by name, each with its \`what\``);
	}

	return manifestDrift(manifest, { "ways": ways, "exists": exists });
}

/** Each derivation of features from `repo`'s code (lib util/silo/derive), scored against its manifest — by feature and
 *  by area. Throws without a manifest. */
export async function derivationScores(repo: string): Promise<{ "derivation": string; "features": GroupingScore; "areas": GroupingScore }[]> {
	const manifest = fs.existsSync(path.join(repo, manifestPath())) ? parseManifest(fs.readFileSync(path.join(repo, manifestPath()))) : undefined;

	if (manifest === undefined) {
		throw new Error(`no feature manifest to score against (${manifestPath()}: silo README, *The feature manifest*)`);
	}

	const { features, graph } = await currentProgram(repo);
	const ways = [...features.values()];
	const records = fs.existsSync(path.join(repo, CI_RECORDS)) ? fs.readFileSync(path.join(repo, CI_RECORDS)) : undefined;
	const groupings: [string, Map<string, string>][] = [
		["by file", byFile(ways)],
		["by folder", byFolder(ways)],
		["by reach", byReach(ways, graph)],
		...records === undefined ? [] : [["by tests", byTests(ways, graph, testsFromRecords(records))] as [string, Map<string, string>]]
	];

	return groupings.map(([derivation, grouping]) => ({ "derivation": derivation, "features": scoreGrouping(manifest, grouping), "areas": scoreGrouping(manifest, grouping, { "areas": true }) }));
}

/** The scores, as a table. */
function scoresText(scored: Awaited<ReturnType<typeof derivationScores>>): string {
	const first = scored[0]?.features;
	const row = (each: GroupingScore): string => [`${each.groups}`, `${each.placed}/${each.ways}`, `${each.whole}`, `${each.split}`, `${each.merged}`, `${each.splitAndMerged}`, `${each.partly + each.unseen}`, each.precision.toFixed(2), each.recall.toFixed(2), each.f.toFixed(2)].join(" | ");

	return [
		first === undefined ? "" : `Features from the code alone, against the manifest's ${first.features} features with ways in (and its areas):`,
		"",
		"| Derivation | Groups | Ways in placed | Whole | Split | Merged | Both | Partly or unseen | Precision | Recall | F |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...scored.map((each) => `| ${each.derivation} | ${row(each.features)} |`),
		...scored.map((each) => `| ${each.derivation}, by area | ${row(each.areas)} |`),
		""
	].join("\n");
}

/** The steps of a span of the history (its baseline, the commit before it, comes first and tells nothing). */
export async function historyOf(repo: string, options: { "since"?: string; "until"?: string; "ref"?: string } = {}): Promise<Step[]> {
	const analyzer = await analyzerOf(repo);
	const objects = gitObjects(repo);
	const steps: Step[] = [];

	try {
		for await (const step of replay(gitSnapshots(repo, options), objects.read, { "analyzer": analyzer })) {
			steps.push(step);
		}
	} finally {
		objects.close();
		analyzer.close?.();
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
export async function coverageOf(repo: string, options: { "since"?: string; "until"?: string; "ref"?: string } = {}): Promise<CoverageStep[]> {
	const analyzer = await analyzerOf(repo);
	const objects = gitObjects(repo);
	const steps: CoverageStep[] = [];

	try {
		for await (const step of coverageReplay(gitSnapshots(repo, options), objects.read, { "analyzer": analyzer, "place": placeSpans })) {
			steps.push(step);
		}
	} finally {
		objects.close();
		analyzer.close?.();
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
			"description": "Start keeping .silo/ in a repository: its .gitignore and .gitattributes, and the baseline — what the code imports and what each installed package can do — as it is now; once it's there, synced with what's installed (a library added is taken as it is; what a new version can do more is recorded with the version that grew it, and what the code's use of a package reaches more with the members that brought it in; either asks at the call unless the policy allows it).",
			"config": juvy({ "repo": repoArgument }),
			"handler": async (config) => {
				const paths = siloPaths(repoOf(config.get("repo")));

				await ensureSiloDir(paths);

				const { created, baseline, changed, used } = await ensureBaseline(paths, paths.root, await bundledTypeScript(), rolldown as unknown as Rolldown);
				const packages = Object.keys(baseline.packages).length;
				const imports = Object.values(baseline.consumer).reduce((count, workspace) => count + Object.keys(workspace).length, 0);
				const relative = path.relative(process.cwd(), paths.baseline);
				const where = relative.startsWith("..") ? paths.baseline : relative;

				process.stdout.write(created
					? `Made ${where}: ${imports} imports, ${packages} packages. Commit it: a change to what they can do is drift from here.\n`
					: `${where} is there (${imports} imports, ${packages} packages) — synced with what's installed: ${changed.added.length} added, ${changed.updated.length} updated, ${changed.grew.length} grew.\n`);
				usedGrew(baseline, used);
			}
		}),
		command({
			"name": "install",
			"description": "Install with the project's package manager, taking nothing published in the last week (--min-age days) — so `latest` means the latest a week old — then sync the baseline with what's installed: a library added is taken as it is; what a new version can do more is recorded with the version that grew it, and what the code's use of a package reaches more (its join: the part it uses, tree-shaken) with the members that brought it in — each said, and each asks at the call unless the policy allows it. Exits 1 when the install fails.",
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

				const { created, baseline, changed, used } = await ensureBaseline(paths, paths.root, await bundledTypeScript(), rolldown as unknown as Rolldown);
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

				usedGrew(baseline, used);
			}
		}),
		command({
			"name": "status",
			"description": "Write a decision about a feature into the ledger (.silo/features.json, shared — commit it): its status (active, experiment, parked, stopped, removed) and why, stamped with today when the status changes; what it is by a way in's key (as `silo features` names it) and/or paths; an experiment's end; a removal's commit and how to restore it. `silo check` holds the code to it.",
			"config": juvy({
				"entry": { "format": String, "default": "", "positional": true, "doc": "Its name, as people call it (\"capability engine\")." },
				"status": { "format": String, "default": "", "positional": true, "doc": `One of ${STATUSES.join(", ")}.` },
				"why": { "format": String, "default": "", "positional": true, "doc": "Why: what the decision rests on." },
				"key": { "format": String, "default": "", "doc": "The way in it is, as `silo features` keys it (command|tsval.explore)." },
				"paths": { "format": Array, "default": [], "doc": "Its files or folders, from the repository's root." },
				"until": { "format": String, "default": "", "doc": "An experiment's end, YYYY-MM-DD." },
				"in": { "format": String, "default": "", "doc": "A removal's commit." },
				"restore": { "format": String, "default": "", "doc": "A removal's command that brings it back." },
				"repo": { "format": String, "default": ".", "doc": "A directory in the repository (default: the current one)." }
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const file = path.join(repo, ledgerPath());
				const entry = config.get("entry") as string;
				const why = config.get("why") as string;

				if (entry === "" || why === "") {
					process.stderr.write("silo status: say which entry, its status and why — silo status \"capability engine\" parked \"records move into the run ledger first\"\n");
					process.exitCode = 1;

					return;
				}

				const more = Object.fromEntries((["key", "until", "in", "restore"] as const).flatMap((name) => (config.get(name) === "" ? [] : [[name, config.get(name) as string]])));
				const paths = config.get("paths") as string[];

				try {
					const ledger = withStatus(parseLedger(fs.existsSync(file) ? fs.readFileSync(file) : undefined), entry, config.get("status") as LedgerStatus, why, new Date().toISOString().slice(0, 10), { ...more, ...paths.length === 0 ? {} : { "paths": paths } });

					// (.silo/ as silo keeps it: its .gitignore keeping local/ out of git, its .gitattributes)
					await ensureSiloDir(siloPaths(repo));
					fs.writeFileSync(file, ledgerText(ledger));
					process.stdout.write(`"${entry}" is ${ledger[entry].status} (since ${ledger[entry].since}), in ${path.relative(process.cwd(), file) || file}. Commit it.\n`);
				} catch (error) {
					process.stderr.write(`silo status: ${error instanceof Error ? error.message : String(error)}\n`);
					process.exitCode = 1;
				}
			}
		}),
		command({
			"name": "check",
			"description": "The feature ledger's drift from the code — a stopped feature still there, a removed one still in the docs, an experiment past its end, an entry naming nothing, and dead ends (a command or view declared and never registered, a setting never read) — and the feature manifest's (.silo/manifest.json): a way in no feature owns, one owned that's gone or owned twice, a path that isn't there — each with both ways out; then what the runs' packages did that the baseline doesn't account for — a capability a package couldn't do when it was added, or a package it doesn't have. Exits 1 on either.",
			"config": juvy({ "repo": repoArgument, "json": jsonFlag, "prices": { "format": Boolean, "default": false, "doc": "Every entry's price, too: what deleting its feature would free." } }),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const paths = siloPaths(repo);
				const program = await currentProgram(repo);
				const drifted = await ledgerDrift(repo, undefined, program);
				const priced = prices(repo, ledgerOf(repo), program);
				const priceOfEntry = (entry: string | undefined): Price | undefined => (entry === undefined ? undefined : priced.get(entry));
				// (suggestions, not errors: a lease run out asks for a decision)
				const asleep = dormantOf(repo, ledgerOf(repo), program);
				const found = fs.existsSync(paths.baseline) ? beyondBaseline(loadRuns(paths), loadBaseline(paths).packages) : undefined;

				// (errors since 2026-10-25: every check was quiet here — silo README, *The feature ledger*)
				if (drifted.length > 0) {
					process.exitCode = 1;
				}

				if (config.get("json")) {
					process.stdout.write(JSON.stringify({ "drift": drifted.map((each) => ({ ...each, ...priceOfEntry(each.entry) === undefined ? {} : { "price": priceOfEntry(each.entry) } })), "dormant": asleep.map(({ way, price }) => ({ "key": way.key, "facet": way.facet, "id": way.id, "price": price })), ...config.get("prices") ? { "prices": Object.fromEntries(priced) } : {}, "beyondBaseline": found ?? null }, undefined, "\t") + "\n");
					process.exitCode = (found?.length ?? 0) > 0 || drifted.length > 0 ? 1 : 0;

					return;
				}

				if (drifted.length === 0) {
					process.stdout.write("The ledger, the manifest and the code agree.\n");
				} else {
					process.stdout.write(`Drift (${drifted.length}):\n${drifted.map((each) => `  ${each.check}: ${each.message}\n    change the code: ${each.code}; or the decision: ${each.decision}` + (priceOfEntry(each.entry) === undefined ? "" : `\n    deleting it ${priceText(priceOfEntry(each.entry) as Price)}`)).join("\n")}\n`);
				}

				if (asleep.length > 0) {
					process.stdout.write(`Dormant (${asleep.length}) — the runs loaded their files and never ran their code; each, keep it a while or remove it:\n${asleep.map(({ way, price }) => `  ${way.facet} ${way.id}: deleting it ${priceText(price)}\n    keep: silo status "${way.id}" active "<why>" --key "${way.key}" --until ${daysOn(90)}; remove: silo remove "${way.id}" "<why>" --key "${way.key}"`).join("\n")}\n`);
				}

				if (config.get("prices")) {
					process.stdout.write(priced.size === 0 ? "No entries to price.\n" : `What deleting each would free:\n${[...priced].map(([entry, price]) => `  ${entry}: ${priceText(price)}` + (price.files.length === 0 ? "" : ` (${price.files.join(", ")})`)).join("\n")}\n`);
				}

				if (found === undefined) {
					process.stdout.write("No baseline yet, so no package calls to check: `silo init` makes one.\n");

					return;
				}

				if (found.length === 0) {
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
			"name": "remove",
			"description": "Take a feature out (silo README, *The feature ledger*): the files only it reaches, its manifest entries (a command with its menus and keybindings, a view, a setting), and a tombstone in the ledger saying why and how to restore it — and the docs that still name it, and any of its code that shares a file with something else, to see to by hand. Nothing is committed: the change is left for review.",
			"config": juvy({
				"entry": { "format": String, "default": "", "positional": true, "doc": "Its name: the ledger's, or a dormant way in's id." },
				"why": { "format": String, "default": "", "positional": true, "doc": "Why it goes." },
				"key": { "format": String, "default": "", "doc": "The way in it is (default: its ledger entry's)." },
				"paths": { "format": Array, "default": [], "doc": "Its files or folders (default: its ledger entry's)." },
				"repo": { "format": String, "default": ".", "doc": "A directory in the repository (default: the current one)." }
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const name = config.get("entry") as string;
				const ledger = ledgerOf(repo);
				const entry = ledger[name];
				const key = (config.get("key") as string) || entry?.key;
				const given = config.get("paths") as string[];
				const paths = given.length > 0 ? given : entry?.paths ?? [];

				if (name === "" || (key === undefined && paths.length === 0)) {
					process.stderr.write("silo remove: say which feature — its ledger entry, or a way in's --key (as `silo check` lists the dormant ones), or --paths\n");
					process.exitCode = 1;

					return;
				}

				const program = await currentProgram(repo);
				const textOf = (file: string): string | undefined => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file)) : undefined);
				const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { "cwd": repo, "encoding": "utf8" }).trim();
				const tracked = execFileSync("git", ["ls-files"], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).split("\n").filter((file) => file !== "" && fs.existsSync(path.join(repo, file)));
				const removal = removalOf({ "name": name, "why": config.get("why") as string, ...key === undefined ? {} : { "key": key }, "paths": paths, "ledger": ledger, "features": program.features, "graph": program.graph, "tracked": tracked, "textOf": textOf, "head": head, "today": new Date().toISOString().slice(0, 10) });

				// (nothing it can take out on its own — its code shares files, its way in has no manifest entry: no tombstone for
				// what's still there; what to do is said)
				if (removal.nothing) {
					process.stdout.write(removalText(name, removal) + "\n");
					process.exitCode = 2;

					return;
				}

				for (const file of removal.files) {
					await fs.rm(path.join(repo, file));
				}

				for (const { file, text } of removal.manifests) {
					fs.writeFileSync(path.join(repo, file), text);
				}

				await ensureSiloDir(siloPaths(repo));
				fs.writeFileSync(path.join(repo, ledgerPath()), removal.ledger);
				process.stdout.write(removalText(name, removal) + "\n");
			}
		}),
		command({
			"name": "restore",
			"description": "Bring a removed feature back: run its tombstone — the files as they were (`git checkout <commit> -- <files>`) — and set it active again. Its manifest entries, taken out beside it, are said where to find.",
			"config": juvy({
				"entry": { "format": String, "default": "", "positional": true, "doc": "Its name, as the ledger has it." },
				"repo": { "format": String, "default": ".", "doc": "A directory in the repository (default: the current one)." }
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const name = config.get("entry") as string;
				const ledger = ledgerOf(repo);
				const entry = ledger[name];

				if (entry?.status !== "removed") {
					process.stderr.write(`silo restore: "${name}" isn't removed in the ledger\n`);
					process.exitCode = 1;

					return;
				}

				// (only a checkout: a tombstone is the repository's text, and silo runs nothing else out of it)
				const restore = entry.restore ?? (entry.in === undefined || (entry.paths ?? []).length === 0 ? undefined : `git checkout ${entry.in}^ -- ${(entry.paths ?? []).join(" ")}`);
				const checkout = /^git checkout ([\w.^~/-]+) -- (\S+(?: \S+)*)$/u.exec(restore ?? "");

				if (checkout === null) {
					process.stderr.write(`silo restore: "${name}"'s tombstone says ${restore === undefined ? "nothing to run" : `\`${restore}\``} — restore it by hand\n`);
					process.exitCode = 1;

					return;
				}

				execFileSync("git", ["checkout", checkout[1], "--", ...checkout[2].split(" ")], { "cwd": repo, "stdio": "inherit" });

				const { restore: _restore, in: _in, ...rest } = entry;

				fs.writeFileSync(path.join(repo, ledgerPath()), ledgerText(withStatus({ ...ledger, [name]: rest }, name, "active", `restored: ${entry.why}`, new Date().toISOString().slice(0, 10))));
				process.stdout.write(`Restored "${name}" from ${checkout[1]}: ${checkout[2]}. It's active again.${entry.key === undefined ? "" : ` Its manifest entries (${entry.key}) came out beside it: \`git show ${checkout[1]}:<manifest>\` has them.`}\n`);
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
				"json": jsonFlag
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const since = config.get("since");
				const until = config.get("until");
				const steps = await coverageOf(repo, { "ref": config.get("ref"), ...since === "" ? {} : { "since": since }, ...until === "" ? {} : { "until": until } });
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
			"description": "Every way into the program — commands, views, settings, buttons, agent tools, hub requests… — found in its code. With --score, what they add up to instead: the ways in grouped from the code alone (by file and by folder, the baselines; by reach; by CI's tests), each grouping scored against the feature manifest (.silo/manifest.json): how many of its features each finds whole, splits or merges, and its precision and recall.",
			"config": juvy({ "repo": repoArgument, "json": jsonFlag, "score": { "format": Boolean, "default": false, "doc": "Score each derivation of features from the code against the feature manifest (silo README, *The feature manifest*)." } }),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));

				if (config.get("score")) {
					const scored = await derivationScores(repo);

					process.stdout.write(config.get("json") ? JSON.stringify(scored, undefined, "\t") + "\n" : scoresText(scored));

					return;
				}

				const features = [...(await currentFeatures(repo)).values()];

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
				"json": jsonFlag
			}),
			"handler": async (config) => {
				const repo = repoOf(config.get("repo"));
				const since = config.get("since"), until = config.get("until");
				const steps = await historyOf(repo, { "ref": config.get("ref"), ...since === "" ? {} : { "since": since }, ...until === "" ? {} : { "until": until } });
				const span = since === "" ? steps : steps.slice(1); // the baseline only gives the first commit something to compare with

				process.stdout.write(config.get("json") ? JSON.stringify(span, undefined, "\t") + "\n" : historyMarkdown(span, { "title": "History of " + path.basename(repo) }));
			}
		})
	]
});

if (isEntry(import.meta)) {
	await run(app);
}
