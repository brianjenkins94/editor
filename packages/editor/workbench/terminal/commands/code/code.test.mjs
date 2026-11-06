// `code` and `open` over a stand-in of VS Code's API, through a real just-bash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { toCommand } from "../../invoke.ts";
import openDefinition from "../open/command.ts";
import { create as open } from "../open/open.ts";
import { create as code } from "./code.ts";
import definition from "./command.ts";

function shell() {
	const done = [];
	const uri = (path, scheme = "file") => ({ "path": path, "scheme": scheme, "with": ({ "scheme": next }) => uri(path, next) });
	const api = {
		"FileType": { "Directory": 2 },
		"Position": class { constructor(line, column) { this.line = line; this.column = column; } },
		"Range": class { constructor(start) { this.start = start; } },
		"Uri": { "file": (path) => uri(path), "parse": (text) => ({ "address": text }) },
		"env": { "openExternal": async (address) => { done.push(["external", address.address]); } },
		"workspace": {
			"fs": {
				"stat": async ({ path }) => {
					if (path === "/workspace/a.ts") {
						return { "type": 1 };
					}

					if (path === "/workspace/src") {
						return { "type": 2 };
					}

					throw new Error("no such file");
				}
			}
		},
		"commands": {
			"executeCommand": async (command, target, options) => {
				done.push([command, target.scheme, target.path, options?.selection?.start.line, options?.selection?.start.column]);
			}
		}
	};
	const bash = new Bash({ "cwd": "/workspace", "customCommands": [toCommand(definition, code({ "api": api })), toCommand(openDefinition, open({ "api": api }))] });

	return { bash, done };
}

test("code opens a file; one that isn't there, unsaved; a folder, in the Explorer; -g, at its line", async () => {
	const { bash, done } = shell();

	assert.equal((await bash.exec("code a.ts new.ts src")).exitCode, 0);
	assert.deepEqual(done, [
		["vscode.open", "file", "/workspace/a.ts", undefined, undefined],
		["vscode.open", "untitled", "/workspace/new.ts", undefined, undefined],
		["revealInExplorer", "file", "/workspace/src", undefined, undefined]
	]);

	done.length = 0;
	await bash.exec("code -g a.ts:3:2");
	assert.deepEqual(done, [["vscode.open", "file", "/workspace/a.ts", 2, 1]]);
});

test("open: an address in the browser, a file in the editor, and nothing is a question", async () => {
	const { bash, done } = shell();

	await bash.exec("open https://example.com a.ts");
	assert.deepEqual(done, [["external", "https://example.com"], ["vscode.open", "file", "/workspace/a.ts", undefined, undefined]]);
	assert.equal((await bash.exec("open")).exitCode, 1);
});
