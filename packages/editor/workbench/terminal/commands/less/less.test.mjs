// `less`, `more`, `history` and what isn't here, through a real just-bash, built from their definitions through juvy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import gitDefinition from "../git/command.ts";
import historyDefinition from "../history/command.ts";
import { create as history } from "../history/history.ts";
import moreDefinition from "../more/command.ts";
import { create as more } from "../more/more.ts";
import pythonDefinition from "../python/command.ts";
import sudoDefinition from "../sudo/command.ts";
import definition from "./command.ts";
import { create as less } from "./less.ts";

function shell(lines = []) {
	const host = {
		"history": {
			"lines": () => lines,
			"clear": () => {
				lines.length = 0;
			}
		}
	};

	return new Bash({
		"files": { "/workspace/a.txt": "one\n", "/workspace/b.txt": "two\n" },
		"cwd": "/workspace",
		"customCommands": [
			toCommand(definition, less(host)),
			toCommand(moreDefinition, more(host)),
			toCommand(historyDefinition, history(host)),
			toCommand(pythonDefinition),
			toCommand(sudoDefinition),
			toCommand({ ...gitDefinition, "subcommands": {} }, {})
		]
	});
}

test("less and more show files, or what's piped in, whole", async () => {
	const bash = shell();

	assert.equal((await bash.exec("less a.txt b.txt")).stdout, "one\ntwo\n");
	assert.equal((await bash.exec("cat a.txt | more")).stdout, "one\n");

	const missing = await bash.exec("more nope.txt");

	assert.equal(missing.exitCode, 1);
	assert.match(missing.stderr, /more: nope\.txt: No such file/u);
	assert.equal((await bash.exec("less")).exitCode, 1);
});

test("history numbers this terminal's lines; a number shows the latest; -c forgets", async () => {
	const lines = ["ls", "cat a.txt", "history"];
	const bash = shell(lines);

	assert.equal((await bash.exec("history")).stdout, "    1  ls\n    2  cat a.txt\n    3  history\n");
	assert.equal((await bash.exec("history 1")).stdout, "    3  history\n");
	assert.equal((await bash.exec("history nope")).exitCode, 1);
	await bash.exec("history -c");
	assert.equal((await bash.exec("history")).stdout, "");
});

test("what isn't here says what to do instead, whatever it's given", async () => {
	const bash = shell();

	for (const line of ["python", "python -c 'print(1)'", "python --version"]) {
		const said = await bash.exec(line);

		assert.equal(said.exitCode, 127);
		assert.match(said.stderr, /^python: there's no Python in a browser.*node <file>/u);
	}

	assert.match((await bash.exec("sudo rm -rf x")).stderr, /run it without sudo/u);
	assert.match((await bash.exec("git stash pop")).stderr, /^git stash: isn't here: .*git switch -c/u);
	assert.match((await bash.exec("git rebase --onto x")).stderr, /^git rebase: isn't here/u);
});
