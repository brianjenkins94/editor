/**
 * Game generator + starter behavior library — the AUTHOR direction (write), inverse of the recognizer (read).
 *
 * `generateGame` takes a block model (entities + their behaviors + which systems run + a level) and emits the game's
 * files: a thin, generated `game.ts` ASSEMBLY plus the library files the used behaviors provide. The heavy logic is never
 * generated — it comes from the LIBRARY below (dozer's reusable schemas + systems) — which is what makes a drag-and-drop
 * build tractable (the GameMaker/Construct insight): the author composes behaviors; they never hand-write movement/push.
 *
 * The generated code is designed to reverse-project cleanly: run recognizeGame over the output and you get the same map
 * the author assembled. That round-trip (author → generate → recognize → same map) is both the payoff and the test.
 *
 * The library lives inline (not a separate module) so this file has no relative value import — it type-strips under node
 * (tests) and bundles in the editor without an extension-resolution mismatch. Systems use string concat instead of
 * template literals only so they embed cleanly here; behaviour is identical. Later this becomes a published library.
 */

import type { GameModel } from "./game-recognizer";

interface LibFile { "path": string; "content": string }
interface LibComponent { "from": string; "file": LibFile }
interface LibSystem { "from": string; "file": LibFile; "needs": string[] }

const COMPONENTS: Record<string, LibComponent> = {
	"Position": { "from": "./schemas/position", "file": { "path": "schemas/position.ts", "content": "export const Position = {\n\t\"x\": new Uint8Array(1024),\n\t\"y\": new Uint8Array(1024)\n};\n" } },
	"MoveIntent": { "from": "./schemas/moveIntent", "file": { "path": "schemas/moveIntent.ts", "content": "export const MoveIntent = {\n\t\"direction\": new Uint8Array(1024)\n};\n" } },
	"Direction": { "from": "./schemas/direction", "file": { "path": "schemas/direction.ts", "content": "// None = 0 so uninitialized TypedArray slots mean \"no intent\".\nexport const Direction = {\n\t\"None\": 0,\n\t\"Up\": 1,\n\t\"Right\": 2,\n\t\"Down\": 3,\n\t\"Left\": 4\n} as const;\n" } },
	"Player": { "from": "./schemas/player", "file": { "path": "schemas/player.ts", "content": "// Tag component — marks the player entity.\nexport const Player: number[] = [];\n" } },
	"Pushable": { "from": "./schemas/pushable", "file": { "path": "schemas/pushable.ts", "content": "// Tag component — marks entities the player can push.\nexport const Pushable: number[] = [];\n" } },
	"Target": { "from": "./schemas/target", "file": { "path": "schemas/target.ts", "content": "// Tag component — marks goal tiles boulders must be pushed onto.\nexport const Target: number[] = [];\n" } }
};

const INPUT_SYSTEM = `import { query } from "bitecs";
import { Direction } from "../schemas/direction";
import { MoveIntent } from "../schemas/moveIntent";

export function inputSystem(world) {
	const { cursors } = world;

	for (const eid of query(world, [MoveIntent])) {
		if (Phaser.Input.Keyboard.JustDown(cursors.up)) {
			MoveIntent.direction[eid] = Direction.Up;
		} else if (Phaser.Input.Keyboard.JustDown(cursors.right)) {
			MoveIntent.direction[eid] = Direction.Right;
		} else if (Phaser.Input.Keyboard.JustDown(cursors.down)) {
			MoveIntent.direction[eid] = Direction.Down;
		} else if (Phaser.Input.Keyboard.JustDown(cursors.left)) {
			MoveIntent.direction[eid] = Direction.Left;
		}
	}
}
`;

