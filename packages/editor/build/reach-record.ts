import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { lastRunReachPath, ledgerPath } from "@brianjenkins94/util/silo/layout";
import { parseLedger } from "@brianjenkins94/util/silo/ledger";
import { observedAgainstDeclared, observedText, parseReach, reachRecord } from "@brianjenkins94/util/silo/observed";

type Test = ReturnType<typeof parseReach>[number];

export function testsIn(folder: string, tracked: readonly string[]): Test[] {
	const kept = new Set(tracked);

	return (fs.readdirSync(folder, { "recursive": true }) as string[]).filter((file) => file.endsWith(".json")).toSorted().flatMap((file) => {
		const suite = file.split(path.sep).join("/").replace(/\.json$/u, "");

		if (kept.has(suite)) {
			return parseReach(suite, fs.readFileSync(path.join(folder, file))).map((test) => ({ ...test, "name": test.name.replace(`${suite} › `, "") }));
		}

		const candidates = tracked.filter((each) => new RegExp(`(^|/)test/(.*/)?${suite.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.[cm]?[jt]s$`, "u").test(each));

		if (candidates.length !== 1) {
			throw new Error(`${file}: expected one test file named ${suite}, found ${String(candidates.length)}`);
		}

		const under = path.posix.dirname(candidates[0]) + "/";

		return parseReach(candidates[0], fs.readFileSync(path.join(folder, file))).map((test) => {
			const runs = tracked.filter((each) => each.startsWith(under) && each.endsWith(`/${test.name}`));

			return runs.length === 1 ? { ...test, "file": runs[0] } : test;
		});
	});
}

export function recordReach(folder: string, repo: string, today = new Date().toISOString().slice(0, 10), commit?: string): string {
	const tracked = execFileSync("git", ["ls-files"], { "cwd": repo, "encoding": "utf8", "maxBuffer": 1 << 28 }).split("\n").filter((file) => file !== "");
	const tests = testsIn(folder, tracked);
	const ledger = path.join(repo, ledgerPath());
	const observed = observedAgainstDeclared(parseLedger(fs.existsSync(ledger) ? fs.readFileSync(ledger) : undefined), tests);
	const record = path.join(repo, lastRunReachPath());

	fs.mkdirSync(path.dirname(record), { "recursive": true });
	fs.writeFileSync(record, JSON.stringify(reachRecord(tests, today, commit)) + "\n");

	return observedText(observed) + `\nWhat each test ran is kept in ${lastRunReachPath()}, for \`silo check\`: commit it.\n`;
}

if (isEntry(import.meta)) {
	const [folder, repo, commit] = process.argv.slice(2);

	if (folder === undefined) {
		process.stderr.write("node --import tsx packages/editor/build/reach-record.ts <folder of each test file's reach> [repository] [the commit they ran]\n");
		process.exit(1);
	}

	process.stdout.write(recordReach(path.resolve(folder), path.resolve(repo ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { "encoding": "utf8" }).trim()), undefined, commit));
}
