// npm (and npx, pnpm, yarn) through a real just-bash, over a package.json in memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash, defineCommand } from "just-bash/browser";

import { create as npx } from "../npx/npx.ts";
import { asNpm, create as pnpm } from "../pnpm/pnpm.ts";
import { create as yarn } from "../yarn/yarn.ts";
import { create as npm } from "./npm.ts";

const PACKAGE = JSON.stringify({ "name": "demo", "version": "1.0.0", "scripts": { "dev": "vite", "hello": "echo hi from the script" }, "dependencies": { "react": "18.2.0" }, "devDependencies": { "vite": "latest" } });

function shell() {
	let bash;
	const host = { "session": async () => ({ "exec": (line, options) => bash.exec(line, options) }) };
	const vite = defineCommand("vite", async () => ({ "stdout": "vite ran\n", "stderr": "", "exitCode": 0 }));

	bash = new Bash({ "files": { "/workspace/package.json": PACKAGE }, "cwd": "/workspace", "customCommands": [npm(host), npx(host), pnpm(host), yarn(host), vite] });

	return bash;
}

test("npm: ls, run alone lists the scripts, a script runs, -v", async () => {
	const bash = shell();

	assert.equal((await bash.exec("npm ls")).stdout, "demo@1.0.0 /workspace\n├── react@18.2.0\n└── vite@latest (dev)\n");
	assert.match((await bash.exec("npm run")).stdout, /hello\n {4}echo hi from the script/u);
	assert.equal((await bash.exec("npm run hello")).stdout, "hi from the script\n");
	assert.equal((await bash.exec("npm -v")).stdout, "10.0.0\n");
	assert.match((await bash.exec("npm ci")).stdout, /no install step needed/u);
});

test("npx: a command this shell has runs; a package's own binary says why not", async () => {
	const bash = shell();

	assert.equal((await bash.exec("npx vite")).stdout, "vite ran\n");
	assert.equal((await bash.exec("npm exec vite")).stdout, "vite ran\n");

	const missing = await bash.exec("npx prettier --write .");

	assert.equal(missing.exitCode, 127);
	assert.match(missing.stderr, /can't run prettier here/u);
});

test("pnpm and yarn: npm in their words", async () => {
	const bash = shell();

	assert.deepEqual(asNpm([]), ["install"]);
	assert.deepEqual(asNpm(["add", "lodash"]), ["add", "lodash"]);
	assert.deepEqual(asNpm(["dev", "--port", "3000"]), ["run", "dev", "--port", "3000"]);
	assert.deepEqual(asNpm(["dlx", "vite"]), ["exec", "vite"]);
	assert.equal((await bash.exec("yarn hello")).stdout, "hi from the script\n");
	assert.equal((await bash.exec("pnpm dev")).stdout, "vite ran\n");
	assert.match((await bash.exec("pnpm nope")).stderr, /pnpm error: Missing script: "nope"/u);
});
