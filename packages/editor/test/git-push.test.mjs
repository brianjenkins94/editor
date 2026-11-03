/**
 * A branch pushed to GitHub and brought up to it, through the shell (workbench/git-push.ts, shared/git-remote.ts): the
 * workspace's git on zen-fs's in-memory filesystem makes a remote's requests, and each crosses the hub whole as
 * `git.remote` to the shell, which sends it. The shell here hands each to `git http-backend` over a bare repository on
 * disk, as GitHub would answer it — so what's pushed is checked with git itself. And the branches, made and switched to.
 *
 *   node --import tsx --test test/git-push.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";

import { createHub, createRpcClient, serve } from "@brianjenkins94/hub";
import { fs } from "@zenfs/core";
import { setConfig } from "isomorphic-git";

const engine = await import("../workbench/git-engine.ts");
const { installGitPush } = await import("../workbench/git-push.ts");

const DIR = "/workspace";
const ORIGIN = "https://github.com/someone/repo.git";
const AUTHOR = { "name": "test", "email": "test@localhost" };
const quiet = { "info": () => undefined, "warn": () => undefined, "error": () => undefined };

const root = mkdtempSync(path.join(tmpdir(), "git-push-"));
const bare = path.join(root, "repo.git");
const git = (...args) => execFileSync("git", args, { "encoding": "utf8", "env": { ...process.env, "GIT_AUTHOR_NAME": "them", "GIT_AUTHOR_EMAIL": "them@localhost", "GIT_COMMITTER_NAME": "them", "GIT_COMMITTER_EMAIL": "them@localhost" } }).trim();

after(() => {
	rmSync(root, { "recursive": true, "force": true });
});

/** One of a remote's requests answered as GitHub would: `git http-backend` (CGI) over the bare repository. */
async function backend({ url, method, headers, body }) {
	const { pathname, search } = new URL(url);
	const child = spawn("git", ["http-backend"], {
		"env": {
			...process.env,
			"GIT_PROJECT_ROOT": root,
			"GIT_HTTP_EXPORT_ALL": "1",
			"PATH_INFO": pathname.replace(/^\/someone/u, ""),
			"QUERY_STRING": search.slice(1),
			"REQUEST_METHOD": method,
			"CONTENT_TYPE": Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "",
			"REMOTE_USER": "someone"
		}
	});
	const chunks = [];

	child.stdout.on("data", (chunk) => chunks.push(chunk));
	child.stdin.end(body === undefined ? undefined : Buffer.from(body));
	await new Promise((resolve) => {
		child.on("close", resolve);
	});

	const output = Buffer.concat(chunks);
	const split = output.indexOf("\r\n\r\n");
	const head = output.subarray(0, split).toString().split("\r\n").map((line) => line.split(/:\s*/u));
	const status = Number(head.find(([name]) => name === "Status")?.[1].split(" ")[0] ?? 200);

	return { "status": status, "statusText": "", "headers": Object.fromEntries(head.filter(([name]) => name !== "Status").map(([name, value]) => [name.toLowerCase(), value])), "body": new Uint8Array(output.subarray(split + 4)) };
}

/** The workbench's serves on a hub, the shell's `git.remote` answering them (`refuse`, a status and its body, for a push). */
function editor({ refuse } = {}) {
	const hub = createHub({ "id": "workbench" });
	const sent = [];

	serve(hub, "git.remote", async (request) => {
		sent.push(request.url);

		if (refuse !== undefined && request.url.endsWith("git-receive-pack")) {
			return { "status": refuse.status, "statusText": "Forbidden", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(refuse.body) };
		}

		return backend(request);
	});
	installGitPush(hub, quiet);

	return { "rpc": createRpcClient(hub), "sent": sent, "changed": (() => {
		let count = 0;

		hub.subscribe("git.changed", () => {
			count += 1;
		});

		return () => count;
	})() };
}

const write = async (file, text) => fs.promises.writeFile(`${DIR}/${file}`, text);
const read = async (file) => fs.promises.readFile(`${DIR}/${file}`, "utf8");