const MOVEMENT_SYSTEM = `import { query } from "bitecs";
import { Direction } from "../schemas/direction";
import { MoveIntent } from "../schemas/moveIntent";
import { Position } from "../schemas/position";
import { Pushable } from "../schemas/pushable";

const deltas = {
	[Direction.Up]: [0, -1],
	[Direction.Right]: [1, 0],
	[Direction.Down]: [0, 1],
	[Direction.Left]: [-1, 0]
};

function entityAt(world, x, y, exclude = -1) {
	for (const eid of query(world, [Pushable, Position])) {
		if (eid !== exclude && Position.x[eid] === x && Position.y[eid] === y) {
			return eid;
		}
	}

	return undefined;
}

export function movementSystem(world) {
	const { walls } = world;

	for (const eid of query(world, [MoveIntent, Position])) {
		const dir = MoveIntent.direction[eid];

		if (!dir) { continue; }

		const [dx, dy] = deltas[dir];
		const nx = Position.x[eid] + dx;
		const ny = Position.y[eid] + dy;

		if (walls.has(nx + "," + ny)) {
			MoveIntent.direction[eid] = Direction.None;
			continue;
		}

		const pushedEid = entityAt(world, nx, ny);

		if (pushedEid !== undefined) {
			const bx = nx + dx;
			const by = ny + dy;

			if (walls.has(bx + "," + by) || entityAt(world, bx, by, pushedEid) !== undefined) {
				MoveIntent.direction[eid] = Direction.None;
				continue;
			}

			Position.x[pushedEid] = bx;
			Position.y[pushedEid] = by;
		}

		Position.x[eid] = nx;
		Position.y[eid] = ny;
		MoveIntent.direction[eid] = Direction.None;
	}
}
`;

const RENDER_SYSTEM = `import { query } from "bitecs";
import { Position } from "../schemas/position";

export function renderSystem(world) {
	const { sprites, tileConfig: { tileWidth, tileHeight } } = world;

	for (const eid of query(world, [Position])) {
		const sprite = sprites.get(eid);

		if (!sprite) { continue; }

		sprite.x = Position.x[eid] * tileWidth + tileWidth / 2;
		sprite.y = Position.y[eid] * tileHeight + tileHeight / 2;
	}
}
`;

const WIN_SYSTEM = `import { query } from "bitecs";
import { Position } from "../schemas/position";
import { Pushable } from "../schemas/pushable";
import { Target } from "../schemas/target";

export function winSystem(world) {
	const targets = new Set();

	for (const eid of query(world, [Target, Position])) {
		targets.add(Position.x[eid] + "," + Position.y[eid]);
	}

	if (!targets.size) { return; }

	for (const eid of query(world, [Pushable, Position])) {
		if (!targets.has(Position.x[eid] + "," + Position.y[eid])) { return; }
	}

	world.onWin?.();
}
`;

const SYSTEMS: Record<string, LibSystem> = {
	"inputSystem": { "from": "./systems/input", "file": { "path": "systems/input.ts", "content": INPUT_SYSTEM }, "needs": ["MoveIntent", "Direction"] },
	"movementSystem": { "from": "./systems/movement", "file": { "path": "systems/movement.ts", "content": MOVEMENT_SYSTEM }, "needs": ["MoveIntent", "Position", "Pushable", "Direction"] },
	"renderSystem": { "from": "./systems/render", "file": { "path": "systems/render.ts", "content": RENDER_SYSTEM }, "needs": ["Position"] },
	"winSystem": { "from": "./systems/win", "file": { "path": "systems/win.ts", "content": WIN_SYSTEM }, "needs": ["Target", "Position", "Pushable"] }
};

/** The behaviors (components + systems) the author can attach — the palette. */
export function libraryComponents(): string[] {
	return Object.keys(COMPONENTS);
}

export function librarySystems(): string[] {
	return Object.keys(SYSTEMS);
}

/** One authored entity: a name, the component behaviors attached, and a render depth. */
export interface AuthoredEntity {
	"name": string;
	"components": string[];
	"depth": number;
}

/** The authored game — what a drag-and-drop session produces. */
export interface AuthoredGame {
	/** The level module (loaded from `./levels/<level>`). */
	"level": string;
	"entities": AuthoredEntity[];
	/** System behaviors to run each tick, in order. */
	"systems": string[];
	/** Where the Tilemap loader is imported from (defaults to the sample layout). */
	"tilemapImport"?: string;
}

/** dozer, as a block model — the starter template. Assembling THIS and generating reproduces the dozer game. */
export const dozerAuthored: AuthoredGame = {
	"level": "level1",
	"entities": [
		{ "name": "player", "components": ["MoveIntent", "Player"], "depth": 2 },
		{ "name": "boulder", "components": ["Pushable"], "depth": 1 },
		{ "name": "target", "components": ["Target"], "depth": 0 }
	],
	"systems": ["inputSystem", "movementSystem", "renderSystem", "winSystem"]
};

