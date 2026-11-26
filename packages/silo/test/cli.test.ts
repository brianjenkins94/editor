import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";

import { installArgs, untested } from "../src/cli.ts";
import { filesOf, headOf, repoOf } from "../src/git.ts";

const CLI = path.join(import.meta.dirname, "../src/cli.ts");

/** A repository with a commit per day: each `files` is what changes that day (`null` deletes). */
async function repository(days: Record<string, Record<string, string | null>>): Promise<string> {
	const repo = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-cli-"));
	const git = (args: string[], date?: string): string => execFileSync("git", args, { "cwd": repo, "encoding": "utf8", "env": { ...process.env, ...date === undefined ? {} : { "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date } } });

	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "silo@example.com"]);
	git(["config", "user.name", "silo"]);

	for (const [day, files] of Object.entries(days)) {
		for (const [file, text] of Object.entries(files)) {
			const target = path.join(repo, file);

			if (text === null) {
				await fs.rm(target);
			} else {
				await fs.mkdir(path.dirname(target), { "recursive": true });
				fs.writeFileSync(target, text);
			}
		}

		git(["add", "-A"]);
		git(["commit", "-q", "-m", "wip"], day + "T12:00:00Z"); // the message is never read
	}

	return repo;
}

test("git: read without spawning it (isomorphic-git, as in the editor's debugger) gives what git gives", async () => {
	const fresh = await repository({ "2026-10-01": { ".gitignore": "ignored.txt\nbuild/\n*.tmp\n", "a/tracked.ts": "1", "b.md": "2", "c/.gitignore": "*.log\n!keep.log\ncache/\n!special.tmp\n" } });
	const write = async (file: string, text: string): Promise<void> => {
		await fs.mkdir(path.dirname(path.join(fresh, file)), { "recursive": true });
		fs.writeFileSync(path.join(fresh, file), text);
	};

	await write("untracked.ts", "3");
	await write("ignored.txt", "4");
	await write("build/out.js", "5");
	// (a folder's own rules: relative to it, a negation over its parent's, a folder-only pattern; and the repository's excludes)
	await write("c/d/drop.log", "6");
	await write("c/keep.log", "7");
	await write("c/cache/x.js", "8");
	await write("c/d/cache.js", "9");
	await write("c/special.tmp", "10");
	await write("other.tmp", "11");
	await write("e/new/deep.ts", "12");
	await write("excluded.md", "13");
	await write(".git/info/exclude", "excluded.md\n");

	const read = async (): Promise<unknown> => ({ "repo": await repoOf(path.join(fresh, "a")), "tracked": await filesOf(fresh), "all": await filesOf(fresh, { "untracked": true }), "head": await headOf(fresh) });
	const spawned = await read();

	process.env["SILO_GIT"] = "isomorphic";

	try {
		assert.deepEqual(await read(), spawned);
	} finally {
		delete process.env["SILO_GIT"];
	}

	assert.deepEqual((spawned as { "all": string[] }).all, [".gitignore", "a/tracked.ts", "b.md", "c/.gitignore", "c/d/cache.js", "c/keep.log", "c/special.tmp", "e/new/deep.ts", "untracked.ts"]);
});

test("silo install, the first time: .silo/ started, and the baseline, holding the join — what the code's use of each package reaches — and says what grew there", async () => {
	const project = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-join-"));
	const write = async (file: string, text: string): Promise<void> => {
		await fs.mkdir(path.dirname(path.join(project, file)), { "recursive": true });
		fs.writeFileSync(path.join(project, file), text);
	};
	const bin = path.join(project, "bin");
	// (a package manager that installs nothing: what's there is what's synced)
	const init = (): { "stdout": string; "stderr": string } => spawnSync(process.execPath, ["--import", "tsx", CLI, "install", "--project", project], { "encoding": "utf8", "env": { ...process.env, "PATH": `${bin}${path.delimiter}${process.env["PATH"]!}` } });

	await write("bin/npm", "#!/bin/sh\nexit 0\n");
	execFileSync("chmod", ["755", path.join(bin, "npm")]);

	execFileSync("git", ["init", "-q"], { "cwd": project });
	await write("package.json", JSON.stringify({ "name": "app", "private": true, "type": "module" }));
	await write("node_modules/kit/package.json", JSON.stringify({ "name": "kit", "version": "3.0.0", "type": "module", "exports": "./index.js" }));
	await write("node_modules/kit/index.js", "export { save } from \"./save.js\";\nexport { ping } from \"./ping.js\";\n");
	await write("node_modules/kit/save.js", "import { writeFileSync } from \"node:fs\";\nexport const save = (p, d) => writeFileSync(p, d);\n");
	await write("node_modules/kit/ping.js", "export const ping = (u) => fetch(u);\n");
	await write("main.js", "import { save } from \"kit\";\nsave(\"a\", \"b\");\n");

	assert.match(init().stdout, /^Made \S*\.silo\/baseline\.json: 1 imports, 1 packages/mu);
	assert.ok(fs.existsSync(path.join(project, ".silo/.gitattributes")), ".silo/ started");

	const baseline = (): { "join"?: number; "consumer": Record<string, Record<string, { "caps": string[]; "grew"?: Record<string, string> }>>; "packages": Record<string, { "caps": string[] }> } => JSON.parse(fs.readFileSync(path.join(project, ".silo/baseline.json")));

	assert.equal(baseline().join, 1);
	assert.deepEqual(baseline().consumer["."]["kit"].caps, ["fs:write"], "save's slice: not ping's net");
	assert.deepEqual(baseline().packages["kit"].caps, ["fs:write", "net"]);

	await write("main.js", "import { save, ping } from \"kit\";\nsave(\"a\", await ping(\"https://example.com\"));\n");

	const { stderr } = init();

	assert.match(stderr, /your code's use of a package reaches more[^\n]*\n {2}kit: can also net \(ping\)/u);
	assert.deepEqual(baseline().consumer["."]["kit"].grew, { "net": "ping" });

	await fs.rm(project, { "recursive": true, "force": true });
});

test("silo install: nothing published in the last `days` days — `latest` is the latest a week old — but what's pinned exactly", async () => {
	const now = Date.parse("2026-10-13T12:00:00.000Z");
	const project = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-install-"));

	await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ "dependencies": { "rolldown": "1.2.13", "react": "latest" } }));

	assert.deepEqual(installArgs("npm", project, [], 7, now), ["install", "--before=2026-10-06T12:00:00.000Z", "--min-release-age-exclude=rolldown"]);
	assert.deepEqual(installArgs("npm", project, ["react@latest"], 1, now), ["install", "react@latest", "--before=2026-10-12T12:00:00.000Z", "--min-release-age-exclude=rolldown"]);
	assert.deepEqual(installArgs("pnpm", project, [], 7, now), ["install", "--config.minimum-release-age=10080", "--config.minimum-release-age-exclude=rolldown@1.2.13"]);
	// (one asked for at a version is pinned too)
	assert.deepEqual(installArgs("pnpm", project, ["zod@4.1.0"], 7, now), ["add", "zod@4.1.0", "--config.minimum-release-age=10080", "--config.minimum-release-age-exclude=rolldown@1.2.13", "--config.minimum-release-age-exclude=zod@4.1.0"]);
});

