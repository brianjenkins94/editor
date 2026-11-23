/**
 * `silo test`: the tests a change needs, run, and what they did kept where the next run reads it (packages/silo/README.md,
 * *Tests by feature, in your face*, decision 20). A CI step calls it with its runner's command; it selects (lib
 * util/silo/select: what the change reaches by declaration, the vouches in `.silo/vouches/`, how each test has done in
 * the CI's own runs), runs the runner on the files selected with silo's node:test reporter beside the runner's own
 * (./reporter.mjs), and the reporter's lines in the log are what the next run's selection reads back. Nothing is
 * committed from CI.
 *
 * Reach is static for now: what a test's file reaches in the declaration graph, so a test runs for any change to code it
 * could run. A change with no base to compare (a first push, a force push, a base not fetched) runs everything.
 */
import type { CiRun, TestOutcome, TestStanding } from "@brianjenkins94/util/silo/outcomes";
import type { Analyzer, DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { Selected, Vouch } from "@brianjenkins94/util/silo/select";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { changedDeclarations, digest } from "@brianjenkins94/util/silo/graph";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { VOUCHES_DIR } from "@brianjenkins94/util/silo/layout";
import { githubRuns, standings } from "@brianjenkins94/util/silo/outcomes";
import { filesToRun, fingerprintsOf, parseVouches, selectionText, selectTests, staticReach, testId } from "@brianjenkins94/util/silo/select";
import { gitObjects } from "@brianjenkins94/util/silo/git-snapshots";

/** What silo's reporter (./reporter.mjs) writes, a line a test — after whatever a log puts first (a timestamp, pnpm's
 *  `packages/editor test: `). */
const LINE = /silo:test (\{.*\})\s*$/u;

/** The tests silo's reporter reported in `log` (a CI job's, or a run's own output), each its file first in its titles. */
export function reportedIn(log: string): TestOutcome[] {
	return log.split("\n").flatMap((line) => {
		const json = LINE.exec(line)?.[1];

		if (json === undefined) {
			return [];
		}

		try {
			const { file, titles, outcome, ms } = JSON.parse(json) as { "file"?: string; "titles": string[]; "outcome": TestOutcome["outcome"]; "ms"?: number };

			return file === undefined ? [] : [{ "titles": [file, ...titles], "outcome": outcome, ...ms === undefined ? {} : { "ms": ms } }];
		} catch {
			return [];
		}
	});
}

/** Each test's standing in `runs`, by its id (file › titles): what the job's name adds before it, taken off. */
export function standingsByTest(runs: CiRun[]): Map<string, TestStanding> {
	return new Map([...standings(runs)].map(([id, standing]) => {
		const test = id.slice(id.indexOf(" › ") + 3);

		return [test, { ...standing, "id": test }];
	}));
}

/** Everyone's vouches in `repo`. */
export function vouchesIn(repo: string): Vouch[] {
	const folder = path.join(repo, VOUCHES_DIR);

	return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith(".jsonl")).flatMap((name) => parseVouches(fs.readFileSync(path.join(folder, name)))) : [];
}

/** Everyone's vouches as they were at `ref`. */
export function vouchesAt(repo: string, ref: string): Vouch[] {
	return (git(repo, ["ls-tree", "--name-only", `${ref}:${VOUCHES_DIR}`]) ?? "").split("\n").filter((name) => name.endsWith(".jsonl")).flatMap((name) => parseVouches(git(repo, ["show", `${ref}:${VOUCHES_DIR}/${name}`]) ?? ""));
}

/** git's answer, or undefined when it has none. */
const git = (repo: string, args: string[]): string | undefined => {
	const answer = spawnSync("git", args, { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 });

	return answer.status === 0 ? answer.stdout : undefined;
};

/** The program's declaration graph at `ref` (undefined: as it is on disk), of its code and `tests`. */
export async function graphAt(repo: string, analyzer: Analyzer, tests: readonly string[], ref?: string): Promise<DeclarationGraph | undefined> {
	const wanted = (file: string): boolean => includeByDefault(file) || tests.includes(file);

	if (ref === undefined) {
		const listed = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "";
		const files = listed.split("\n").filter((file) => file !== "" && wanted(file) && fs.existsSync(path.join(repo, file)));

		return (await analyzer.analyze(new Map(files.map((file) => [file, file])), async (file) => fs.readFileSync(path.join(repo, file)))).graph;
	}

	// (the base fetched if a shallow clone hasn't it: one commit deep)
	if (git(repo, ["cat-file", "-e", `${ref}^{commit}`]) === undefined) {
		git(repo, ["fetch", "--depth=1", "origin", ref]);
	}

	const tree = git(repo, ["ls-tree", "-r", ref]);

	if (tree === undefined) {
		return undefined;
	}

	const files = new Map(tree.split("\n").flatMap((line) => {
		const [meta, file] = line.split("\t");
		const oid = meta?.split(" ")[2];

		return file !== undefined && oid !== undefined && wanted(file) ? [[file, oid] as const] : [];
	}));
	const objects = gitObjects(repo);

	try {
		return (await analyzer.analyze(files, objects.read)).graph;
	} finally {
		objects.close();
	}
}

