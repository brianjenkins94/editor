// `code` and `open` over a stand-in VS Code API: what they open, where.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import openDefinition from "../open/command.ts";
import { create as open } from "../open/open.ts";
import { create as code } from "./code.ts";
import definition from "./command.ts";

function vscode() {
	const did = [];
	const uri = (scheme, path) => ({ "scheme": scheme, "path": path, "with": (change) => uri(change.scheme ?? scheme, path) });

	return {
		"did": did,
		"api": {
			"Uri": { "file": (path) => uri("file", path), "parse": (text) => ({ "url": text }) },
			"Range": class {
				constructor(line, column) {
					this.line = line;
					this.column = column;
				}
			},
			"env": { "openExternal": async (target) => { did.push(["external", target.url]); } },
			"commands": { "executeCommand": async (command, target) => { did.push([command, target.path]); } },
			"workspace": { "openTextDocument": async (target) => ({ "target": target }) },
			"window": { "showTextDocument": async ({ target }, options) => { did.push(["show", target.scheme, target.path, options.selection?.line]); } }
		}
	};
}

test("code: a file, a file at a line, a new file, a folder", async () => {
	const { api, did } = vscode();
	const bash = new Bash({ "files": { "/w/src/app.ts": "x", "/w/src/util.ts": "y" }, "cwd": "/w", "customCommands": [toCommand(definition, code({ "api": api }))] });

	assert.equal((await bash.exec("code -g src/app.ts src/util.ts:12:3 new.ts src")).exitCode, 0, "-g accepted, as VS Code's code takes it");
	assert.deepEqual(did, [["show", "file", "/w/src/app.ts", undefined], ["show", "file", "/w/src/util.ts", 11], ["show", "untitled", "/w/new.ts", undefined], ["revealInExplorer", "/w/src"]]);
	assert.equal((await bash.exec("code")).exitCode, 1, "nothing to open: usage");
});

test("open: code's opener, and a URL in the browser", async () => {
	const { api, did } = vscode();
	const bash = new Bash({ "customCommands": [toCommand(openDefinition, open({ "api": api }))] });

	await bash.exec("open https://example.com");
	assert.deepEqual(did, [["external", "https://example.com"]]);
});
