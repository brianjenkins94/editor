import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import definition from "./command.ts";
import { create } from "./less.ts";

test("less: prints its files, or what's piped in (UTF-8 intact)", async () => {
	const bash = new Bash({ "files": { "/home/user/notes.txt": "café\n" }, "cwd": "/home/user", "customCommands": [toCommand(definition, create())] });

	assert.equal((await bash.exec("less notes.txt")).stdout, "café\n");
	assert.equal((await bash.exec("echo 'naïve' | less")).stdout, "naïve\n");
	assert.match((await bash.exec("less missing.txt")).stderr, /No such file/u);
});
