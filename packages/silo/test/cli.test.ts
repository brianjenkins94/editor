import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";

import { currentFeatures, historyOf, installCommand } from "../src/cli.ts";

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

const manifest = JSON.stringify({ "contributes": { "commands": [{ "command": "notes.add", "title": "Add Note" }] } });
const extension = (body: string): string => `import * as vscode from "vscode";\nvscode.commands.registerCommand("notes.add", () => { ${body} });\n`;

const repo = await repository({
	"2026-10-01": { "README.md": "hello" },
	"2026-10-02": { "notes/package.json": manifest, "notes/extension.ts": extension("add();") },
	"2026-10-03": { "notes/extension.ts": extension("add(1);") },
	"2026-10-04": { "notes/extension.ts": extension("add(1); /* only a comment */") },
	"2026-10-05": { "notes/package.json": null, "notes/extension.ts": null }
});

test("features: the working tree's ways in", async () => {
	const fresh = await repository({ "2026-10-01": { "notes/package.json": manifest, "notes/extension.ts": extension("add();") } });
	const features = await currentFeatures(fresh);

	assert.deepEqual([...features.keys()], ["command|notes.add"]);
	assert.equal(features.get("command|notes.add")!.label, "Add Note");
});

test("history: each day's events, from the code alone", async () => {
	const steps = await historyOf(repo);

	assert.deepEqual(steps.map((step) => step.events.map((event) => event.type + " " + event.id)), [[], ["added notes.add"], ["changed notes.add"], [], ["removed notes.add"]]);
});

test("history --since: the commit before the span is its baseline", async () => {
	const steps = await historyOf(repo, { "since": "2026-10-03T00:00:00Z" });

	assert.equal(steps.length, 4, "the baseline (Oct 2) and three days");
	assert.deepEqual(steps[1]!.events.map((event) => event.type), ["changed"], "Oct 3 is compared with Oct 2");
});

test("history --since a bare date: the whole day, not from the current time of day", async () => {
	const steps = await historyOf(repo, { "since": "2026-10-03" });

	assert.equal(steps.length, 4, "the baseline (Oct 2), then Oct 3, 4 and 5 — Oct 3 included at any time of day");
});

test("the command line: silo history", () => {
	const output = execFileSync(process.execPath, ["--import", "tsx", CLI, "history", repo, "--since", "2026-10-02T00:00:00Z"], { "encoding": "utf8" });

	assert.match(output, /^# History of silo-cli-/u);
	assert.match(output, /Tried command `notes\.add` \(Add Note\): added 2026-10-02, removed 2026-10-05\./u);
});

test("the command line: silo features --json", () => {
	const output = execFileSync(process.execPath, ["--import", "tsx", CLI, "features", repo, "--json"], { "encoding": "utf8" });

	assert.deepEqual(JSON.parse(output), [], "removed on Oct 5: nothing left");
});

test("silo init: the baseline holds the join — what the code's use of each package reaches — and says what grew there", async () => {
	const project = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-join-"));
	const write = async (file: string, text: string): Promise<void> => {
		await fs.mkdir(path.dirname(path.join(project, file)), { "recursive": true });
		fs.writeFileSync(path.join(project, file), text);
	};
	const init = (): { "stdout": string; "stderr": string } => spawnSync(process.execPath, ["--import", "tsx", CLI, "init", project], { "encoding": "utf8" });

	execFileSync("git", ["init", "-q"], { "cwd": project });
	await write("package.json", JSON.stringify({ "name": "app", "private": true, "type": "module" }));
	await write("node_modules/kit/package.json", JSON.stringify({ "name": "kit", "version": "3.0.0", "type": "module", "exports": "./index.js" }));
	await write("node_modules/kit/index.js", "export { save } from \"./save.js\";\nexport { ping } from \"./ping.js\";\n");
	await write("node_modules/kit/save.js", "import { writeFileSync } from \"node:fs\";\nexport const save = (p, d) => writeFileSync(p, d);\n");
	await write("node_modules/kit/ping.js", "export const ping = (u) => fetch(u);\n");
	await write("main.js", "import { save } from \"kit\";\nsave(\"a\", \"b\");\n");

	assert.match(init().stdout, /^Made /u);

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

test("silo install: nothing published in the last `days` days — `latest` is the latest a week old", () => {
	const now = Date.parse("2026-10-13T12:00:00.000Z");

	assert.deepEqual(installCommand("npm", [], 7, now), ["install", "--before=2026-10-06T12:00:00.000Z"]);
	assert.deepEqual(installCommand("npm", ["react@latest"], 1, now), ["install", "react@latest", "--before=2026-10-12T12:00:00.000Z"]);
	assert.deepEqual(installCommand("pnpm", [], 7, now), ["install", "--config.minimum-release-age=10080"]);
	assert.deepEqual(installCommand("pnpm", ["react"], 7, now), ["add", "react", "--config.minimum-release-age=10080"]);
});
