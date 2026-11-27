import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { recordReach } from "../build/reach-record.ts";

function repository(files) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "reach-record-"));

	execFileSync("git", ["init", "-q"], { "cwd": repo });

	for (const [file, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { "recursive": true });
		fs.writeFileSync(path.join(repo, file), text);
	}

	execFileSync("git", ["add", "-A"], { "cwd": repo });

	return repo;
}

const entry = (paths, tests) => ({ "status": "active", "why": "w", "since": "2026-10-01", "what": "W.", "paths": paths, ...tests === undefined ? {} : { "tests": tests } });
const statements = (from) => Array.from({ "length": 25 }, (_, index) => [from + index]);

test("each test against what its file declares, from a folder of its suite's reach, kept for silo check", () => {
	const reach = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
	const repo = repository({
		".silo/features.json": JSON.stringify({ "Notes": entry(["notes.ts"], ["test/notes.mjs"]), "Git": entry(["git.ts"]) }),
		"notes.ts": "",
		"git.ts": "",
		"test/notes.mjs": ""
	});

	fs.writeFileSync(path.join(reach, "notes.json"), JSON.stringify({ "stray": { "git.ts": statements(0) }, "own": { "notes.ts": statements(100) } }));

	const told = recordReach(reach, repo, "2026-11-25");

	assert.match(told, /\| 0% \| 25 \| notes\.mjs: stray \| Git 25 \|/u);
	assert.match(told, /\| 100% \| 25 \| notes\.mjs: own \| Notes 25 \|/u);
	assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".silo/last-run/reach.json"), "utf8")).tests.length, 2);

	fs.writeFileSync(path.join(reach, "nowhere.json"), "{}");
	assert.throws(() => recordReach(reach, repo), /nowhere\.json: expected one test file named nowhere, found 0/u);
});

test("a suite that runs other test files, each its test named by it, has each test its file's", () => {
	const reach = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
	const repo = repository({
		".silo/features.json": JSON.stringify({ "Notes": entry(["notes.ts"], ["test/specs/notes.spec.mjs"]), "Runner": entry(["runner.ts"], ["test/specs.mjs"]) }),
		"notes.ts": "",
		"runner.ts": "",
		"test/specs.mjs": "",
		"test/specs/notes.spec.mjs": ""
	});

	fs.writeFileSync(path.join(reach, "specs.json"), JSON.stringify({ "notes.spec.mjs": { "notes.ts": statements(0) }, "unknown.spec.mjs": { "runner.ts": statements(100) } }));

	const told = recordReach(reach, repo);

	assert.match(told, /\| 100% \| 25 \| notes\.spec\.mjs: notes\.spec\.mjs \| Notes 25 \|/u);
	assert.match(told, /\| 100% \| 25 \| specs\.mjs: unknown\.spec\.mjs \| Runner 25 \|/u, "a test named by no file there stays the suite's");
});

test("the editor's reach, each test file's at its own path, as its runs keep them (.silo/local/reach/)", () => {
	const reach = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
	const repo = repository({
		".silo/features.json": JSON.stringify({ "Notes": entry(["src/notes.ts"], ["test/notes.test.mjs"]), "Git": entry(["src/git.ts"]) }),
		"src/notes.ts": "",
		"src/git.ts": "",
		"test/notes.test.mjs": ""
	});

	fs.mkdirSync(path.join(reach, "test"));
	const each = (from) => Array.from({ "length": 25 }, (_, index) => [from + index, from + index + (index % 3)]);

	fs.writeFileSync(path.join(reach, "test", "notes.test.mjs.json"), JSON.stringify({ "test/notes.test.mjs › stray": { "src/git.ts": each(0) }, "test/notes.test.mjs › own": { "src/notes.ts": each(100) } }));

	const told = recordReach(reach, repo, "2026-11-26", "0123abc");

	assert.match(told, /\| 0% \| 25 \| notes\.test\.mjs: stray \| Git 25 \|/u, "a statement each, [line, endLine], not each line it spans");
	assert.match(told, /\| 100% \| 25 \| notes\.test\.mjs: own \| Notes 25 \|/u);

	const record = JSON.parse(fs.readFileSync(path.join(repo, ".silo/last-run/reach.json"), "utf8"));

	assert.deepEqual([record.version, record.commit, Object.keys(record.files["src/notes.ts"]).length, record.files["src/notes.ts"]["100"]], [3, "0123abc", 25, [0]], "by statement: the line each starts on, and which tests ran it");
});
