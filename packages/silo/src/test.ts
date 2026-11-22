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
import { changedDeclarations } from "@brianjenkins94/util/silo/graph";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { VOUCHES_DIR } from "@brianjenkins94/util/silo/layout";
import { githubRuns, standings } from "@brianjenkins94/util/silo/outcomes";
import { filesToRun, fingerprintsOf, parseVouches, selectionText, selectTests, staticReach, testId } from "@brianjenkins94/util/silo/select";
import { gitObjects } from "@brianjenkins94/util/silo/git-snapshots";

/** What silo's reporter (./reporter.mjs) writes, a line a test. */
const LINE = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?silo:test (\{.*\})\s*$/u;

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
}

/** Each candidate test, run or not, and why. */
export async function selectFor(options: TestOptions): Promise<Selected[]> {
	const head = await graphAt(options.repo, options.analyzer, options.candidates);
	const base = options.base === undefined || /^0+$/u.test(options.base) ? undefined : await graphAt(options.repo, options.analyzer, options.candidates, options.base);
	const runs = options.ci === undefined ? [] : await githubRuns({ "repository": options.ci.repository, "workflow": options.ci.workflow, "limit": options.ci.limit ?? 20, "read": reportedIn, ...options.ci.token === undefined ? {} : { "token": options.ci.token } }).catch(() => []);
	const known = standingsByTest(runs);
	// (a file's tests as CI's runs know them; a file none know of stands for its tests, new)
	const tests = options.candidates.flatMap((file) => {
		const ids = [...known.keys()].filter((id) => id.startsWith(`${file} › `));

		return ids.length === 0 ? [{ "id": file, "file": file }] : ids.map((id) => ({ "id": id, "file": file }));
	});

	if (head === undefined) {
		throw new Error("the program couldn't be read");
	}

	return selectTests({
		"tests": tests,
		"reach": (test) => staticReach(head, test.file),
		"changed": new Set(base === undefined ? [] : changedDeclarations(base, head)),
		"fingerprints": head.fingerprints,
		"standings": known,
		"vouches": vouchesIn(options.repo),
		"runtime": options.runtime,
		"full": options.full || base === undefined,
		"audit": options.audit,
		"now": Date.now()
	});
}

/** Vouches for the tests that passed in `outcomes` (silo's reporter's, read back: `reportedIn`), each with the fingerprints
 *  of what its file reaches in `graph`, the code as it is now. A failure vouches for nothing. */
export function vouchesFor(outcomes: readonly TestOutcome[], graph: DeclarationGraph, options: { "by": string; "runtime": string; "commit"?: string; "at"?: string }): Vouch[] {
	const at = options.at ?? new Date().toISOString();

	return outcomes.filter((outcome) => outcome.outcome === "pass").map((outcome) => {
		const [file, ...titles] = outcome.titles;

		return { "test": testId(file!, titles), "outcome": "pass" as const, "by": options.by, "at": at, "runtime": options.runtime, ...options.commit === undefined ? {} : { "commit": options.commit }, "reached": fingerprintsOf(graph, staticReach(graph, file!)) };
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
