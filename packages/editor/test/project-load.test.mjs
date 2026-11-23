/**
 * A load that replaces the workspace (workbench/project.ts `openProject`) marks itself while it writes
 * (`.silo/local/loading`, editor-api's `LOADING`): written before its files, removed after the last. One the browser closed
 * on leaves the mark in what the workspace restores, so `git.origin` says it's no repository's — though its `.git/config`,
 * among the first files written, names one — and the shell loads it again rather than open what's half there. VS Code's
 * API, stood in for what the load reaches of it; on zen-fs's in-memory filesystem.
 *
 *   node --import tsx --test test/project-load.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createHub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import { fs } from "@zenfs/core";

const { openProject, serveOrigin } = await import("../workbench/project.ts");

const ROOT = "/workspace";
const log = { "info": () => undefined, "warn": () => undefined, "error": () => undefined, "span": async (_name, _attrs, body) => body({ "info": () => undefined, "end": () => undefined }) };
const vscode = {
	"Uri": { "file": (path) => ({ "path": path }) },
	"TabInputText": class {},
	"window": { "tabGroups": { "all": [], "close": async () => undefined }, "showTextDocument": async () => undefined },
	"commands": { "executeCommand": async () => undefined },
	"workspace": {
		"openTextDocument": async () => ({}),
		"fs": {
			"readDirectory": async ({ path }) => fs.readdirSync(path).map((name) => [name, fs.statSync(`${path}/${name}`).isDirectory() ? 2 : 1]),
			"delete": async ({ path }) => {
				fs.rmSync(path, { "recursive": true });
			},
			"writeFile": async ({ path }, bytes) => {
				fs.writeFileSync(path, bytes);
			}
		}
	}
};
const CONFIG = "[remote \"origin\"]\n\turl = https://github.com/someone/thing.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n";

test("a load marks itself while it writes, and a mark left behind makes the workspace no repository's", async () => {
	await fs.promises.rm(ROOT, { "recursive": true, "force": true });
	await fs.promises.mkdir(ROOT, { "recursive": true });

	const hub = createHub({ "id": "workbench" });
	const origin = async () => createRpcClient(hub).request("git.origin", undefined, { "timeoutMs": 5000 });
	const files = [{ "path": `${ROOT}/.git/HEAD`, "contents": "ref: refs/heads/main\n" }, { "path": `${ROOT}/.git/config`, "contents": CONFIG }, { "path": `${ROOT}/a.txt`, "contents": "a\n" }];

	serveOrigin(hub, log, ROOT);
	await openProject(vscode, ROOT, log, { "files": files, "replace": true });

	assert.equal(fs.existsSync(`${ROOT}/.silo/local/loading`), false, "no mark once its files are all written");
	assert.deepEqual(await origin(), { "owner": "someone", "repo": "thing", "branch": "main" });

	// (a load cut short after its .git/config: here by a file it can't write, as a closed browser's would be by never
	// writing the rest)
	await assert.rejects(openProject(vscode, ROOT, log, { "files": [...files, { "path": `${ROOT}/a.txt/b.txt`, "contents": "b\n" }], "replace": true }));
	assert.equal(fs.existsSync(`${ROOT}/.git/config`), true);
	assert.equal(fs.existsSync(`${ROOT}/.silo/local/loading`), true, "marked before its files");
	assert.equal(await origin(), null, "half there: no repository's");
});
