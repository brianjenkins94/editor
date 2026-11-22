/**
 * The git service's walks of the working tree (workbench/git-service.ts): askers that overlap share one, so long as nothing
 * changed since it began. Its commit is a change too: a walk begun before it answered whoever asked after it, so the
 * Source Control view kept listing a file just committed (CI, source-control.spec, 2026-11-19). VS Code's API, stood in for what the service reaches of it; on zen-fs's in-memory
 * filesystem.
 *
 *   node --import tsx --test test/git-service.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createHub, serve } from "@brianjenkins94/hub";
import { fs } from "@zenfs/core";

const engine = await import("../workbench/git-engine.ts");
const { installGitService } = await import("../workbench/git-service.ts");

const DIR = "/workspace";
const event = () => () => ({ "dispose": () => undefined });
/** The commands the service registers, by name. */
const commands = new Map();
const vscode = {
	"Uri": { "file": (path) => ({ "path": path }) },
	"commands": {
		"registerCommand": (name, handler) => {
			commands.set(name, handler);

			return { "dispose": () => undefined };
		}
	},
	"workspace": {
		"fs": { "readFile": async ({ path }) => fs.promises.readFile(path) },
		"onDidSaveTextDocument": event(),
		"createFileSystemWatcher": () => ({ "onDidChange": event(), "onDidCreate": event(), "onDidDelete": event() })
	}
};

/** A logger that counts the walks it's asked to span. */
function counting() {
	const walks = { "count": 0 };
	const span = { "info": () => undefined, "end": () => undefined, "error": () => undefined };
	const log = {
		"info": () => undefined,
		"warn": () => undefined,
		"error": () => undefined,
		"span": async (name, _attrs, body) => {
			walks.count += name === "editor.workbench.git-service.walk" ? 1 : 0;

			return body(span);
		}
	};

	return { "log": log, "walks": walks };
}

test("a walk begun before a commit doesn't answer who asks after it begins: they walk again", async () => {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(DIR, { "recursive": true });
	await engine.ensureRepo();
	await fs.promises.writeFile(`${DIR}/a.txt`, "a\n");

	const hub = createHub({ "id": "workbench" });

	// (the shell's answer to who a commit is by)
	serve(hub, "git.identity", async () => ({ "name": "test", "email": "test@localhost" }));

	const { log, walks } = counting();
	const service = installGitService(vscode, hub, log);

	// (two askers at once share a walk)
	const first = service.status();
	const alongside = service.status();

	assert.equal(walks.count, 1);

	// (a commit begun while that walk is out — the Source Control view's, from its input box — and asked again)
	const committing = commands.get("editor.git.commit")("a");
	const after = service.status();

	assert.equal(walks.count, 2, "asked after the commit began, it walks again");
	await Promise.all([first, alongside, committing, after]);
});

test("after a commit, the committed file isn't listed", async () => {
	const hub = createHub({ "id": "workbench" });

	serve(hub, "git.identity", async () => ({ "name": "test", "email": "test@localhost" }));

	const service = installGitService(vscode, hub, counting().log);

	await fs.promises.writeFile(`${DIR}/b.txt`, "b\n");
	assert.ok((await service.status()).files.some(({ path }) => path === "b.txt"));
	await commands.get("editor.git.commit")("b");
	assert.deepEqual((await service.status()).files.filter(({ path }) => path === "b.txt"), []);
});

test("a commit runs its step first (the touched tests, test-runs.ts's), says what it said, and commits whatever the step makes of it", async () => {
	const hub = createHub({ "id": "workbench" });

	serve(hub, "git.identity", async () => ({ "name": "test", "email": "test@localhost" }));

	const service = installGitService(vscode, hub, counting().log);
	const order = [];

	await fs.promises.writeFile(`${DIR}/c.txt`, "c\n");
	service.beforeCommit(async () => {
		order.push("tests");

		return "Ran 1.";
	});

	const made = await commands.get("editor.git.commit")("c");

	assert.equal(made.tests, "Ran 1.");
	assert.deepEqual(order, ["tests"]);

	// (a step that throws doesn't stop the commit: it says why)
	await fs.promises.writeFile(`${DIR}/d.txt`, "d\n");
	service.beforeCommit(async () => {
		throw new Error("no debugger");
	});
	assert.equal((await commands.get("editor.git.commit")("d")).tests, "The tests a commit runs first didn't run: no debugger");
	assert.deepEqual((await service.status()).files.filter(({ path }) => path === "d.txt"), []);
});
