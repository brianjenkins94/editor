/**
 * The filesystems' boundaries, counted (shared/fs-boundaries.ts) and their callers named (shared/fs-caller.ts): each
 * call adds to its boundary, operation and caller's calls, time, distinct paths and bytes, as the `fs` gauge reads them;
 * a library given `callerFs` is named for every call it makes — its promise calls too, answered by their synchronous
 * twins, so a store reached after an await inside the library's fs is still its; and who in VS Code called its file
 * service is the class past it on the call's stack; and a trace sees each call, one at a time, while it's open.
 *
 *   node --import tsx --test test/fs-boundaries.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { countCall, fsGauge, timeCall, traceCalls } = await import("../shared/fs-boundaries.ts");
const { asCaller, callerFs, fsCaller, vscodeCaller } = await import("../shared/fs-caller.ts");

test("a call adds to its boundary, operation and caller: calls, time, distinct paths and bytes", async () => {
	countCall("probe", "stat", "someone", 2, "/workspace/a");
	countCall("probe", "stat", "someone", 3, "/workspace/a");
	countCall("probe", "stat", "someone", 1, "/workspace/b", 10);
	timeCall("probe", "read", "someone", "/workspace/a", () => "sync");
	assert.equal(await timeCall("probe", "read", "someone", "/workspace/c", async () => "async"), "async");
	assert.throws(() => timeCall("probe", "read", "someone", undefined, () => { throw new Error("thrown"); }), /thrown/u);

	const gauge = fsGauge();

	assert.deepEqual([gauge["probe.stat.someone.calls"], gauge["probe.stat.someone.ms"], gauge["probe.stat.someone.paths"], gauge["probe.stat.someone.bytes"]], [3, 6, 2, 10]);
	assert.deepEqual([gauge["probe.read.someone.calls"], gauge["probe.read.someone.paths"]], [3, 2], "a thrown call counts too");
});

test("a caller is named for its call's length, nested ones restored; callerFs names a library's every call", async () => {
	const seen = [];
	const fs = {
		"statSync": (path) => {
			seen.push(["statSync", path, fsCaller()]);

			return { "path": path };
		},
		"promises": {
			// (a promise twin that would reach the store after an await, past the caller's name)
			"stat": async (path) => {
				await Promise.resolve();
				seen.push(["promises.stat", path, fsCaller()]);
			},
			"readdir": async (path) => {
				await Promise.resolve();
				seen.push(["promises.readdir", path, fsCaller()]);

				return [];
			}
		}
	};
	const git = callerFs(fs, "git");

	asCaller("outer", () => {
		assert.equal(fsCaller(), "outer");
		asCaller("inner", () => assert.equal(fsCaller(), "inner"));
		assert.equal(fsCaller(), "outer");
	});
	assert.equal(fsCaller(), undefined);

	git.statSync("/workspace/a");
	assert.deepEqual(await git.promises.stat("/workspace/b"), { "path": "/workspace/b" }, "answered by statSync");
	await git.promises.readdir("/workspace/c");

	assert.deepEqual(seen, [["statSync", "/workspace/a", "git"], ["statSync", "/workspace/b", "git"], ["promises.readdir", "/workspace/c", undefined]], "with no twin, the promise call is the library's own — named only until its first await");
});

test("who in VS Code asked: the class past its file service on the stack, through awaits; `vscode` with none", async () => {
	class FileService {
		async resolve(read) {
			await Promise.resolve();

			return read();
		}
	}

	class ExplorerService {
		async refresh(files, read) {
			return await files.resolve(read);
		}
	}

	assert.equal(await new ExplorerService().refresh(new FileService(), () => vscodeCaller()), "ExplorerService");
	assert.equal(vscodeCaller(), "vscode", "no file service on the stack");
});

test("a trace sees each call while it's open, and none once it's stopped", () => {
	const seen = [];
	const stop = traceCalls((call) => seen.push(call));

	countCall("probe", "write", "someone", 1.5, "/workspace/traced", 7);
	stop();
	countCall("probe", "write", "someone", 1, "/workspace/after");

	assert.deepEqual(seen, [{ "boundary": "probe", "operation": "write", "caller": "someone", "ms": 1.5, "path": "/workspace/traced", "bytes": 7 }]);
});
