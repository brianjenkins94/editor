import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";

import { coverageOf, currentFeatures, historyOf, installArgs } from "../src/cli.ts";

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

test("prices, dormant ways in, silo remove and silo restore", async () => {
	const notes = await repository({
		"2026-10-20": {
			"README.md": "Notes export to markdown (notes/export.ts).\n",
			"notes/package.json": JSON.stringify({ "contributes": { "commands": [{ "command": "notes.add", "title": "Add" }, { "command": "notes.export", "title": "Export" }], "keybindings": [{ "command": "notes.export", "key": "ctrl+e" }] } }, undefined, "\t") + "\n",
			"notes/extension.ts": "import * as vscode from \"vscode\";\nimport { exportAll } from \"./export\";\n\nfunction add(): number {\n\treturn 1;\n}\n\nvscode.commands.registerCommand(\"notes.add\", add);\nvscode.commands.registerCommand(\"notes.export\", exportAll);\n",
			"notes/export.ts": "export function exportAll(): string {\n\treturn format();\n}\n\nfunction format(): string {\n\treturn \"# notes\";\n}\n",
			// (CI's records: the suites loaded both files, and ran add — never exportAll)
			".silo/evidence/ci/architecture.json": JSON.stringify({ "version": 1, "tests": [{ "shard": "smoke-app", "name": "adds" }], "reach": { "notes/extension.ts": { "(top level)": [0], "add": [0] }, "notes/export.ts": { "(top level)": [0] } } })
		}
	});
	const silo = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { "encoding": "utf8" });
	const checked = JSON.parse(String(silo("check", notes, "--json").stdout)) as { "dormant": { "key": string; "price": { "files": string[]; "declarations": string[] } }[] };

	// Dormant: export's file loaded, its code never ran — priced at what deleting it frees: export.ts whole.
	assert.deepEqual(checked.dormant.map((each) => each.key), ["command|notes.export"]);
	assert.deepEqual(checked.dormant[0].price.files, ["notes/export.ts"]);
	assert.deepEqual(checked.dormant[0].price.declarations, ["notes/export.ts#exportAll", "notes/export.ts#format"]);
	assert.match(String(silo("check", notes).stdout), /Dormant \(1\)[^\n]*\n {2}command notes\.export: deleting it frees 2 declarations, 1 file whole[^\n]*\n {4}keep: silo status "notes\.export" active "<why>" --key "command\|notes\.export" --until \d{4}-\d\d-\d\d; remove: silo remove/u);

	// Removed: the file, its manifest entries, a tombstone — its registration and the README named for doing by hand.
	const removed = silo("remove", "notes.export", "nobody exports", "--key", "command|notes.export", "--repo", notes);

	assert.equal(removed.status, 0, String(removed.stderr));
	assert.equal(fs.existsSync(path.join(notes, "notes/export.ts")), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(notes, "notes/package.json"))).contributes, { "commands": [{ "command": "notes.add", "title": "Add" }], "keybindings": [] });
	assert.match(String(removed.stdout), /its way in, to take out by hand: where notes\/extension\.ts states it/u);
	assert.match(String(removed.stdout), /still named in: README\.md/u);

	const tombstone = JSON.parse(fs.readFileSync(path.join(notes, ".silo/features.json")))["notes.export"];

	assert.equal(tombstone.status, "removed");
	assert.match(tombstone.restore, /^git checkout [0-9a-f]+ -- notes\/export\.ts$/u);

	// Restored: the file back, the entry active again.
	const restored = silo("restore", "notes.export", "--repo", notes);

	assert.equal(restored.status, 0, String(restored.stderr));
	assert.equal(fs.existsSync(path.join(notes, "notes/export.ts")), true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(notes, ".silo/features.json")))["notes.export"].status, "active");

	// Nothing it can take out on its own (its code shares a file, no manifest entry): no tombstone for what's still there.
	const shared = silo("remove", "adder", "unused", "--paths", "notes/nowhere.ts", "--repo", notes);

	assert.equal(shared.status, 2, String(shared.stdout));
	assert.match(String(shared.stdout), /^Nothing of "adder" silo can take out on its own/u);
	assert.equal(JSON.parse(fs.readFileSync(path.join(notes, ".silo/features.json")))["adder"], undefined);
});