/** Seed an editable block model from a recognized game (read → write bridge): objects become entities, rules become the
 *  systems list. The level isn't recognized from code, so it defaults (dozer's `level1`). */
export function authoredFromModel(model: GameModel, level = "level1"): AuthoredGame {
	return {
		"level": level,
		"entities": model.objects.map((object) => ({ "name": object.name, "components": [...object.behaviors], "depth": object.depth ?? 0 })),
		"systems": model.rules.map((rule) => rule.name)
	};
}

/** The generated `game.ts` — the scene assembly, parameterized by the block model; wires the library, never the logic. */
function generateSceneFile(game: AuthoredGame): string {
	const tilemap = game.tilemapImport ?? "../../util/phaser/Tilemap";

	// Position is imported for setPosition; the rest come from the entities' attached components.
	const componentNames = new Set<string>(["Position"]);

	for (const entity of game.entities) {
		for (const component of entity.components) {
			componentNames.add(component);
		}
	}

	const componentImports = [...componentNames].map((name) => `import { ${name} } from "${COMPONENTS[name]?.from ?? "./schemas/" + name.toLowerCase()}";`).join("\n");
	const systemImports = game.systems.map((name) => `import { ${name} } from "${SYSTEMS[name]?.from ?? "./systems/" + name}";`).join("\n");
	const entityConfig = game.entities
		.map((entity) => `\t\t"${entity.name}": { "components": [${entity.components.join(", ")}], "depth": ${entity.depth}, "onSpawn": setPosition }`)
		.join(",\n");

	return `import { addComponent, createWorld } from "bitecs";
import { load } from "${tilemap}";
import { ${game.level} } from "./levels/${game.level}";
${componentImports}
${systemImports}

export const name = "${game.level}";

export function init(scene) {}

export function preload(scene) {
	scene.world = createWorld();

	function setPosition(eid, tx, ty) {
		addComponent(scene.world, eid, Position);
		Position.x[eid] = tx;
		Position.y[eid] = ty;
	}

	load(scene, "${game.level}", ${game.level}, {
${entityConfig}
	});
}

export function create(scene) {
	const { mapWidth, mapHeight } = scene.world.tileConfig;

	scene.game.scale.setGameSize(mapWidth, mapHeight);
	scene.world.cursors = scene.input.keyboard.createCursorKeys();
	scene.world.onWin = () => {
		scene.add.text(mapWidth / 2, mapHeight / 2, "You Win!", { "fontSize": "32px", "color": "#ffffff", "backgroundColor": "#000000", "padding": { "x": 16, "y": 8 } }).setOrigin(0.5).setDepth(10);
		scene.systems = [];
	};

	scene.systems = [${game.systems.join(", ")}];
}

export function preupdate(scene) {}

export function update(scene, time, delta) {
	for (const system of scene.systems) {
		system(scene.world);
	}
}
`;
}

/**
 * Generate all of a game's code files from its block model: the generated `game.ts`, plus the library component + system
 * files the used behaviors require. Returns `{ path → content }`; the level, assets, and entry (index.html) come from the
 * workspace/library, not here.
 */
export function generateGame(game: AuthoredGame): Record<string, string> {
	const files: Record<string, string> = {};

	// Components to emit: everything the entities attach, Position (setPosition), and each system's needs.
	const componentNames = new Set<string>(["Position"]);

	for (const entity of game.entities) {
		for (const component of entity.components) {
			componentNames.add(component);
		}
	}

	for (const system of game.systems) {
		for (const need of SYSTEMS[system]?.needs ?? []) {
			componentNames.add(need);
		}
	}

	for (const name of componentNames) {
		const component = COMPONENTS[name];

		if (component !== undefined) {
			files[component.file.path] = component.file.content;
		}
	}

	for (const system of game.systems) {
		const definition = SYSTEMS[system];

		if (definition !== undefined) {
			files[definition.file.path] = definition.file.content;
		}
	}

	files["game.ts"] = generateSceneFile(game);

	return files;
}