/** The tests another runtime's vouches count for (decision 19): ones it vouched for before CI's latest run of them, which
 *  passed too — the two having agreed. */
export function agreedOn(vouches: readonly Vouch[], standings: ReadonlyMap<string, TestStanding>, runtime: string): Set<string> {
	return new Set(vouches.filter((vouch) => vouch.runtime !== runtime && vouch.outcome === "pass").flatMap((vouch) => {
		const standing = standings.get(vouch.test);

		return standing !== undefined && standing.last.verdict === "pass" && vouch.at < standing.last.at ? [vouch.test] : [];
	}));
}

/** What a vouch holds to beyond the graph's declarations: a file the graph doesn't read (a test's own, a JavaScript
 *  helper), named by its path, by its contents' git id as it is in `repo` now. */
export function filesNamedIn(repo: string, vouches: readonly Vouch[]): Map<string, string> {
	const files = [...new Set(vouches.flatMap((vouch) => Object.keys(vouch.reached).filter((key) => !key.includes("#"))))].filter((file) => fs.existsSync(path.join(repo, file))).sort();
	const oids = files.length === 0 ? [] : (git(repo, ["hash-object", "--", ...files]) ?? "").trim().split("\n");

	return new Map(files.flatMap((file, index) => oids[index] === undefined || oids[index] === "" ? [] : [[file, oids[index]] as const]));
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];

/** The lockfiles over `file` (from the repository's top), each held by its contents' git id kept as its digest: a
 *  vouch holding them lapses when a dependency's version changes, as `filesNamedIn` reads them back. */
export function lockfilesOver(repo: string, file: string): Record<string, string> {
	const found: string[] = [];

	for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
		found.push(...LOCKFILES.map((name) => (dir === "." ? name : `${dir}/${name}`)).filter((each) => fs.existsSync(path.join(repo, each))));

		if (dir === "." || dir === "/") {
			break;
		}
	}

	const oids = found.length === 0 ? [] : (git(repo, ["hash-object", "--", ...found]) ?? "").trim().split("\n");

	return Object.fromEntries(found.flatMap((each, index) => (oids[index] === undefined || oids[index] === "" ? [] : [[each, digest(oids[index])]])));
}

/** The ids each file had at `ref`, of `files` git has there. */
export function idsAt(repo: string, ref: string, files: readonly string[]): Map<string, string> {
	const tree = files.length === 0 ? "" : git(repo, ["ls-tree", "-r", ref, "--", ...files]) ?? "";

	return new Map(tree.split("\n").flatMap((line) => {
		const [meta, file] = line.split("\t");
		const oid = meta?.split(" ")[2];

		return file === undefined || oid === undefined ? [] : [[file, oid] as const];
	}));
}

/** The files a push changed since `base`, by path. */
export function filesChangedSince(repo: string, base: string): string[] {
	return (git(repo, ["diff", "--name-only", base, "HEAD"]) ?? "").split("\n").filter((file) => file !== "");
}

/** Each test's reach from a run, finer than its file's static reach: the files its latest run-made vouch (one held to
 *  files, not declarations: the editor's) names — what ran as its modules loaded and in its own window, and the packages
 *  it loaded — of those that still held of the code at the push's base (`atBase`, and what's installed `now`). Code a
 *  test didn't run then can't change how it comes out unless a file it ran changes too, which the push's changed files
 *  say; a vouch that no longer held at the base says nothing of what the test runs now. */
export function ranReach(vouches: readonly Vouch[], atBase: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): Map<string, Set<string>> {
	const held = (vouch: Vouch): boolean => Object.entries(vouch.reached).every(([file, kept]) => {
		const oid = file.includes("node_modules/") ? now.get(file) : atBase.get(file);

		return oid !== undefined && digest(oid) === kept;
	});
	const reach = new Map<string, Vouch>();

	for (const vouch of vouches) {
		const keys = Object.keys(vouch.reached);

		if (keys.length > 0 && keys.every((key) => !key.includes("#")) && (reach.get(vouch.test)?.at ?? "") < vouch.at && held(vouch)) {
			reach.set(vouch.test, vouch);
		}
	}

	return new Map([...reach].map(([test, vouch]) => [test, new Set(Object.keys(vouch.reached))]));
}

export interface TestOptions {
	"repo": string;
	/** The test files the runner would run, from the repository's top. */
	"candidates": readonly string[];
	"analyzer": Analyzer;
	/** The commit the change is from (a push's `before`); none, or one that can't be read, runs everything. */
	"base"?: string;
	"runtime": string;
	"full": boolean;
	"audit": number;
	/** Where CI's own runs are read: `owner/name`, its workflow, and a token; none, and every test is new. */
	"ci"?: { "repository": string; "workflow": string; "token"?: string; "limit"?: number };
	/** Where what went wrong on the way is said: CI's runs that couldn't be read. */
	"say"?: (text: string) => void;
}