beforeEach(async () => {
	rmSync(bare, { "recursive": true, "force": true });
	git("init", "--quiet", "--bare", "--initial-branch=main", bare);
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(DIR, { "recursive": true });
	engine.setAuthor(async () => AUTHOR);
	await engine.ensureRepo();
	// (as a clone leaves it: where, and what a fetch from there brings)
	await setConfig({ "fs": fs, "dir": DIR, "path": "remote.origin.url", "value": ORIGIN });
	await setConfig({ "fs": fs, "dir": DIR, "path": "remote.origin.fetch", "value": "+refs/heads/*:refs/remotes/origin/*" });
	await write("a.txt", "one\n");
	await engine.commitAll("first");
});

test("a branch pushed to the repository it was cloned from: its commits there, each request through the shell", async () => {
	const { rpc, sent } = editor();
	const pushed = await rpc.request("git.push", {}, { "timeoutMs": 30_000 });

	assert.deepEqual(pushed, { "ref": "main", "ok": true, "url": ORIGIN });
	assert.equal(git("--git-dir", bare, "rev-parse", "main"), await engine.headCommit());
	assert.equal(git("--git-dir", bare, "show", "main:a.txt"), "one");
	assert.ok(sent.length >= 2 && sent.every((url) => url.startsWith(ORIGIN + "/")), "the remote's requests, each to the origin");
});

test("a pull brings the branch up to the repository's: its commit here, its files written, git.changed said", async () => {
	const { rpc, changed } = editor();

	await rpc.request("git.push", {}, { "timeoutMs": 30_000 });

	const clone = path.join(root, "clone");

	rmSync(clone, { "recursive": true, "force": true });
	git("clone", "--quiet", bare, clone);
	execFileSync("sh", ["-c", "echo two >> a.txt && echo new > b.txt"], { "cwd": clone });
	git("-C", clone, "add", ".");
	git("-C", clone, "commit", "--quiet", "-m", "theirs");
	git("-C", clone, "push", "--quiet", "origin", "main");

	const before = changed();
	const pulled = await rpc.request("git.pull", {}, { "timeoutMs": 30_000 });

	assert.equal(pulled.outcome, "fast-forwarded");
	assert.equal(pulled.to, git("--git-dir", bare, "rev-parse", "main"));
	assert.deepEqual([await read("a.txt"), await read("b.txt")], ["one\ntwo\n", "new\n"]);
	assert.equal(changed() - before, 1);
	assert.equal((await rpc.request("git.pull", {}, { "timeoutMs": 30_000 })).outcome, "up to date");
});

test("a branch made at HEAD, then switched to; a push of it makes it there", async () => {
	const { rpc } = editor();

	assert.deepEqual((await rpc.request("git.branch", { "name": "feature" })).all.toSorted(), ["feature", "main"]);
	assert.equal((await rpc.request("git.checkout", { "name": "feature" })).current, "feature");
	assert.equal((await rpc.request("git.checkout", { "name": "other", "create": true })).current, "other");
	await assert.rejects(rpc.request("git.checkout", {}), /needs a branch name/u);

	await write("a.txt", "one, on other\n");
	await engine.commitAll("on other");
	assert.equal((await rpc.request("git.push", {}, { "timeoutMs": 30_000 })).ref, "other");
	assert.equal(git("--git-dir", bare, "show", "other:a.txt"), "one, on other");
});

test("a refused push says the remote's reason, not only its status", async () => {
	const { rpc } = editor({ "refuse": { "status": 403, "body": "Permission to someone/repo.git denied to you." } });

	await assert.rejects(rpc.request("git.push", {}, { "timeoutMs": 30_000 }), /Permission to someone\/repo\.git denied/u);
});

test("a workspace that isn't a GitHub repository's has nowhere to push or pull", async () => {
	const { rpc } = editor();

	await setConfig({ "fs": fs, "dir": DIR, "path": "remote.origin.url", "value": undefined });
	await assert.rejects(rpc.request("git.push", {}), /nowhere to push/u);
	await assert.rejects(rpc.request("git.pull", {}), /nothing to bring it up to/u);
});
