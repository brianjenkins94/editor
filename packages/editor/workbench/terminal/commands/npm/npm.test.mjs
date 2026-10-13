// npm (and npx, pnpm, yarn) through a real just-bash, built from their definitions through juvy (../../invoke.ts), over a
// package.json in memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash, defineCommand } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import npxDefinition from "../npx/command.ts";
import { create as npx } from "../npx/npx.ts";
import pnpmDefinition from "../pnpm/command.ts";
import { asNpm, create as pnpm } from "../pnpm/pnpm.ts";
import yarnDefinition from "../yarn/command.ts";
import { create as yarn } from "../yarn/yarn.ts";
import npmDefinition from "./command.ts";
import { create as npm } from "./npm.ts";

const PACKAGE = JSON.stringify({ "name": "demo", "version": "1.0.0", "scripts": { "dev": "vite", "hello": "echo hi from the script" }, "dependencies": { "react": "18.2.0" }, "devDependencies": { "vite": "latest" } });

function shell() {
	let bash;
	const host = { "session": async () => ({ "exec": (line, options) => bash.exec(line, options) }) };
	const vite = defineCommand("vite", async (args) => ({ "stdout": `vite ran${args.length > 0 ? " " + args.join(" ") : ""}\n`, "stderr": "", "exitCode": 0 }));

	bash = new Bash({ "files": { "/workspace/package.json": PACKAGE }, "cwd": "/workspace", "customCommands": [toCommand(npmDefinition, npm(host)), toCommand(npxDefinition, npx(host)), toCommand(pnpmDefinition, pnpm(host)), toCommand(yarnDefinition, yarn(host)), vite] });

	return bash;
}

test("npm: ls, run alone lists the scripts, a script runs with its arguments, version", async () => {
	const bash = shell();

	assert.equal((await bash.exec("npm ls")).stdout, "demo@1.0.0 /workspace\n├── react@18.2.0\n└── vite@latest (dev)\n");
	assert.match((await bash.exec("npm run")).stdout, /hello\n {4}echo hi from the script/u);
	assert.equal((await bash.exec("npm run hello")).stdout, "hi from the script\n");
	assert.equal((await bash.exec("npm run dev -- --port 3000")).stdout, "vite ran --port 3000\n", "after --, the script's");
	assert.equal((await bash.exec("npm -v")).stdout, "10.0.0\n");
	assert.match((await bash.exec("npm ci")).stdout, /no install step needed/u);
	assert.match((await bash.exec("npm instal")).stderr, /Did you mean 'install'\?/u, "juvy's routing");
	assert.match((await bash.exec("npm run --help")).stdout, /Run a package\.json script/u, "juvy's help");
});

test("npm install -D and uninstall edit package.json", async () => {
	const bash = shell();

	await bash.exec("npm install -D typescript@5");
	await bash.exec("npm uninstall react");

	const pkg = JSON.parse(await bash.fs.readFile("/workspace/package.json"));

	assert.deepEqual(pkg.devDependencies, { "vite": "latest", "typescript": "5" });
	assert.deepEqual(pkg.dependencies, {});
});

test("npx: a command this shell has runs; a package's own binary says why not", async () => {
	const bash = shell();

	assert.equal((await bash.exec("npx vite --host")).stdout, "vite ran --host\n", "the command's own options pass through");
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
	assert.match((await bash.exec("yarn -v")).stdout, /yarn is its npm/u);
});
