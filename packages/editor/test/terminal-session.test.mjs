/**
 * The terminal's session over just-bash (terminal-session.ts): cwd and env carried from command to command — through
 * an interrupted one too. Real just-bash, in memory.
 *
 *   node --test test/terminal-session.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash, defineCommand } from "just-bash";

import { execInSession } from "../terminal-session.ts";

/** A long-running command, like `vite`: runs until Ctrl-C, then exits 130. */
const waiter = defineCommand("waiter", async (_args, ctx) => {
	await new Promise((resolve) => {
		if (ctx.signal?.aborted === true) {
			resolve();
		}

		ctx.signal?.addEventListener("abort", resolve, { "once": true });
	});

	return { "stdout": "", "stderr": "", "exitCode": 130 };
});

async function session() {
	const bash = new Bash({ "customCommands": [waiter] });

	await bash.exec("mkdir -p /workspace/games/netsim", { "cwd": "/" });

	return { "bash": bash, "state": { "cwd": "/workspace", "env": {} } };
}

/** Run `line`, pressing Ctrl-C after `ms`. */
async function interrupted(bash, state, line, ms = 50) {
	const controller = new AbortController();

	setTimeout(() => { controller.abort(); }, ms);

	return execInSession(bash, state, line, controller.signal);
}

test("a cd and an export stick from one command to the next, and the probe never shows", async () => {
	const { bash, state } = await session();
	const cd = await execInSession(bash, state, "cd games/netsim && export GAME=netsim");

	assert.deepEqual([cd.stdout, cd.exitCode, state.cwd], ["", 0, "/workspace/games/netsim"]);

	const next = await execInSession(bash, state, "pwd; echo $GAME; false");

	assert.deepEqual([next.stdout, next.exitCode], ["/workspace/games/netsim\nnetsim\n", 1], "the command's own exit code, not the probe's");
});

test("after a Ctrl-C, the next command runs where the session was — not in just-bash's default directory", async () => {
	const { bash, state } = await session();

	// A fresh terminal's first command, interrupted (`vite`, then Ctrl-C): just-bash hands back its default env, whose
	// PWD is /home/user — the next command used to run there, and the prompt followed.
	await interrupted(bash, state, "waiter");
	assert.equal(state.cwd, "/workspace");

	const pwd = await execInSession(bash, state, "echo \"$PWD\"");

	assert.equal(pwd.stdout, "/workspace\n");
	assert.equal(state.cwd, "/workspace", "and the prompt stays put");
});

test("an interrupted command's own cd doesn't reach the session (it never gets to report it)", async () => {
	const { bash, state } = await session();

	await interrupted(bash, state, "cd games/netsim && waiter");
	assert.equal(state.cwd, "/workspace");
	assert.equal((await execInSession(bash, state, "pwd")).stdout, "/workspace\n");
});
