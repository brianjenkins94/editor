// Generator round-trip spec — the AUTHOR direction, proven against the READ direction. Assembling dozer as a block
// model and generating it must produce a COMPLETE runnable game whose code reverse-projects to the SAME map. That closes
// the loop (author → generate → recognize → same map) and is the generator's correctness test. Run: node --test.
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { blankGame, dozerAuthored, dozerComposed, generateGame } from "../game-generator.ts";
import { recognizeGame } from "../game-recognizer.ts";

test("generating the dozer block model emits a complete runnable game", () => {
	const files = generateGame(dozerAuthored);

	// Infra is vendored verbatim so the game runs standalone.
	for (const path of ["index.html", "scene.ts", "Tilemap.ts", "package.json"]) {
		assert.ok(typeof files[path] === "string" && files[path].length > 0, path + " is vendored");
	}

	// The generated assembly imports the local Tilemap (self-contained, not a shared workspace path).
	assert.match(files["game.ts"], /from "\.\/Tilemap"/u, "game.ts uses the local Tilemap");

	// It emitted a generated game.ts plus the library files the behaviors need.
	assert.ok(typeof files["game.ts"] === "string", "game.ts is generated");
	for (const path of ["schemas/position.ts", "schemas/moveIntent.ts", "systems/input.ts", "systems/win.ts"]) {
		assert.ok(typeof files[path] === "string", path + " is emitted from the library");
	}

	// The vendored input system is the real, runnable one (imports Phaser — the old hand-retyped copy didn't).
	assert.match(files["systems/input.ts"], /import Phaser from "phaser"/u, "input system is the real vendored copy");

	// The level is generated from the painted grid: the used sprites + every placement.
	const level = files["levels/level1.ts"];

	assert.ok(typeof level === "string", "the level file is generated");
	for (const sprite of ["gray_square", "player", "boulder", "target"]) {
		assert.match(level, new RegExp('addTileset\\("' + sprite + '"', "u"), sprite + " tileset is emitted with its data URL");
	}
	assert.match(level, /\["player", 10, 6\]/u, "the player is placed where it was authored");
	assert.equal((level.match(/\["boulder",/gu) ?? []).length, 4, "all four boulders are placed");
	assert.equal((level.match(/\["target",/gu) ?? []).length, 4, "all four targets are placed");

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

test("a blank game is a complete, runnable, empty scaffold", () => {
	const files = generateGame(blankGame());

	// Runs standalone: infra + an (empty) level + an assembly, no entities/systems.
	for (const path of ["index.html", "scene.ts", "Tilemap.ts", "package.json", "levels/level1.ts", "game.ts"]) {
		assert.ok(typeof files[path] === "string", path + " is present in a blank game");
	}

	const model = recognizeGame(files, ts);

	assert.equal(model.objects.length, 0, "a blank game has no objects");
	assert.equal(model.rules.length, 0, "a blank game has no rules");
});

test("the COMPOSED dozer generates a complete runnable game whose systems are compiled from primitives", () => {
	const files = generateGame(dozerComposed);

	// Complete + self-contained: infra, schemas, the compiled library + systems, the render engine glue, level, assembly.
	for (const path of ["index.html", "scene.ts", "Tilemap.ts", "package.json", "schemas/player.ts", "schemas/pushable.ts", "schemas/target.ts", "schemas/position.ts", "behaviors/gridPush.ts", "systems/playerMove.ts", "systems/winSystem.ts", "systems/render.ts", "levels/level1.ts", "game.ts"]) {
		assert.ok(typeof files[path] === "string" && files[path].length > 0, path + " is present");
	}

	// The player logic is COMPILED, not vendored: playerMove composes the gridPush behavior.
	assert.match(files["systems/playerMove.ts"], /gridPush\(world, eid, dir\)/u, "playerMove composes the built-in behavior");
	assert.match(files["behaviors/gridPush.ts"], /Position\.x\[rock\] = pastX/u, "the push lives in the behavior, built from primitives");

	// The assembly wires the compiled systems + render, in order, and needs no MoveIntent/Direction (input is folded in).
	assert.match(files["game.ts"], /scene\.systems = \[playerMove, renderSystem, winSystem\]/u, "systems run move -> render -> win");
	assert.match(files["game.ts"], /import \{ playerMove \} from "\.\/systems\/playerMove"/u);
	assert.doesNotMatch(files["game.ts"], /MoveIntent|Direction/u, "the composed player needs only the Player tag");

	// Round-trip: the composed game reverse-projects to dozer's map, with the library recognized.
	const model = recognizeGame(files, ts);

	assert.deepEqual(model.objects.map((object) => object.name).sort(), ["boulder", "player", "target"]);
	assert.deepEqual(model.rules.map((rule) => rule.name).sort(), ["playerMove", "renderSystem", "winSystem"]);
	assert.deepEqual(model.composites.map((composite) => composite.name), ["gridPush"]);
	assert.deepEqual(model.rules.find((rule) => rule.name === "playerMove")?.composes, ["gridPush"], "the rule round-trips its composition");
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
