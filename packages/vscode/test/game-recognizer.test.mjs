// Reverse-projection recognizer spec — proves the component→behavior matcher against the REAL dozer game (copied into
// test/fixtures/dozer). "Strong" is measured concretely: every ECS component is recognized as a behavior with the right
// kind/fields, and non-components (the Direction enum) are excluded. Run: node --test (needs bablr/dist built).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as url from "node:url";
import ts from "typescript";
// Node 24 strips the types. The recognizer imports NO typescript itself (would bundle ~16MB in the editor) — the host
// injects its `ts`; here the test injects node's, the way the editor injects its ambient tsserver instance.
import { recognizeBehaviors, recognizeGame, recognizeObjects, recognizeRules } from "../game-recognizer.ts";

const fixtureDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "dozer");

// Fixtures are the REAL dozer files stored as `.ts.txt` so no TS tooling (type-aware lint / build) touches them — they're
// test data (source strings; BABLR parses the content, not the extension). The map key is the logical path (`.txt` stripped).
function readGame(dir, base = dir, out = {}) {
	for (const entry of readdirSync(dir, { "withFileTypes": true })) {
		const full = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			readGame(full, base, out);
		} else if (entry.name.endsWith(".ts.txt")) {
			out[full.slice(base.length + 1).replace(/\.txt$/u, "")] = readFileSync(full, "utf8");
		}
	}

	return out;
}

test("recognizes every dozer behavior (data + tag), cross-file, with correct kind and fields", () => {
	const behaviors = recognizeBehaviors(readGame(fixtureDir), ts);
	const byName = new Map(behaviors.map((behavior) => [behavior.name, behavior]));

	// Data components carry fields. (Check the meaningful fields; nodes also carry loc offsets/anchor.)
	const position = byName.get("Position");

	assert.equal(position?.kind, "data");
	assert.deepEqual(position?.fields, ["x", "y"]);
	assert.equal(position?.defPath, "schemas/position.ts");
	assert.equal(position?.defLine, 1);
	assert.ok(position?.end > position?.start, "Position carries a source range");
	assert.equal(byName.get("MoveIntent")?.kind, "data");
	assert.deepEqual(byName.get("MoveIntent")?.fields, ["direction"]);

	// Tag components are markers (no fields) — and Player is confirmed ONLY via game.ts's load config (never queried),
	// which proves cross-file usage resolution.
	for (const tag of ["Player", "Pushable", "Target"]) {
		assert.equal(byName.get(tag)?.kind, "tag", tag + " is a tag behavior");
		assert.deepEqual(byName.get(tag)?.fields, [], tag + " has no fields");
	}

	assert.equal(byName.get("Player")?.defPath, "schemas/player.ts");
});

test("excludes non-components: the Direction enum (object of numbers, never queried) is not a behavior", () => {
	const behaviors = recognizeBehaviors(readGame(fixtureDir), ts);

	assert.equal(behaviors.find((behavior) => behavior.name === "Direction"), undefined);
	// Strength check: exactly the five real components, nothing else.
	assert.deepEqual(behaviors.map((behavior) => behavior.name), ["MoveIntent", "Player", "Position", "Pushable", "Target"]);
});

test("recognizes entity types by spec SHAPE (components array), not by a load() callee", () => {
	const objects = recognizeObjects(readGame(fixtureDir), ts);
	const byName = new Map(objects.map((object) => [object.name, object]));

	assert.deepEqual([...byName.keys()].sort(), ["boulder", "player", "target"]);
	assert.deepEqual(byName.get("player")?.behaviors, ["MoveIntent", "Player"]);
	assert.equal(byName.get("player")?.depth, 2);
	assert.deepEqual(byName.get("boulder")?.behaviors, ["Pushable"]);
	assert.equal(byName.get("boulder")?.depth, 1);
	assert.deepEqual(byName.get("target")?.behaviors, ["Target"]);
	assert.equal(byName.get("target")?.depth, 0);

	// All declared in game.ts, with a real deep-link line.
	for (const object of objects) {
		assert.equal(object.defPath, "game.ts", object.name + " is declared in game.ts");
		assert.ok(object.defLine > 0, object.name + " has a deep-link line");
	}
});

test("recognizes rules (systems) by shape, with subjects and event→action rows", () => {
	const rules = recognizeRules(readGame(fixtureDir), ts);
	const byName = new Map(rules.map((rule) => [rule.name, rule]));

	// All four systems, recognized by querying (not by name), each deep-linked to its systems/*.ts file.
	assert.deepEqual([...byName.keys()].sort(), ["inputSystem", "movementSystem", "renderSystem", "winSystem"]);

	for (const rule of rules) {
		assert.match(rule.defPath, /^systems\//u, rule.name + " lives in systems/");
		assert.ok(rule.defLine > 0);
	}

	// input decomposes cleanly: subject = [MoveIntent], four key→intent rows.
	const input = byName.get("inputSystem");

	assert.deepEqual(input?.queries, [["MoveIntent"]]);
	assert.equal(input?.rows.length, 4);
	assert.match(input.rows[0].event, /JustDown/u);
	assert.match(input.rows[0].event, /up/u);
	assert.match(input.rows[0].actions[0], /MoveIntent\.direction/u);
	assert.match(input.rows[0].actions[0], /Direction\.Up/u);
	assert.ok(input.rows[0].line > 0, "each row is deep-linked");

	// win/render don't decompose into rows (guards / glue) — still recognized, still deep-linked. win reads its subjects.
	assert.equal(byName.get("winSystem")?.rows.length, 0);
	assert.deepEqual(byName.get("winSystem")?.queries, [["Target", "Position"], ["Pushable", "Position"]]);
	assert.equal(byName.get("renderSystem")?.rows.length, 0);
	assert.deepEqual(byName.get("renderSystem")?.queries, [["Position"]]);
});

test("recognizeGame composes all three into one JSON model (what the worker returns)", () => {
	const model = recognizeGame(readGame(fixtureDir), ts);

	assert.equal(model.behaviors.length, 5);
	assert.equal(model.objects.length, 3);
	assert.equal(model.rules.length, 4);
	// No false-positive composites: dozer's systems all query (they're rules), and its scene lifecycle hooks
	// (preload/create/update) reference components but are not reusable behaviors — none should read as a composite.
	assert.equal(model.composites.length, 0);
	// Plain JSON — survives the worker boundary (structuredClone stands in for postMessage).
	assert.deepEqual(structuredClone(model), model);
});
