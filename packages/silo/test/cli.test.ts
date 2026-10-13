import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";

import { currentFeatures, factsOf, historyOf } from "../src/cli.ts";

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
	const features = currentFeatures(fresh);

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

test("silo history tells the facts editors kept with the commits: the work between them, the tries no commit saw", async () => {
	const kept = await repository({ "2026-10-01": { "README.md": "hello" }, "2026-10-03": { "notes/package.json": manifest, "notes/extension.ts": extension("add();") } });
	const fact = (time: string, type: string, id: string, label = ""): string => JSON.stringify({ "time": time, "file": "notes/extension.ts", "features": 1, "events": [{ "key": "command|" + id, "facet": "command", "id": id, "type": type, "label": label, "files": ["notes/extension.ts"] }] });

	await fs.mkdir(path.join(kept, ".silo", "history"), { "recursive": true });
	await fs.writeFile(path.join(kept, ".silo", "history", "silo.jsonl"), [fact("2026-10-02T09:00:00Z", "added", "notes.try"), fact("2026-10-02T10:00:00Z", "removed", "notes.try"), fact("2026-10-03T09:00:00Z", "added", "notes.add", "Add Note")].join("\n") + "\n");

	assert.equal(factsOf(kept).length, 3);

	const output = execFileSync(process.execPath, ["--import", "tsx", CLI, "history", kept], { "encoding": "utf8" });

	assert.match(output, /Tried command `notes\.try`: added 2026-10-02, removed 2026-10-02\./u, "a try only the facts saw");
	assert.match(output, /Added command `notes\.add`: Add Note \(2026-10-03\)\./u, "the commit's addition, told once");
	assert.doesNotMatch(execFileSync(process.execPath, ["--import", "tsx", CLI, "history", kept, "--commits-only"], { "encoding": "utf8" }), /notes\.try/u, "--commits-only: the commits alone");
});
