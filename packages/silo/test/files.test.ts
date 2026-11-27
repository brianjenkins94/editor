import type { SpanRef } from "@brianjenkins94/util/silo/annotations";
import type { RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { annotationsText } from "@brianjenkins94/util/silo/annotations";
import { saveBaseline } from "@brianjenkins94/util/silo/audit";
import { envelopeLine, foldReached, stableOf, stableText } from "@brianjenkins94/util/silo/evidence";
import { annotationsPath, evidencePathFor, lastRunReachPath, ledgerPath, runsPath, vouchesPath } from "@brianjenkins94/util/silo/layout";
import { ledgerText, withStatus } from "@brianjenkins94/util/silo/ledger";
import { reachRecord } from "@brianjenkins94/util/silo/observed";
import { siloPaths } from "@brianjenkins94/util/silo/paths";
import { vouchesText } from "@brianjenkins94/util/silo/select";
import { readSilo } from "./reader.mjs";

const at = "2026-11-25T00:00:00.000Z";

function ref(span: string): SpanRef {
	return {
		"span": span,
		"key": "bablr1",
		"file": "src/notes.ts",
		"shape": { "type": "Statement", "atoms": [] },
		"context": {}
	};
}

async function written(files: Record<string, string>): Promise<string> {
	const repo = await fs.mkdtemp(path.join(fs.tmpdir(), "silo-files-"));

	for (const [file, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(repo, file)), { "recursive": true });
		await fs.writeFile(path.join(repo, file), text);
	}

	return repo;
}

function run(id: string): RunEnvelope {
	return {
		"type": "run",
		"id": id,
		"title": "node app.ts",
		"entry": "app.ts",
		"cwd": "",
		"startedAt": at,
		"endedAt": at,
		"exit": 0,
		"user": "ada",
		"environment": {
			"runtime": "node",
			"engine": "v8",
			"os": "macos",
			"cores": 8,
			"name": "laptop"
		},
		"files": {
			"app.ts": "0".repeat(40)
		}
	};
}

test("silo's files, as silo writes them, read by a program that isn't silo", async () => {
	const ledger = withStatus(withStatus({}, "notes", "active", "kept", "2026-11-25", {
		"ways": ["command|notes.add"],
		"paths": ["src/notes.ts"],
		"tests": ["test/notes.test.ts"]
	}), "old", "removed", "went", "2026-11-25", {
		"paths": ["src/old.ts"]
	});
	const repo = await written({
		[ledgerPath()]: ledgerText(ledger),
		[runsPath("ada")]: envelopeLine(run("r1")) + envelopeLine(run("r2")),
		[vouchesPath("ada")]: vouchesText([
			{
				"test": "test/notes.test.ts › adds",
				"outcome": "pass",
				"by": "ada",
				"at": at,
				"runtime": "node",
				"reached": { "src/notes.ts#add": "abc" }
			}
		]),
		[evidencePathFor("ada", "laptop.node.v8.macos", "src/notes.ts")]: stableText(stableOf(foldReached([], [
			{ "span": "s1", "count": 3 }
		], { "id": "r1", "at": at }))),
		[annotationsPath("notes", "ada", "src/notes.ts")]: annotationsText([
			{
				"id": "n1",
				"kind": "note",
				"ref": ref("s1"),
				"author": "ada",
				"createdAt": at,
				"updatedAt": at
			},
			{
				"id": "n2",
				"kind": "note",
				"ref": ref("s2"),
				"author": "ada",
				"createdAt": at,
				"updatedAt": at,
				"dismissed": true
			}
		]),
		[lastRunReachPath()]: JSON.stringify(reachRecord([
			{
				"file": "test/notes.test.ts",
				"name": "adds",
				"reach": {
					"src/notes.ts": [1]
				}
			}
		], at))
	});

	await saveBaseline(siloPaths(repo), {
		"consumer": {
			".": {
				"kit": {
					"kind": "package",
					"version": "1.0.0",
					"members": ["save"],
					"dynamic": false,
					"caps": ["fs:write"]
				}
			}
		},
		"packages": {
			"kit": {
				"version": "1.0.0",
				"caps": ["fs"]
			}
		},
		"join": 1
	});

	const read = readSilo(repo);

	assert.deepEqual(read.features, {
		"notes": {
			"status": "active",
			"why": "kept",
			"paths": ["src/notes.ts"],
			"tests": ["test/notes.test.ts"],
			"ways": ["command|notes.add"]
		},
		"old": {
			"status": "removed",
			"why": "went",
			"paths": ["src/old.ts"],
			"tests": [],
			"ways": []
		}
	});
	assert.deepEqual(read.runs, {
		"ids": ["r1", "r2"],
		"skipped": 0
	});
	assert.deepEqual(read.vouches, {
		"tests": ["ada: test/notes.test.ts › adds pass"],
		"skipped": 0
	});
	assert.deepEqual(read.evidence, ["ada/laptop.node.v8.macos src/notes.ts reached s1"]);
	assert.deepEqual(read.notes, ["ada src/notes.ts n1"], "a dismissed note is a tombstone");
	assert.deepEqual(read.reach, {
		"tests": 1,
		"files": ["src/notes.ts"],
		"statements": 1
	});
	assert.deepEqual(read.baseline, {
		"packages": ["kit"],
		"uses": 1
	});
	assert.equal(read.policy, undefined, "a file that isn't there isn't read");
});

test("a newer version: a line of one skipped, a whole file of one refused, and a writer keeps what it can't read", async () => {
	const newer = JSON.stringify({
		...run("r9"),
		"version": 2
	});
	const repo = await written({
		[runsPath("ada")]: envelopeLine(run("r1")) + newer + "\n",
		[vouchesPath("ada")]: vouchesText([
			{
				"test": "t › a",
				"outcome": "pass",
				"by": "ada",
				"at": at,
				"runtime": "node",
				"reached": {}
			}
		], JSON.stringify({ "test": "t › b", "version": 2, "reached": {} }) + "\n")
	});

	assert.deepEqual(readSilo(repo).runs, {
		"ids": ["r1"],
		"skipped": 1
	});
	assert.deepEqual(readSilo(repo).vouches, {
		"tests": ["ada: t › a pass"],
		"skipped": 1
	}, "silo's writer kept the newer line");

	await fs.writeFile(path.join(repo, ledgerPath()), JSON.stringify({ "$version": 2 }));
	assert.throws(() => readSilo(repo), /features\.json is version 2/u);
});
