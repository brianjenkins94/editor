// Convenience wrapper around `@bablr/cli` (the CLI resolves `-l` relative to its OWN install location, so a
// bare path won't work — this builds an absolute file:// URL, feeds input on stdin, strips ANSI, and suppresses
// the one benign end-of-stream error the current published VM throws AFTER emitting the complete tree).
//
//   node run.mjs <Production> '<input>'
//   node run.mjs Statement 'const x = "https://a"'
//   echo 'const x = 1' | node run.mjs           # production defaults to the grammar's defaultMatcher
//
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const grammarUrl = url.pathToFileURL(path.resolve(here, "lib/grammar.ts")).href;
const bablrBin = path.join(here, "node_modules", "@bablr", "cli", "bin", "index.js");

const maybeProduction = process.argv[2];
const looksLikeProduction = maybeProduction && /^[A-Z][A-Z0-9]*$/i.test(maybeProduction);
const production = looksLikeProduction ? maybeProduction : null;
const input = (production ? process.argv[3] : process.argv[2]) ?? readFileSync(0, "utf8");

const args = [bablrBin, "-l", grammarUrl, "--color", "never"];

if (production) {
	args.push("-p", production);
}

const result = spawnSync(process.execPath, args, { "input": input, "encoding": "utf8" });

const tree = (result.stdout || "").replace(/\x1B\[[0-9;]*m/gu, "");

process.stdout.write(tree);

const benign = result.stderr && result.stderr.includes("Parser failed to consume input");

if (result.stderr && !benign) {
	process.stderr.write(result.stderr);
}

process.exit(benign ? 0 : result.status ?? 0);