test("the command line: silo install runs the project's package manager by that rule, then syncs the baseline; a failed install is a failure", async () => {
	const project = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-install-cli-"));
	const bin = path.join(project, "bin");

	await fs.mkdir(bin);
	await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ "name": "project", "dependencies": {} }));
	// (a package manager that says what it was asked, and fails when asked for a package called `broken`)
	await fs.writeFile(path.join(bin, "npm"), "#!/bin/sh\necho \"$@\" > asked.txt\ncase \"$*\" in *broken*) exit 3;; esac\n");
	execFileSync("chmod", ["755", path.join(bin, "npm")]);
	execFileSync("git", ["init", "-q"], { "cwd": project });

	const install = (...packages: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", CLI, "install", ...packages, "--project", project], { "encoding": "utf8", "env": { ...process.env, "PATH": `${bin}${path.delimiter}${process.env["PATH"]!}` } });
	const ran = install("left-pad");

	assert.equal(ran.status, 0, String(ran.stderr));
	assert.match(String(fs.readFileSync(path.join(project, "asked.txt"))), /^install left-pad --before=\S+/u);
	assert.ok(fs.existsSync(path.join(project, ".silo/baseline.json")), "the baseline synced");
	assert.equal(install("broken").status, 3);

	await fs.rm(project, { "recursive": true, "force": true });
});

