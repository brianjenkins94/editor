/**
 * The terminal's file system (terminal/fs.ts) under a real just-bash: what a redirect writes reaches the workspace as
 * the bytes the command put out. `vscode.workspace.fs` is a map of paths to bytes here.
 *
 *   node --import tsx --test test/terminal-fs.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { createWorkspaceTerminalFs } from "../workbench/terminal/fs.ts";

/** Enough of the vscode api for the terminal's fs: files and directories by path. */
function workspace() {
	const files = new Map();
	const directories = new Set(["/", "/workspace"]);
	const missing = () => Object.assign(new Error("FileNotFound"), { "code": "FileNotFound" });
	const api = {
		"Uri": {
			"file": (path) => ({ "path": path })
		},
		"workspace": {
			"fs": {
				"readFile": async ({ path }) => {
					if (!files.has(path)) {
						throw missing();
					}

					return files.get(path).slice();
				},
				"writeFile": async ({ path }, bytes) => {
					files.set(path, Uint8Array.from(bytes));
				},
				"stat": async ({ path }) => {
					if (files.has(path)) {
						return { "type": 1, "mtime": 0, "size": files.get(path).length };
					}

					if (directories.has(path)) {
						return { "type": 2, "mtime": 0, "size": 0 };
					}

					throw missing();
				},
				"createDirectory": async ({ path }) => {
					directories.add(path);
				},
				"readDirectory": async ({ path }) => [
					...files.keys()
				].filter((file) => file.startsWith(`${path}/`)).map((file) => [
					file.slice(path.length + 1),
					1
				])
			}
		}
	};

	return {
		"files": files,
		"bash": new Bash({
			"fs": createWorkspaceTerminalFs(api),
			"cwd": "/workspace"
		})
	};
}

// A 1×1 PNG: its signature starts with 0x89, which UTF-8 writes as c2 89.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("base64 -d > x.png writes the PNG's bytes, not them UTF-8-encoded", async () => {
	const { files, bash } = workspace();
	const result = await bash.exec(`echo ${png.toString("base64")} | base64 -d > x.png`);

	assert.equal(result.exitCode, 0, result.stderr);
	assert.deepEqual(Buffer.from(files.get("/workspace/x.png")), png);
});

test(">> appends bytes as they are, and cat reads them back the same", async () => {
	const { files, bash } = workspace();
	const half = png.length >> 1;

	await bash.exec(`echo ${png.subarray(0, half).toString("base64")} | base64 -d > x.png`);
	await bash.exec(`echo ${png.subarray(half).toString("base64")} | base64 -d >> x.png`);
	assert.deepEqual(Buffer.from(files.get("/workspace/x.png")), png);

	await bash.exec("cat x.png > y.png");
	assert.deepEqual(Buffer.from(files.get("/workspace/y.png")), png);
	assert.equal((await bash.exec("base64 -w0 y.png")).stdout.trim(), png.toString("base64"));
});

test("text still goes in as UTF-8", async () => {
	const { files, bash } = workspace();

	await bash.exec("echo héllo > a.txt && echo ✓ >> a.txt");
	assert.equal(Buffer.from(files.get("/workspace/a.txt")).toString("utf8"), "héllo\n✓\n");
	assert.equal((await bash.exec("cat a.txt")).stdout, "héllo\n✓\n");
});
