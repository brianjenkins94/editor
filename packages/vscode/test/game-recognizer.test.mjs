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
import { recognizeBehaviors, recognizeObjects } from "../game-recognizer.ts";

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

	// Data components carry fields.
	assert.deepEqual(byName.get("Position"), { "name": "Position", "kind": "data", "fields": ["x", "y"], "defPath": "schemas/position.ts", "defLine": 1 });
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