test("coverage: what ran is told by the feature declared to own its file, what none owns by its folder", async () => {
	const owned = "function go() { return 1; }\nfunction idle() { return 2; }\ngo();\n";
	const free = "export function loose() { return 3; }\nloose();\n";
	const { cstSpansAsync, spanAnchors } = await import("@brianjenkins94/bablr") as unknown as { "cstSpansAsync": (source: string, language: string) => Promise<unknown>; "spanAnchors": (source: string, language: string, cst: unknown) => { "id": string; "start": number; "end": number; "type": string | null }[] };
	const spanIn = async (source: string, inside: string): Promise<string> => {
		const at = source.indexOf(inside);
		const spans = spanAnchors(source, "Program", await cstSpansAsync(source, "Program")).filter((span) => span.type !== null && span.start <= at && at + inside.length <= span.end);

		return spans.sort((one, other) => (one.end - one.start) - (other.end - other.start))[0]!.id; // (filter's own copy)
	};
	const reached = (span: string): string => JSON.stringify({ "span": span, "key": "bablr1", "kind": "reached", "w": 1, "runs": 1, "ever": 1, "lastRun": "r1", "lastAt": "2026-10-02T00:00:00.000Z" }) + "\n";
	const run = JSON.stringify({ "type": "run", "id": "r1", "title": "node", "entry": "notes/app.ts", "cwd": ".", "startedAt": "2026-10-02T00:00:00.000Z", "endedAt": "2026-10-02T00:00:00.000Z", "exit": 0, "user": "ada", "environment": { "runtime": "tsval", "engine": "node-24", "os": "macos", "cores": 8, "name": "default" }, "files": {} }) + "\n";
	const fresh = await repository({
		"2026-10-01": {
			"tsconfig.json": JSON.stringify({ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "esnext" } }),
			".silo/features.json": JSON.stringify({ "Notes": { "status": "active", "why": "w", "since": "2026-10-01", "what": "Notes.", "paths": ["notes"] } }),
			"notes/app.ts": owned,
			"tools/free.ts": free
		},
		"2026-10-02": {
			".silo/runs/ada.jsonl": run,
			".silo/evidence/ada/default/notes/app.ts.jsonl": reached(await spanIn(owned, "return 1")),
			".silo/evidence/ada/default/tools/free.ts.jsonl": reached(await spanIn(free, "return 3"))
		}
	});
	const changes = (await coverageOf(fresh)).flatMap((step) => step.changes);

	assert.deepEqual(changes.find((change) => change.declaration === "notes/app.ts#go")?.features, ["Notes"]);
	assert.equal(changes.find((change) => change.declaration === "notes/app.ts#go")?.kind, "started");
	assert.deepEqual(changes.find((change) => change.declaration === "tools/free.ts#loose")?.features, [], "nobody's: told by its folder");

	const told = spawnSync("npx", ["tsx", CLI, "coverage", fresh], { "encoding": "utf8" });

	assert.match(told.stdout, /\*\*Notes\*\* — started running: `app\.ts#go`/u);
});

test("observed: each test against what its file declares, from a folder of its suite's reach", async () => {
	const reach = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-reach-"));
	const fresh = await repository({ "2026-10-01": {
		".silo/features.json": JSON.stringify({ "Notes": { "status": "active", "why": "w", "since": "2026-10-01", "what": "N.", "paths": ["notes.ts"], "tests": ["test/notes.mjs"] }, "Git": { "status": "active", "why": "w", "since": "2026-10-01", "what": "G.", "paths": ["git.ts"] } }),
		"notes.ts": "",
		"git.ts": "",
		"test/notes.mjs": ""
	} });
	const statements = (from: number): number[][] => Array.from({ "length": 25 }, (_, index) => [from + index]);

	fs.writeFileSync(path.join(reach, "notes.json"), JSON.stringify({ "stray": { "git.ts": statements(0) }, "own": { "notes.ts": statements(100) } }));

	const told = spawnSync("npx", ["tsx", CLI, "observed", reach, "--repo", fresh], { "encoding": "utf8" });

	assert.equal(told.status, 0, told.stderr);
	assert.match(told.stdout, /\| 0% \| 25 \| notes\.mjs: stray \| Git 25 \|/u);
	assert.match(told.stdout, /\| 100% \| 25 \| notes\.mjs: own \| Notes 25 \|/u);

	fs.writeFileSync(path.join(reach, "nowhere.json"), "{}");
	assert.match(spawnSync("npx", ["tsx", CLI, "observed", reach, "--repo", fresh], { "encoding": "utf8" }).stderr, /nowhere\.json: expected one test file named nowhere, found 0/u);
});

test("remove: the tests only it names go with it, one another feature names stays, and its restore has them", async () => {
	const entry = (paths: string[], tests: string[]): unknown => ({ "status": "active", "why": "w", "since": "2026-10-01", "what": "W.", "paths": paths, "tests": tests });
	const fresh = await repository({ "2026-10-01": {
		".silo/features.json": JSON.stringify({ "Old": entry(["old/a.ts"], ["test/old.mjs", "test/both.mjs"]), "Kept": entry(["kept.ts"], ["test/both.mjs"]) }),
		"old/a.ts": "export const a = 1;\n",
		"kept.ts": "export const kept = 1;\n",
		"test/old.mjs": "",
		"test/both.mjs": ""
	} });
	const removed = spawnSync("npx", ["tsx", CLI, "remove", "Old", "gone", "--repo", fresh], { "encoding": "utf8" });

	assert.equal(removed.status, 0, removed.stderr + removed.stdout);
	assert.equal(fs.existsSync(path.join(fresh, "test/old.mjs")), false);
	assert.equal(fs.existsSync(path.join(fresh, "test/both.mjs")), true);
	assert.equal(fs.existsSync(path.join(fresh, "old/a.ts")), false);
	assert.match(JSON.parse(fs.readFileSync(path.join(fresh, ".silo/features.json")))["Old"].restore, /old\/a\.ts.*test\/old\.mjs/u);
});