test("silo status, then silo check: the ledger's decisions held to the code — drift fails it", async () => {
	const ledgered = await repository({
		"2026-10-20": {
			"README.md": "The old exporter (old-export.ts) is how files leave.\n",
			"notes/package.json": JSON.stringify({ "contributes": { "commands": [{ "command": "notes.add", "title": "Add Note" }, { "command": "notes.ghost", "title": "Ghost" }], "configuration": { "properties": { "notes.size": { "type": "number" }, "notes.unread": { "type": "boolean" } } } } }),
			"notes/extension.ts": "import * as vscode from \"vscode\";\nvscode.commands.registerCommand(\"notes.add\", () => vscode.workspace.getConfiguration(\"notes\").get(\"size\"));\n"
		}
	});
	const silo = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { "encoding": "utf8" });

	const set = silo("status", "old exporter", "removed", "the share sheet replaced it", "--paths", "src/old-export.ts", "--in", "abc1234", "--repo", ledgered);

	assert.equal(set.status, 0, String(set.stderr));
	assert.match(String(set.stdout), /"old exporter" is removed \(since \d{4}-\d\d-\d\d\)/u);
	assert.equal(JSON.parse(fs.readFileSync(path.join(ledgered, ".silo/features.json")))["old exporter"].in, "abc1234");
	assert.equal(silo("status", "half", "experiment", "trying", "--repo", ledgered).status, 1, "an experiment needs an end");

	// (a feature declared, then a way in and a test added to it without restating its status or why)
	assert.equal(silo("status", "Notes", "active", "the core keeps notes", "--what", "Notes beside their code.", "--paths", "notes/extension.ts", "--ways", "command|notes.add", "--repo", ledgered).status, 0);
	assert.equal(silo("status", "Notes", "--ways", "setting|notes.size", "--tests", "notes/test", "--add", "--repo", ledgered).status, 0);

	const notes = JSON.parse(fs.readFileSync(path.join(ledgered, ".silo/features.json")))["Notes"];

	assert.deepEqual([notes.status, notes.why, notes.what, notes.paths, notes.ways, notes.tests], ["active", "the core keeps notes", "Notes beside their code.", ["notes/extension.ts"], ["command|notes.add", "setting|notes.size"], ["notes/test"]]);
	assert.equal(silo("status", "nothing yet", "--repo", ledgered).status, 1, "a new entry says its status and why");
	assert.equal(silo("status", "Notes", "removed", "out", "--repo", ledgered).status, 0);
	assert.equal(JSON.parse(fs.readFileSync(path.join(ledgered, ".silo/features.json")))["Notes"].status, "removed");
	// (taken out again: a declared feature holds every code file to an owner, which isn't what the check below is about)
	fs.writeFileSync(path.join(ledgered, ".silo/features.json"), JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ledgered, ".silo/features.json")))).filter(([name]) => name !== "Notes")), null, "\t"));

	const checked = silo("check", ledgered, "--json");
	const { drift } = JSON.parse(String(checked.stdout)) as { "drift": { "check": string; "entry"?: string; "message": string }[] };

	assert.equal(checked.status, 1, "drift fails it (since 2026-10-25: every check was quiet on this repository)");
	assert.deepEqual(drift.map((each) => [each.check, each.entry ?? each.message]), [
		["removed but documented", "old exporter"],
		["dead end", "command notes.ghost is declared and never registered"],
		["dead end", "setting notes.unread is declared and its code never reads it"]
	]);
	assert.match(String(silo("check", ledgered).stdout), /Drift \(3\):\n {2}removed but documented: "old exporter" was removed \(abc1234\), and README\.md still names it/u);
});

