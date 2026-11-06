// pnpm, yarn and npx say what they're asked in npm's words: a stand-in npm that says what it was given, through a real just-bash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash, defineCommand } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import npxDefinition from "../npx/command.ts";
import { create as npx } from "../npx/npx.ts";
import yarnDefinition from "../yarn/command.ts";
import { create as yarn } from "../yarn/yarn.ts";
import definition from "./command.ts";
import { create as pnpm } from "./pnpm.ts";

function shell() {
	let bash;
	const host = { "session": async () => ({ "exec": (line, options) => bash.exec(line, options) }) };
	const npm = defineCommand("npm", async (args) => ({ "stdout": `npm ${args.join(" ")}\n`, "stderr": "", "exitCode": 0 }));

	bash = new Bash({ "cwd": "/workspace", "customCommands": [npm, toCommand(definition, pnpm(host)), toCommand(yarnDefinition, yarn(host)), toCommand(npxDefinition, npx(host))] });

	return bash;
}

test("pnpm and yarn in npm's words", async () => {
	const bash = shell();
	const said = async (line) => (await bash.exec(line)).stdout.trim();

	assert.equal(await said("pnpm add -D vite"), "npm install -D vite");
	assert.equal(await said("yarn add --dev vite"), "npm install -D vite");
	assert.equal(await said("pnpm remove vite"), "npm uninstall vite");
	assert.equal(await said("yarn dev --port 3"), "npm run dev --port 3");
	assert.equal(await said("pnpm run build"), "npm run build");
	assert.equal(await said("pnpm dlx vite"), "npm exec vite");
	assert.equal(await said("yarn"), "npm install");
	assert.equal(await said("pnpm"), "npm run");
});

test("npx runs what this shell has, and says when it can't", async () => {
	const bash = shell();

	assert.equal((await bash.exec("npx npm ls")).stdout, "npm ls\n");
	assert.match((await bash.exec("npx cowsay hi")).stderr, /npx: can't run cowsay here/u);
});
