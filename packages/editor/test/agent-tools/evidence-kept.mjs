/**
 * What a run and a preview observed, kept in git: .silo/runs and .silo/evidence.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/evidence-kept.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("evidence-kept");
const { ask } = session;

test("what a run observed is kept in git: its envelope in .silo/runs, what each statement and site was seen to do in .silo/evidence, and the counts on this machine", async () => {
	await ask("files.write", { "path": "observed.mjs", "content": "function play(world, score) {\n\tworld.onWin?.();\n\n\treturn score > 10 ? \"won\" : \"lost\";\n}\n\nconst world = { \"onWin\": () => undefined };\n\nconsole.log(play(world, 12), play(world, 3));\n" });

	const ran = await session.request("debug.start", { "program": "observed.mjs" }, 120_000);

	assert.equal(ran.state, "terminated", JSON.stringify(ran));

	// (written as the run ends: its evidence first, the envelope last)
	const runs = await session.eventually("the run's envelope", async () => {
		const found = (await ask("files.glob", { "pattern": ".silo/runs/*.jsonl" })).files;

		for (const file of found) {
			const lines = (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.includes("observed.mjs"));

			if (lines.length > 0) {
				return lines.map((line) => JSON.parse(line));
			}
		}

		return undefined;
	}, 60_000);
	const [envelope] = runs;

	assert.deepEqual([envelope.type, envelope.entry, envelope.exit, envelope.environment.runtime], ["run", "observed.mjs", 0, "tsval"]);
	assert.match(envelope.files["observed.mjs"], /^[\da-f]{40}$/u);

	const [evidenceFile] = (await ask("files.glob", { "pattern": `.silo/evidence/${envelope.user}/**/observed.mjs.jsonl` })).files;
	const linesOf = async (file) => (await ask("files.read", { "path": file })).content.split("\n").map((line) => line.slice(line.indexOf("\t") + 1)).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
	const committed = await linesOf(evidenceFile);
	// (this machine's, beside it under .silo/local, which isn't searched: git doesn't see it)
	const counted = await linesOf(evidenceFile.replace(".silo/evidence/", ".silo/local/evidence/"));

	assert.ok(committed.some(({ kind, taken }) => kind === "branch" && taken?.join() === "0,1"), "committed: the ?: took each arm");
	assert.ok(committed.some(({ kind, tags, nullish }) => kind === "value" && tags?.join() === "function" && nullish === false), "world.onWin was a function, never nullish");
	assert.ok(committed.some(({ kind, ran }) => kind === "reached" && ran === true), "and the statements that ran");
	assert.ok(committed.every(({ lastAt, w }) => lastAt === undefined && w === undefined), "no counts or times in git");
	assert.ok(counted.some(({ kind, arms }) => kind === "branch" && arms?.join() === "1,1"), "on this machine: the ?: took each arm once");
	assert.ok(counted.some(({ kind, seen, nullish, tags }) => kind === "value" && seen === 2 && nullish === 0 && tags?.function === 2), "world.onWin was a function both times it was reached");
	await ask("files.delete", { "path": "observed.mjs" });
});