test("silo check: an active feature names its tests, or says why it has none", async () => {
	const repo = await repository({ "2026-10-20": { "notes/add.ts": "export const add = 1;\n", "notes/test/add.test.ts": "import \"../add\";\n" } });
	const silo = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { "encoding": "utf8" });
	const status = (...args: string[]): void => assert.equal(silo("status", "Notes", ...args, "--repo", repo).status, 0);
	const found = (): (string | undefined)[][] => (JSON.parse(String(silo("check", repo, "--json").stdout)) as { "drift": { "check": string; "entry"?: string }[] }).drift.map((each) => [each.check, each.entry]);

	status("active", "the core keeps notes", "--what", "Notes beside their code.", "--paths", "notes");
	assert.deepEqual(found(), [["no tests", "Notes"]]);

	const checked = silo("check", repo);

	assert.equal(checked.status, 1);
	assert.match(String(checked.stdout), /no tests: "Notes" names no tests, so nothing notices[^\n]*\n {4}change the code: test it, and name the test[^\n]*; or the decision: say in its why/u);

	// Named, it has them; and with none, its why says why (a reason, not the words alone).
	status("--tests", "notes/test");
	assert.deepEqual(found(), []);
	assert.equal(silo("check", repo).status, 0);

	const entry = { "since": "2026-10-20", "what": "Notes.", "paths": ["notes"] };

	assert.equal(untested({ "Notes": { ...entry, "status": "active", "why": "core; no tests:" } }).length, 1);
	assert.equal(untested({ "Notes": { ...entry, "status": "active", "why": "core; no tests: it's a workflow, run on each push" } }).length, 0);
	// Only an active feature: not an experiment, a parked one, nor an entry that's only a decision.
	assert.equal(untested({ "Notes": { ...entry, "status": "experiment", "why": "w", "until": "2099-01-01" }, "Old": { ...entry, "status": "parked", "why": "w" }, "A decision": { "status": "active", "why": "w", "since": "2026-10-20", "paths": ["notes"] } }).length, 0);
});

test("prices: another feature's code isn't freed, though no way in reaches it but this one's", async () => {
	const entry = (paths: string[]): unknown => ({ "status": "active", "why": "no tests: a fixture", "since": "2026-10-01", "what": "W.", "paths": paths });
	const fresh = await repository({ "2026-10-01": {
		".silo/features.json": JSON.stringify({ "Switch": entry(["api/switch.ts"]), "Log": entry(["api/log.ts"]), "Routes": entry(["api/index.ts"]) }),
		"api/log.ts": "export function log(): number {\n\treturn stamp();\n}\n\nimport { stamp } from \"./stamp\";\n",
		"api/stamp.ts": "export function stamp(): number {\n\treturn 1;\n}\n",
		"api/only.ts": "export function only(): number {\n\treturn 2;\n}\n",
		"api/switch.ts": "import { log } from \"./log\";\nimport { only } from \"./only\";\n\nexport function turn(): number {\n\treturn log() + only();\n}\n",
		"api/index.ts": "import { log } from \"./log\";\n\nexport function route(): number {\n\treturn log();\n}\n"
	} });
	const silo = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { "encoding": "utf8" });
	const { prices } = JSON.parse(String(silo("check", fresh, "--prices", "--json").stdout)) as { "prices": Record<string, { "files": string[] }> };

	assert.deepEqual(prices["Switch"].files, ["api/only.ts", "api/switch.ts"]);
});
