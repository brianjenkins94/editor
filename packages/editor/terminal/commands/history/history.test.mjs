import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { create } from "./history.ts";

test("history: the terminal's lines, numbered; history n the last n", async () => {
	const lines = ["ls", "cd src", "history"];
	const bash = new Bash({ "customCommands": [create({ "history": () => lines })] });

	assert.equal((await bash.exec("history")).stdout, "    1  ls\n    2  cd src\n    3  history\n");
	assert.equal((await bash.exec("history 1")).stdout, "    3  history\n");
});