/** Each candidate test, run or not, and why. */
export async function selectFor(options: TestOptions): Promise<Selected[]> {
	const head = await graphAt(options.repo, options.analyzer, options.candidates);
	const base = options.base === undefined || /^0+$/u.test(options.base) ? undefined : await graphAt(options.repo, options.analyzer, options.candidates, options.base);
	const runs = options.ci === undefined ? [] : await githubRuns({ "repository": options.ci.repository, "workflow": options.ci.workflow, "limit": options.ci.limit ?? 20, "read": reportedIn, ...options.ci.token === undefined ? {} : { "token": options.ci.token } }).catch((error: unknown) => {
		options.say?.(`${options.ci!.repository}'s ${options.ci!.workflow} runs couldn't be read (${(error as Error).message}): every test is new to this run.`);

		return [];
	});
	const known = standingsByTest(runs);
	// (a file's tests as CI's runs know them; a file none know of stands for its tests, new)
	const tests = options.candidates.flatMap((file) => {
		const ids = [...known.keys()].filter((id) => id.startsWith(`${file} › `));

		return ids.length === 0 ? [{ "id": file, "file": file }] : ids.map((id) => ({ "id": id, "file": file }));
	});

	if (head === undefined) {
		throw new Error("the program couldn't be read");
	}

	const vouches = vouchesIn(options.repo);
	const named = filesNamedIn(options.repo, vouches);
	const then = base === undefined ? [] : [...vouches, ...vouchesAt(options.repo, options.base!)];
	const ran = base === undefined ? new Map<string, Set<string>>() : ranReach(then, idsAt(options.repo, options.base!, [...new Set(then.flatMap((vouch) => Object.keys(vouch.reached).filter((key) => !key.includes("#") && !key.includes("node_modules/"))))]), filesNamedIn(options.repo, then));

	return selectTests({
		"tests": tests,
		"reach": (test) => ran.get(test.id) ?? staticReach(head, test.file),
		"changed": new Set(base === undefined ? [] : [...changedDeclarations(base, head), ...filesChangedSince(options.repo, options.base!)]),
		"fingerprints": new Map([...head.fingerprints, ...named]),
		"standings": known,
		"vouches": vouches,
		"agreed": agreedOn(vouches, known, options.runtime),
		"runtime": options.runtime,
		"full": options.full || base === undefined,
		"audit": options.audit,
		"now": Date.now()
	});
}

/** Vouches for the tests that passed in `outcomes` (silo's reporter's, read back: `reportedIn`), each with the fingerprints
 *  of what its file reaches in `graph`, the code as it is now, and what `held` adds (its lockfiles, `lockfilesOver`). A
 *  failure vouches for nothing. */
export function vouchesFor(outcomes: readonly TestOutcome[], graph: DeclarationGraph, options: { "by": string; "runtime": string; "commit"?: string; "at"?: string; "held"?: (file: string) => Record<string, string> }): Vouch[] {
	const at = options.at ?? new Date().toISOString();

	return outcomes.filter((outcome) => outcome.outcome === "pass").map((outcome) => {
		const [file, ...titles] = outcome.titles;

		return { "test": testId(file!, titles), "outcome": "pass" as const, "by": options.by, "at": at, "runtime": options.runtime, ...options.commit === undefined ? {} : { "commit": options.commit }, "reached": { ...fingerprintsOf(graph, staticReach(graph, file!)), ...options.held?.(file!) } };
	});
}

/** The runner run on `files` with silo's reporter beside its own, its output passed through: its exit code, and silo's
 *  lines of it. */
export function runWithReporter(files: readonly string[], runner: readonly string[], options: { "repo": string; "cwd": string }): { "status": number; "outcomes": TestOutcome[] } {
	const reporter = path.join(import.meta.dirname, "reporter.mjs");
	const [command, ...args] = runner;
	const ran = spawnSync(command!, [...args, "--test-reporter=spec", "--test-reporter-destination=stderr", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...files.map((file) => path.relative(options.cwd, path.join(options.repo, file)))], { "cwd": options.cwd, "stdio": ["inherit", "pipe", "inherit"], "encoding": "utf8", "maxBuffer": 1 << 28, "env": { ...process.env, "SILO_ROOT": options.repo } });

	return { "status": ran.status ?? 1, "outcomes": reportedIn(ran.stdout ?? "") };
}

/** The selection said, and the runner run on its files with silo's reporter beside its own: the runner's exit code. */
export async function runSelected(selected: Selected[], runner: readonly string[], options: { "repo": string; "cwd": string; "say": (text: string) => void }): Promise<number> {
	const files = filesToRun(selected);

	options.say(selectionText(selected));

	if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
		await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "### Tests selected\n\n```\n" + selectionText(selected) + "\n```\n");
	}

	if (files.length === 0) {
		return 0;
	}

	const reporter = path.join(import.meta.dirname, "reporter.mjs");
	const [command, ...args] = runner;
	const ran = spawnSync(command!, [...args, "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...files.map((file) => path.relative(options.cwd, path.join(options.repo, file)))], { "cwd": options.cwd, "stdio": "inherit", "env": { ...process.env, "SILO_ROOT": options.repo } });

	return ran.status ?? 1;
}
