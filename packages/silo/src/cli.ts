/**
 * silo — the command line: what a file can't do (README, *The files are the interface*). Everything else silo knows is
 * in .silo/'s files, which any program can read.
 *
 *   silo install [package…] [--min-age 7] [--project …] install — nothing newer than a week but what's pinned exactly —
 *                                                        then start or sync .silo/'s baseline
 *   silo status <entry> <status> [why] [--key …] [--paths …] [--until …]
 *                                                      a decision about a feature, in the ledger (.silo/features.json)
 *   silo check [repo] [--prices] [--json]              the ledger's drift from the code (each with what deleting its
 *                                                        feature would free), and what the runs' packages did
 *                                                        beyond the baseline
 *   silo test --files <globs> --run <runner> [--base …] [--full] [--audit …] [--dry] [--json]
 *                                                      CI's: the tests a change needs, run: what it reaches, less what's
 *                                                        vouched for or resting, more what failed lately in CI (decision 20)
 *
 * The code is read by TypeScript — the one silo bundles (7.1), whatever the project has: its ways in, its declaration
 * graph, its import surface. Its native compiler, or where nothing can be spawned (the editor's debugger, where this
 * runs as `node packages/silo/src/cli.ts`) the same compiler's WebAssembly build; and git the same way (./git).
 *
 * The logic is @brianjenkins94/util/silo: pure, so the editor runs the same code in the browser over its own workspace.
 * This file is only the command line's way to ask: git, the disk, and stdout.
 */
import type { Price } from "@brianjenkins94/util/silo/cost";
import type { Analyzer, DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { Drift, Ledger, LedgerStatus } from "@brianjenkins94/util/silo/ledger";
import type { Rolldown } from "@brianjenkins94/util/silo/slice";
import type { TypeScriptModules } from "@brianjenkins94/util/silo/typescript";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { ensureBaseline, ensureSiloDir, loadBaseline, siloPaths } from "@brianjenkins94/util/silo/audit";
import { priceOf, priceText } from "@brianjenkins94/util/silo/cost";
import { installCommand, packageManagerOf, pinOfRequest, workspacePins } from "@brianjenkins94/util/silo/install";
import { beyondBaseline } from "@brianjenkins94/util/silo/evidence";
import { featuresOf } from "@brianjenkins94/util/silo/features";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { lastRunReachPath, ledgerPath } from "@brianjenkins94/util/silo/layout";
import { declaredDrift, declaredFeatures, drift, isOwnedCode, ledgerText, ownedByOthers, parseLedger, STATUSES, withStatus } from "@brianjenkins94/util/silo/ledger";
import { loadRuns } from "@brianjenkins94/util/silo/runs";
import { typescriptAnalyzer, typescriptModules } from "@brianjenkins94/util/silo/typescript";
import { filesOf, repoOf } from "./git.ts";
import { ranByFile } from "@brianjenkins94/util/silo/observed";

/** rolldown, for the baseline's slices (`install`, which makes one): loaded when one's asked for, not as the CLI
 *  starts — its native binding doesn't load where there's no native code (the editor's debugger), and nothing else needs it. */
async function rolldownForSlices(): Promise<Rolldown> {
	return (await import("rolldown")).rolldown as unknown as Rolldown;
}

/** The TypeScript silo bundles (7.1): what reads the code, whatever the project has. Its own name, `typescript-7` (an
 *  npm alias): a workspace whose root has another TypeScript keeps its own, and silo's is still found beside it (the
 *  editor installs one version of a name). */
async function bundledTypeScript(): Promise<TypeScriptModules> {
	const found = await typescriptModules(import.meta.dirname, "typescript-7");

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

/** The files `globs` (comma-separated, from `cwd`) match, by their paths from `repo`'s top, each once, in order. */
async function globbed(globs: string, cwd: string, repo: string): Promise<string[]> {
	const files: string[] = [];

	for (const glob of globs.split(",").filter((each) => each !== "")) {
		for await (const file of fs.glob(glob, { "cwd": cwd })) {
			files.push(file);
		}
	}

	return [...new Set(files.map((file) => path.relative(repo, path.resolve(cwd, file)).split(path.sep).join("/")))].sort();
}

/** TypeScript's analyzer of `repo`, with the TypeScript silo bundles. */
async function analyzerOf(repo: string): Promise<Analyzer> {
	const analyzer = await typescriptAnalyzer({ "root": repo, "typescript": await bundledTypeScript() });

	if (analyzer === undefined) {
		throw new Error("TypeScript couldn't read " + repo);
	}

	return analyzer;
}

/** The program now: its files as they are on disk (but for what git ignores) — its features, and its declaration graph. */
export async function currentProgram(repo: string): Promise<{ "features": ReturnType<typeof featuresOf>; "graph": DeclarationGraph }> {
	// (and the files not yet committed, but for those git ignores: as the ledger's drift reads them)
	const files = (await filesOf(repo, { "untracked": true })).filter((file) => includeByDefault(file) && fs.existsSync(path.join(repo, file)));
	const analyzer = await analyzerOf(repo);

	try {
		// (each file by its path: read from disk, as it is now — deleted on disk but not yet in git, it's left out above)
		const { ways, graph } = await analyzer.analyze(new Map(files.map((file) => [file, file])), async (file) => fs.readFileSync(path.join(repo, file)));

		return { "features": featuresOf([...ways].map(([file, found]) => ({ "file": file, "ways": found }))), "graph": graph };
	} finally {
		analyzer.close?.();
	}
}

/** What deleting each of the ledger's entries would free (lib util/silo/cost): the code only it reaches, from every
 *  way in and from what the other features own. */
export function prices(repo: string, ledger: Ledger, program: Awaited<ReturnType<typeof currentProgram>>): Map<string, Price> {
	const roots = [...program.features.values()].flatMap((feature) => feature.roots);
	const textOf = (file: string): string | undefined => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file)) : undefined);

	return new Map(Object.entries(ledger).filter(([, entry]) => entry.status !== "removed").map(([name, entry]) => [name, priceOf(program.graph, roots, { "roots": entry.key === undefined ? [] : program.features.get(entry.key)?.roots ?? [], ...entry.paths === undefined ? {} : { "paths": entry.paths } }, textOf, ownedByOthers(ledger, name, entry.key))]));
}

