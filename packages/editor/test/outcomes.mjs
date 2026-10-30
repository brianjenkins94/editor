/**
 * Every architecture test's standing, read from CI's own history (packages/silo/README.md, *Tests by feature, in your
 * face*: "A test ledger"; lib `util/silo/outcomes`): the workflow's latest runs on main, their attempts and each job's
 * log, and per test its last verdict, when it last failed, its flakes and its streak. Nothing is recorded for it.
 * Finished jobs' tests are kept in `.silo/local/ci/` (a finished job's log never changes), so a second read asks GitHub
 * only for the runs since.
 *
 *   node test/outcomes.mjs [--runs 50] [--all] [--json]   — failing and flaky first, then the rest with --all
 *
 * The token is GITHUB_TOKEN, or gh's (`gh auth token`).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { parseArgs } from "node:util";
import { githubRuns, standings } from "@brianjenkins94/util/silo/outcomes";

const ROOT = path.resolve(url.fileURLToPath(new URL("../../../", import.meta.url)));
const CACHE = path.join(ROOT, ".silo/local/ci/architecture");

const { values } = parseArgs({ "options": { "runs": { "type": "string", "default": "50" }, "all": { "type": "boolean" }, "json": { "type": "boolean" } } });
const token = process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { "encoding": "utf8" }).trim();
const cache = {
	"get": async (job) => {
		const file = path.join(CACHE, `${job}.json`);

		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
	},
	"set": async (job, tests) => {
		fs.mkdirSync(CACHE, { "recursive": true });
		fs.writeFileSync(path.join(CACHE, `${job}.json`), JSON.stringify(tests));
	}
};

const runs = await githubRuns({ "repository": "brianjenkins94/editor", "workflow": "architecture.yml", "limit": Number(values.runs), "token": token, "cache": cache });
const all = [...standings(runs).values()];
// (what needs looking at first: failing, then flaky, the latest failure first; then the rest, the shortest streak first)
const rank = (standing) => (standing.last.verdict === "fail" ? 0 : standing.last.verdict === "flaky" || standing.flakes > 0 ? 1 : 2);
const shown = all.filter((standing) => values.all === true || rank(standing) < 2).sort((left, right) => rank(left) - rank(right) || (right.lastFailed?.at ?? "").localeCompare(left.lastFailed?.at ?? "") || left.streak.runs - right.streak.runs);

if (values.json === true) {
	process.stdout.write(JSON.stringify(shown, null, "\t") + "\n");
} else {
	process.stdout.write(`${String(runs.length)} runs of architecture.yml on main, ${String(all.length)} tests: ${String(all.filter((standing) => standing.last.verdict === "fail").length)} failing, ${String(all.filter((standing) => standing.flakes > 0).length)} flaky, ${String(all.filter((standing) => standing.streak.verdict === "pass" && standing.streak.runs >= 20).length)} green 20 runs or more\n\n`);

	for (const standing of shown) {
		const failed = standing.lastFailed === undefined ? "never failed" : `last ${standing.lastFailed.verdict} ${standing.lastFailed.at.slice(0, 10)} (${standing.lastFailed.commit.slice(0, 8)})`;

		process.stdout.write(`${standing.last.verdict.padEnd(5)} ${String(standing.streak.runs).padStart(3)} in a row  ${String(standing.flakes).padStart(2)} flakes  ${failed.padEnd(34)}  ${standing.id}\n`);
	}
}
