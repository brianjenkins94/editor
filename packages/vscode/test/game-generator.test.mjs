// Generator round-trip spec — the AUTHOR direction, proven against the READ direction. Assembling dozer as a block
// model and generating it must produce code that reverse-projects to the SAME map. That closes the loop
// (author → generate → recognize → same map) and is the generator's correctness test. Run: node --test.
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { dozerAuthored, generateGame } from "../game-generator.ts";
import { recognizeGame } from "../game-recognizer.ts";

test("generating the dozer block model reverse-projects to the dozer map", () => {
	const files = generateGame(dozerAuthored);

	// It emitted a generated game.ts plus the library files the behaviors need.
	assert.ok(typeof files["game.ts"] === "string", "game.ts is generated");
	for (const path of ["schemas/position.ts", "schemas/moveIntent.ts", "systems/input.ts", "systems/win.ts"]) {
		assert.ok(typeof files[path] === "string", path + " is emitted from the library");
	}

	const model = recognizeGame(files, ts);

	// Behaviors: the five real components (Direction stays an excluded enum).
	assert.deepEqual(model.behaviors.map((behavior) => behavior.name), ["MoveIntent", "Player", "Position", "Pushable", "Target"]);

	// Objects: exactly what was authored — entity names, attached behaviors, depth — recovered from the generated config.
	const objects = new Map(model.objects.map((object) => [object.name, object]));

	assert.deepEqual([...objects.keys()].sort(), ["boulder", "player", "target"]);
	assert.deepEqual(objects.get("player")?.behaviors, ["MoveIntent", "Player"]);
	assert.equal(objects.get("player")?.depth, 2);
	assert.deepEqual(objects.get("boulder")?.behaviors, ["Pushable"]);
	assert.deepEqual(objects.get("target")?.behaviors, ["Target"]);
	assert.equal(objects.get("player")?.defPath, "game.ts", "objects deep-link to the generated game.ts");

	// Rules: the four systems the model listed, recognized from the emitted library files.
	assert.deepEqual(model.rules.map((rule) => rule.name).sort(), ["inputSystem", "movementSystem", "renderSystem", "winSystem"]);
	assert.equal(model.rules.find((rule) => rule.name === "inputSystem")?.rows.length, 4, "input still decomposes to 4 rows");
});

test("adding an entity to the model shows up in the regenerated projection", () => {
	const withCrate = {
		...dozerAuthored,
		"entities": [...dozerAuthored.entities, { "name": "crate", "components": ["Pushable"], "depth": 1 }]
	};
	const model = recognizeGame(generateGame(withCrate), ts);

	assert.ok(model.objects.some((object) => object.name === "crate"), "the new entity is in the projection");
	assert.equal(model.objects.length, 4);
});