/** `repo`'s ledger (.silo/features.json): none, when it has none. */
function ledgerOf(repo: string): Ledger {
	return parseLedger(fs.existsSync(path.join(repo, ledgerPath())) ? fs.readFileSync(path.join(repo, ledgerPath())) : undefined);
}

/** A finding of `silo check`: lib's, or a declared feature's with no tests (`untested`). */
export type Finding = Omit<Drift, "check"> & { "check": Drift["check"] | "no tests" };

/** The active declared features that name no tests, and whose `why` doesn't say why there are none (`no tests: …`): one
 *  can stop working with nothing to notice, its entry active all along (as Run's debugger did for three weeks). */
export function untested(ledger: Ledger): Finding[] {
	return declaredFeatures(ledger).filter(([name, { tests = [] }]) => ledger[name].status === "active" && tests.length === 0 && !/\bno tests: \S/u.test(ledger[name].why)).map(([name]) => ({ "check": "no tests", "entry": name, "message": `"${name}" names no tests, so nothing notices when it stops working`, "code": `test it, and name the test (\`silo status "${name}" --tests <path> --add\`)`, "decision": "say in its why that it has none, and why (`no tests: …`)" }));
}

/** The feature ledger's drift from `repo` as it is (the checks that need no reach: lib util/silo/ledger). */
export async function ledgerDrift(repo: string, today = new Date().toISOString().slice(0, 10), program?: Awaited<ReturnType<typeof currentProgram>>): Promise<Finding[]> {
	const ledger = ledgerOf(repo);
	// (and the files not yet committed, but for those git ignores: a new file is held to an owner before it's committed)
	const files = (await filesOf(repo, { "untracked": true })).filter((file) => fs.existsSync(path.join(repo, file)));
	const read = (file: string): { "file": string; "text": string } => ({ "file": file, "text": fs.readFileSync(path.join(repo, file)) });
	const ways = [...(program ?? await currentProgram(repo)).features.values()].map((feature) => ({ "key": feature.key, "facet": feature.facet, "id": feature.id, "sides": feature.sides }));

	const exists = (each: string): boolean => fs.existsSync(path.join(repo, each));
	const code = files.filter((file) => includeByDefault(file) && /\.[cm]?[jt]sx?$/u.test(file));

	return [...drift(ledger, {
		"today": today,
		"ways": ways,
		"exists": exists,
		"docs": files.filter((file) => file.endsWith(".md")).map(read),
		"code": code.map(read),
		// (every code file a feature's, tests and vendored code among them: decision 22; a repository declaring none isn't held)
		// (and a file several own held to what the last run's reach shows of it: real coverage, nothing else)
		...declaredFeatures(ledger).length === 0 ? {} : { "owned": { "files": files.filter(isOwnedCode), "ran": ranByFile(fs.existsSync(path.join(repo, lastRunReachPath())) ? fs.readFileSync(path.join(repo, lastRunReachPath())) : undefined) } }
	}), ...declaredDrift(ledger, { "ways": ways, "exists": exists }), ...untested(ledger)];
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

/**
 * `manager`'s install of `packages` (none: the project's own) in the project at `root`, by util/silo/install's rule:
 * nothing published in the last `days` days — `latest` the latest a week old, a range the newest in it that's that old,
 * every dependency's too — but each version pinned exactly (in any of the workspace's package.json files, or asked
 * for as `name@1.2.3`) however young. The setup action CI installs with runs the same rule.
 */
export function installArgs(manager: "npm" | "pnpm", root: string, packages: string[], days: number, now = Date.now()): string[] {
	const asked = packages.map(pinOfRequest).filter((pin) => pin !== undefined);

	return installCommand(manager, packages, days * 24 * 60, [...workspacePins(root), ...asked], now);
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
			"name": "install",
			"description": "Install with the project's package manager, taking nothing published in the last week (--min-age days) — so `latest` means the latest a week old — but a version pinned exactly (`\"1.2.3\"` in a package.json of the workspace, or `name@1.2.3` here) however young, then sync the baseline with what's installed — the first time, start keeping .silo/ (its .gitignore and .gitattributes) and make it: a library added is taken as it is; what a new version can do more is recorded with the version that grew it, and what the code's use of a package reaches more (its join: the part it uses, tree-shaken) with the members that brought it in — each said, and each asks at the call unless the policy allows it. Exits 1 when the install fails. With yarn, not supported yet, it only syncs the baseline.",
			"config": juvy({
				"packages": { "format": Array, "default": [], "positional": "rest", "doc": "What to add (none: the project's own dependencies), as the package manager takes them: name, name@range, name@tag." },
				"min-age": { "format": Number, "default": 7, "doc": "The youngest a version may be, in days." },
				"project": projectFlag
			}),
			"handler": async (config) => {
				// (the project's own folder — in a monorepo, its package — never the repository's root)
				const repo = projectOf(config.get("project"));
				const manager = packageManagerOf(repo);

				// (yarn: installed with it, its npmMinimalAgeGate holding the week; what's installed is synced all the same)
				if (manager === "yarn") {
					process.stderr.write("silo install: yarn isn't supported yet — install with it (its npmMinimalAgeGate holds the week); the baseline is synced with what's installed.\n");
					process.exitCode = (config.get("packages") as string[]).length > 0 ? 1 : 0;
				} else {
					const args = installArgs(manager, repo, config.get("packages") as string[], config.get("min-age"));

					process.stdout.write(`${manager} ${args.join(" ")}\n`);

					const installed = spawnSync(manager, args, { "cwd": repo, "stdio": "inherit", "shell": process.platform === "win32" });

					if (installed.status !== 0) {
						process.exitCode = installed.status ?? 1;

						return;
					}
				}

				// What was installed, against the baseline (made, and .silo/ started, the first time).
				const paths = siloPaths(repo);

				await ensureSiloDir(paths);

				const { created, baseline, changed, used } = await ensureBaseline(paths, paths.root, await bundledTypeScript(), await rolldownForSlices());
				const relative = path.relative(process.cwd(), paths.baseline);
				const where = relative.startsWith("..") ? paths.baseline : relative;

				if (created) {
					process.stdout.write(`Made ${where}: ${Object.values(baseline.consumer).reduce((count, workspace) => count + Object.keys(workspace).length, 0)} imports, ${Object.keys(baseline.packages).length} packages, as they are. Commit it: a change to what they can do is drift from here.\n`);

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
			"description": "Write a decision about a feature into the ledger (.silo/features.json, shared — commit it): its status (active, experiment, parked, stopped, removed) and why, stamped with today when the status changes; what it is by a way in's key (as `silo check` names one no feature owns) and/or paths; what it's for and where it's written up; the ways in, code and tests it owns (each list in place of its own, or with --add, added to it — a new command into the ways of the feature it serves); an experiment's end; a removal's commit and how to restore it. An entry there keeps its status and why when they're left out. `silo check` holds the code to it.",
			"config": juvy({
				"entry": { "format": String, "default": "", "positional": true, "doc": "Its name, as people call it (\"capability engine\")." },
				"status": { "format": String, "default": "", "positional": true, "doc": `One of ${STATUSES.join(", ")}.` },
				"why": { "format": String, "default": "", "positional": true, "doc": "Why: what the decision rests on." },
				"key": { "format": String, "default": "", "doc": "The way in it is, by its key, as `silo check` names one (command|tsval.explore)." },
				"paths": { "format": Array, "default": [], "doc": "Its files or folders, from the repository's root." },
				"ways": { "format": Array, "default": [], "doc": "The ways in it owns, by their keys, as `silo check` names them (agent tool|git_fetch)." },
				"tests": { "format": Array, "default": [], "doc": "Its tests' files or folders, from the repository's root." },
				"add": { "format": Boolean, "default": false, "doc": "Add --paths, --ways and --tests to the entry's own, rather than replace them." },
				"what": { "format": String, "default": "", "doc": "What it's for, in a sentence." },
				"docs": { "format": String, "default": "", "doc": "Where it's written up (a file, and its heading)." },
				"until": { "format": String, "default": "", "doc": "An experiment's end, YYYY-MM-DD." },
				"in": { "format": String, "default": "", "doc": "A removal's commit." },
				"restore": { "format": String, "default": "", "doc": "A removal's command that brings it back." },
				"repo": { "format": String, "default": ".", "doc": "A directory in the repository (default: the current one)." }
			}),
			"handler": async (config) => {
				const repo = await repoOf(config.get("repo"));
				const file = path.join(repo, ledgerPath());
				const entry = config.get("entry") as string;
				const before = parseLedger(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
				// (an entry there keeps its status and why: a way in declared needn't restate them)
				const status = (config.get("status") as string) || before[entry]?.status;
				const why = (config.get("why") as string) || before[entry]?.why;

				if (entry === "" || status === undefined || why === undefined || why === "") {
					process.stderr.write("silo status: say which entry, its status and why — silo status \"capability engine\" parked \"records move into the run ledger first\"\n");
					process.exitCode = 1;

					return;
				}

				const more = Object.fromEntries((["key", "until", "in", "restore", "what", "docs"] as const).flatMap((name) => (config.get(name) === "" ? [] : [[name, config.get(name) as string]])));
				// (each list given, in place of the entry's own — or, with --add, added after it, once each: the ledger's order kept)
				const lists = Object.fromEntries((["paths", "ways", "tests"] as const).flatMap((name) => {
					const given = config.get(name) as string[];

					return given.length === 0 ? [] : [[name, config.get("add") === true ? [...new Set([...before[entry]?.[name] ?? [], ...given])] : given]];
				}));

				try {
					const ledger = withStatus(before, entry, status as LedgerStatus, why, new Date().toISOString().slice(0, 10), { ...more, ...lists });

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
			"description": "The feature ledger's drift from the code — a stopped feature still there, a removed one still in the docs, an experiment past its end, an entry naming nothing, a code file no feature owns or two do, and dead ends (a command or view declared and never registered, a setting never read) — and the declared features': a way in or a code file no feature owns, one owned that's gone or owned twice, a path that isn't there, an active one that names no tests and doesn't say why — each with both ways out; then what the runs' packages did that the baseline doesn't account for — a capability a package couldn't do when it was added, or a package it doesn't have. Exits 1 on either.",
			"config": juvy({ "repo": repoArgument, "json": jsonFlag, "prices": { "format": Boolean, "default": false, "doc": "Every entry's price, too: what deleting its feature would free." } }),
			"handler": async (config) => {
				const repo = await repoOf(config.get("repo"));
				const paths = siloPaths(repo);
				const program = await currentProgram(repo);
				const drifted = await ledgerDrift(repo, undefined, program);
				const priced = prices(repo, ledgerOf(repo), program);
				const priceOfEntry = (entry: string | undefined): Price | undefined => (entry === undefined ? undefined : priced.get(entry));
				const found = fs.existsSync(paths.baseline) ? beyondBaseline(loadRuns(paths), loadBaseline(paths).packages) : undefined;

				// (errors since 2026-10-25: every check was quiet here — silo README, *The feature ledger*)
				if (drifted.length > 0) {
					process.exitCode = 1;
				}

				if (config.get("json")) {
					process.stdout.write(JSON.stringify({ "drift": drifted.map((each) => ({ ...each, ...priceOfEntry(each.entry) === undefined ? {} : { "price": priceOfEntry(each.entry) } })), ...config.get("prices") ? { "prices": Object.fromEntries(priced) } : {}, "beyondBaseline": found ?? null }, undefined, "\t") + "\n");
					process.exitCode = (found?.length ?? 0) > 0 || drifted.length > 0 ? 1 : 0;

					return;
				}

				if (drifted.length === 0) {
					process.stdout.write("The ledger and the code agree.\n");
				} else {
					process.stdout.write(`Drift (${drifted.length}):\n${drifted.map((each) => `  ${each.check}: ${each.message}\n    change the code: ${each.code}; or the decision: ${each.decision}` + (priceOfEntry(each.entry) === undefined ? "" : `\n    deleting it ${priceText(priceOfEntry(each.entry) as Price)}`)).join("\n")}\n`);
				}

				if (config.get("prices")) {
					process.stdout.write(priced.size === 0 ? "No entries to price.\n" : `What deleting each would free:\n${[...priced].map(([entry, price]) => `  ${entry}: ${priceText(price)}` + (price.files.length === 0 ? "" : ` (${price.files.join(", ")})`)).join("\n")}\n`);
				}

				if (found === undefined) {
					process.stdout.write("No baseline yet, so no package calls to check: `silo install` makes one.\n");

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
			"name": "test",
			"description": "The tests a change needs, run: what the change reaches by declaration, less what's vouched for (`.silo/vouches/`) or resting, more what failed or flaked lately in this CI's own runs — then the runner on the files selected, with silo's node:test reporter beside its own, so the next run reads back how each test did from this one's log. What a CI step calls (decision 20); a base it can't read, or --full, runs everything.",
			"config": juvy({
				"files": { "format": String, "default": "", "doc": "The test files the runner would run: globs, from the working folder, comma-separated." },
				"run": { "format": String, "default": "", "doc": "The runner's command, its arguments split on spaces (`node --import tsx --test`): the files selected and silo's reporter are added." },
				"base": { "format": String, "default": "", "doc": "The commit the change is from (a push's `before`). None: everything runs." },
				"runtime": { "format": String, "default": "node", "doc": "What the runner runs tests on: a vouch made on another counts only for a test the two have agreed on (decision 19)." },
				"full": { "format": Boolean, "default": false, "doc": "Run everything (the scheduled full run)." },
				"audit": { "format": Number, "default": 0, "doc": "The share of vouched tests run anyway, at random (decision 17)." },
				"workflow": { "format": String, "default": "", "doc": "The CI workflow whose runs say how each test has done, by its file's name (`ci.yml`). None: the one running this step (GITHUB_WORKFLOW_REF)." },
				"dry": { "format": Boolean, "default": false, "doc": "Say what would run, and run nothing." },
				"json": jsonFlag
			}),
			"handler": async (config) => {
				const { runSelected, selectFor } = await import("./test.ts");
				const cwd = process.cwd();
				const repo = await repoOf(cwd);
				const candidates = await globbed(config.get("files"), cwd, repo);
				const repository = process.env["GITHUB_REPOSITORY"];
				const analyzer = await analyzerOf(repo);
				let selected;

				try {
					selected = await selectFor({
						"repo": repo,
						"candidates": candidates,
						"analyzer": analyzer,
						// (a CI's base, as its step's environment says it: SILO_BASE)
						...(config.get("base") || process.env["SILO_BASE"] || "") === "" ? {} : { "base": config.get("base") || process.env["SILO_BASE"]! },
						"runtime": config.get("runtime"),
						"full": config.get("full") || process.env["SILO_FULL"] === "true",
						"audit": config.get("audit"),
						"say": (text) => process.stderr.write(text + "\n"),
						...repository === undefined ? {} : { "ci": { "repository": repository, "workflow": config.get("workflow") || path.basename((process.env["GITHUB_WORKFLOW_REF"] ?? "ci.yml").split("@")[0]!), ...process.env["GITHUB_TOKEN"] === undefined ? {} : { "token": process.env["GITHUB_TOKEN"] } } }
					});
				} finally {
					analyzer.close?.();
				}

				if (config.get("json")) {
					process.stdout.write(JSON.stringify(selected, undefined, "\t") + "\n");

					return;
				}

				if (config.get("dry") || config.get("run") === "") {
					const { selectionText } = await import("@brianjenkins94/util/silo/select");

					process.stdout.write(selectionText(selected) + "\n");

					return;
				}

				process.exitCode = await runSelected(selected, config.get("run").split(/\s+/u).filter((part) => part !== ""), { "repo": repo, "cwd": cwd, "say": (text) => { process.stdout.write(text + "\n"); } });
			}
		})
	]
});

if (isEntry(import.meta)) {
	await run(app);
}
