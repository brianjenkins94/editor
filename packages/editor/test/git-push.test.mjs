/**
 * A branch pushed to GitHub and brought up to it, through the shell (workbench/git-push.ts, shared/git-remote.ts): the
 * workspace's git on zen-fs's in-memory filesystem makes a remote's requests, and each crosses the hub whole as
 * `git.remote` to the shell, which sends it. The shell here hands each to `git http-backend` over a bare repository on
 * disk, as GitHub would answer it — so what's pushed is checked with git itself. And the branches, made and switched to,
 * and a shallow clone's history fetched deeper.
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
import { clone, setConfig } from "isomorphic-git";

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
	const http = installGitPush(hub, quiet);

	return { "rpc": createRpcClient(hub), "http": http, "sent": sent, "changed": (() => {
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

test("a fetch says how many commits the repository's branch has that this one doesn't, for a person to bring in", async () => {
	const { rpc } = editor();

	await rpc.request("git.push", {}, { "timeoutMs": 30_000 });

	const clone = path.join(root, "clone");

	rmSync(clone, { "recursive": true, "force": true });
	git("clone", "--quiet", bare, clone);

	for (const each of ["two", "three"]) {
		execFileSync("sh", ["-c", `echo ${each} >> a.txt`], { "cwd": clone });
		git("-C", clone, "commit", "--quiet", "-am", each);
	}

	git("-C", clone, "push", "--quiet", "origin", "main");

	const head = await engine.headCommit();
	const fetched = await rpc.request("git.fetch", {}, { "timeoutMs": 30_000 });

	assert.equal(fetched.behind, 2);
	assert.equal(await engine.headCommit(), head, "a fetch leaves the branch where it was");
	assert.equal((await rpc.request("git.pull", {}, { "timeoutMs": 30_000 })).outcome, "fast-forwarded");
	assert.equal((await rpc.request("git.fetch", {}, { "timeoutMs": 30_000 })).behind, 0);
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

test("a clone one commit deep: fetch deepens its history by as many as asked, unshallow all of it, the branch left where it is", async () => {
	const { rpc, http } = editor();
	const source = path.join(root, "source");

	rmSync(source, { "recursive": true, "force": true });
	git("init", "--quiet", "--initial-branch=main", source);

	for (const each of ["one", "two", "three", "four"]) {
		execFileSync("sh", ["-c", `echo ${each} > a.txt`], { "cwd": source });
		git("-C", source, "add", ".");
		git("-C", source, "commit", "--quiet", "-m", each);
	}

	git("-C", source, "push", "--quiet", "--force", bare, "main");
	// (as a repository loaded from GitHub is: one commit deep)
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await clone({ "fs": fs, "http": http, "dir": DIR, "url": ORIGIN, "corsProxy": "", "depth": 1, "singleBranch": true });

	const head = await engine.headCommit();

	assert.equal((await engine.history()).length, 1);
	assert.deepEqual(await engine.shallowEnds(), [head]);

	const deepened = await rpc.request("git.fetch", { "deepen": 2 }, { "timeoutMs": 30_000 });

	assert.deepEqual(deepened, { "ref": "main", "tip": head, "commits": 3, "shallow": true, "behind": 0, "url": ORIGIN });
	assert.deepEqual((await engine.history()).map((entry) => entry.message.trim()), ["four", "three", "two"]);

	const all = await rpc.request("git.fetch", { "unshallow": true }, { "timeoutMs": 30_000 });

	assert.deepEqual([all.commits, all.shallow], [4, false]);
	assert.equal(await engine.headCommit(), head, "the branch stays where it was");
	await assert.rejects(rpc.request("git.fetch", { "deepen": 0 }), /more than none/u);
});

test("a fetch that doesn't move the branch tells the remote what it last fetched: the next sends only what's new", async () => {
	const { http } = editor();
	const source = path.join(root, "source");
	const commitBig = (name) => {
		// (incompressible, so a pack's size says which files it carries)
		execFileSync("sh", ["-c", `head -c 100000 /dev/urandom | base64 > ${name}`], { "cwd": source });
		git("-C", source, "add", ".");
		git("-C", source, "commit", "--quiet", "-m", name);
		git("-C", source, "push", "--quiet", "--force", bare, "main");
	};
	const newestPack = async () => {
		const packs = (await fs.promises.readdir(`${DIR}/.git/objects/pack`)).filter((name) => name.endsWith(".pack"));
		const sized = await Promise.all(packs.map(async (name) => ({ "name": name, "stat": await fs.promises.stat(`${DIR}/.git/objects/pack/${name}`) })));

		return sized.toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0].stat.size;
	};

	rmSync(source, { "recursive": true, "force": true });
	git("init", "--quiet", "--initial-branch=main", source);
	commitBig("first.txt");
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await clone({ "fs": fs, "http": http, "dir": DIR, "url": ORIGIN, "corsProxy": "", "depth": 1, "singleBranch": true });
	commitBig("second.txt");
	await engine.fetchBranch(http, ORIGIN, "main");
	commitBig("third.txt");
	await engine.fetchBranch(http, ORIGIN, "main");

	// (the third's file alone, ~135 KB as base64 — not the second's again beside it)
	assert.ok(await newestPack() < 200_000, `the last fetch's pack is ${String(await newestPack())} bytes`);
	assert.equal((await engine.history()).length, 1, "the branch left where it was");
});

test("a branch the clone hasn't fetched is checked out from the repository's: fetched one commit deep, then switched to", async () => {
	const { rpc, http } = editor();
	const source = path.join(root, "source");

	rmSync(source, { "recursive": true, "force": true });
	git("init", "--quiet", "--initial-branch=main", source);
	execFileSync("sh", ["-c", "echo main > a.txt"], { "cwd": source });
	git("-C", source, "add", ".");
	git("-C", source, "commit", "--quiet", "-m", "main");
	git("-C", source, "switch", "--quiet", "-c", "other");
	execFileSync("sh", ["-c", "echo other > a.txt"], { "cwd": source });
	git("-C", source, "commit", "--quiet", "-am", "other");
	git("-C", source, "push", "--quiet", "--force", bare, "main", "other");
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await clone({ "fs": fs, "http": http, "dir": DIR, "url": ORIGIN, "corsProxy": "", "depth": 1, "singleBranch": true, "ref": "main" });

	assert.deepEqual((await engine.branches()).all, ["main"]);
	assert.equal((await rpc.request("git.checkout", { "name": "other" }, { "timeoutMs": 30_000 })).current, "other");
	assert.equal(await read("a.txt"), "other\n");
	await assert.rejects(rpc.request("git.checkout", { "name": "nowhere" }, { "timeoutMs": 30_000 }));
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
	await assert.rejects(rpc.request("git.fetch", {}), /nothing to fetch from/u);
});
