/**
 * Game generator + starter behavior library — the AUTHOR direction (write), inverse of the recognizer (read).
 *
 * `generateGame` takes a block model (entities + their behaviors + which systems run + a painted level) and emits a
 * COMPLETE, runnable game: the constant infra (index.html, scene.ts, Tilemap.ts, package.json), the library files the
 * used behaviors provide (schemas + systems), the generated `levels/<level>.ts` (from the grid), and a thin generated
 * `game.ts` ASSEMBLY that wires it all. The heavy logic is never generated — it is VENDORED from the library (dozer's
 * reusable schemas + systems) — which is what makes a near-zero-typing, drag-and-drop build tractable (the
 * GameMaker/Construct insight): the author composes behaviors and paints a grid; they never hand-write movement/push.
 *
 * SINGLE SOURCE OF TRUTH: the constant infra + library files are pulled from the `dozer` sample (samples.ts) rather than
 * re-embedded here, so they can't drift from the code the editor actually ships and runs. Only `game.ts` (assembly) and
 * the level file are generated. The sprites live inline in the sample's level as data URLs; we parse them back out as the
 * asset palette, so a rebuilt game needs no binary files either.
 *
 * The generated code is designed to reverse-project cleanly: run recognizeGame over the output and you get the same map
 * the author assembled. That round-trip (author → generate → recognize → same map) is both the payoff and the test.
 */

import type { GameModel } from "./game-recognizer";
import { sampleById } from "./samples";

/** Import specifier + vendored-file path (relative to the game dir; also its subpath inside the dozer sample). */
interface ComponentMeta { "from": string; "path": string }
interface SystemMeta { "from": string; "path": string; "needs": string[] }

const COMPONENT_META: Record<string, ComponentMeta> = {
	"Position": { "from": "./schemas/position", "path": "schemas/position.ts" },
	"MoveIntent": { "from": "./schemas/moveIntent", "path": "schemas/moveIntent.ts" },
	"Direction": { "from": "./schemas/direction", "path": "schemas/direction.ts" },
	"Player": { "from": "./schemas/player", "path": "schemas/player.ts" },
	"Pushable": { "from": "./schemas/pushable", "path": "schemas/pushable.ts" },
	"Target": { "from": "./schemas/target", "path": "schemas/target.ts" }
};

const SYSTEM_META: Record<string, SystemMeta> = {
	"inputSystem": { "from": "./systems/input", "path": "systems/input.ts", "needs": ["MoveIntent", "Direction"] },
	"movementSystem": { "from": "./systems/movement", "path": "systems/movement.ts", "needs": ["MoveIntent", "Position", "Pushable", "Direction"] },
	"renderSystem": { "from": "./systems/render", "path": "systems/render.ts", "needs": ["Position"] },
	"winSystem": { "from": "./systems/win", "path": "systems/win.ts", "needs": ["Target", "Position", "Pushable"] }
};

/** The constant files every generated game vendors verbatim (infra that isn't authored). */
const INFRA_FILES = ["index.html", "scene.ts", "Tilemap.ts", "package.json"];

/** One placeable object archetype — the object palette. `type` is BOTH the entity name and the sprite/tileset name
 *  (load() spawns an object-layer entry by matching its name to the entityConfig key and the tileset), so one pick
 *  supplies name + behaviors + sprite with no typing. */
export interface ObjectPreset {
	"type": string;
	"sprite": string;
	"components": string[];
	"depth": number;
}

const OBJECT_PRESETS: ObjectPreset[] = [
	{ "type": "player", "sprite": "player", "components": ["MoveIntent", "Player"], "depth": 2 },
	{ "type": "boulder", "sprite": "boulder", "components": ["Pushable"], "depth": 1 },
	{ "type": "target", "sprite": "target", "components": ["Target"], "depth": 0 }
];

// ── the vendored dozer files, pulled from the sample catalog (one source of truth) ──────────────────────────────
const SAMPLE_PREFIX = "/workspace/samples/dozer/";
let dozerFileCache: Record<string, string> | undefined;

/** The dozer sample's files keyed by path RELATIVE to the game dir (e.g. "systems/input.ts"). */
function dozerFiles(): Record<string, string> {
	if (dozerFileCache === undefined) {
		const sample = sampleById("dozer");

		if (sample === undefined) {
			throw new Error("dozer sample not found — the generator vendors its library from it");
		}

		dozerFileCache = {};

		for (const file of sample.files) {
			if (file.path.startsWith(SAMPLE_PREFIX)) {
				dozerFileCache[file.path.slice(SAMPLE_PREFIX.length)] = file.contents;
			}
		}
	}

	return dozerFileCache;
}

let assetCache: Record<string, string> | undefined;

/** The sprite palette — tileset name → inline data-URL, parsed out of the sample level's `addTileset(...)` calls. */
export function spriteDataUrls(): Record<string, string> {
	if (assetCache === undefined) {
		assetCache = {};

		const source = dozerFiles()["levels/level1.ts"] ?? "";
		const pattern = /addTileset\("([^"]+)",\s*"(data:[^"]+)"\)/gu;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(source)) !== null) {
			assetCache[match[1]] = match[2];
		}
	}

	return assetCache;
}

/** The behaviors (components + systems) the author can attach — the palette. */
export function libraryComponents(): string[] {
	return Object.keys(COMPONENT_META);
}

export function librarySystems(): string[] {
	return Object.keys(SYSTEM_META);
}

/** The placeable object archetypes — the object palette. */
export function objectPresets(): ObjectPreset[] {
	return OBJECT_PRESETS;
}

/** One authored entity: a name, the component behaviors attached, and a render depth. */
export interface AuthoredEntity {
	"name": string;
	"components": string[];
	"depth": number;
}

/** One placed object instance on the grid: which archetype, and where (tile coords). */
export interface PlacedObject {
	"type": string;
	"x": number;
	"y": number;
}

/** The painted level: a grid of walkable FLOOR cells (everything else is a wall) and placed object instances. */
export interface AuthoredLevel {
	"width": number;
	"height": number;
	/** Tile size in px (square). */
	"tile": number;
	/** Walkable cells as [x, y]; a cell with no floor is a wall. */
	"floor": [number, number][];
	"objects": PlacedObject[];
}

/** The authored game — what a drag-and-drop / grid-painting session produces. */
export interface AuthoredGame {
	/** The level module name (emitted as `./levels/<level>`). */
	"level": string;
	"entities": AuthoredEntity[];
	/** System behaviors to run each tick, in order. */
	"systems": string[];
	/** The painted level. When present, the level file is generated from it; when absent, an existing level file on
	 *  disk is left untouched (e.g. Generate over a recognized game whose level wasn't recovered). */
	"map"?: AuthoredLevel;
	/** Where the Tilemap loader is imported from (defaults to the self-contained local copy). */
	"tilemapImport"?: string;
}

/** A blank but runnable game: infra + an empty level, no entities, no systems. The from-scratch starting point. */
export function blankGame(width = 20, height = 12, tile = 32): AuthoredGame {
	return { "level": "level1", "entities": [], "systems": [], "map": { width, height, tile, "floor": [], "objects": [] } };
}

/** dozer, as a block model — the starter template. Assembling THIS and generating reproduces the dozer game. */
export const dozerAuthored: AuthoredGame = {
	"level": "level1",
	"entities": [
		{ "name": "player", "components": ["MoveIntent", "Player"], "depth": 2 },
		{ "name": "boulder", "components": ["Pushable"], "depth": 1 },
		{ "name": "target", "components": ["Target"], "depth": 0 }
	],
	"systems": ["inputSystem", "movementSystem", "renderSystem", "winSystem"],
	"map": {
		"width": 20,
		"height": 12,
		"tile": 32,
		"floor": [[9, 3], [9, 4], [9, 5], [10, 5], [11, 5], [12, 5], [7, 6], [8, 6], [9, 6], [10, 6], [10, 7], [10, 8]],
		"objects": [
			{ "type": "player", "x": 10, "y": 6 },
			{ "type": "boulder", "x": 9, "y": 5 },
			{ "type": "boulder", "x": 11, "y": 5 },
			{ "type": "boulder", "x": 9, "y": 6 },
			{ "type": "boulder", "x": 10, "y": 7 },
			{ "type": "target", "x": 9, "y": 3 },
			{ "type": "target", "x": 12, "y": 5 },
			{ "type": "target", "x": 7, "y": 6 },
			{ "type": "target", "x": 10, "y": 8 }
		]
	}
};

/** Seed an editable block model from a recognized game (read → write bridge): objects become entities, rules become the
 *  systems list. The level isn't recognized from code, so `map` is left undefined (the on-disk level stays authoritative
 *  until the grid painter is opened). */
export function authoredFromModel(model: GameModel, level = "level1"): AuthoredGame {
	return {
		"level": level,
		"entities": model.objects.map((object) => ({ "name": object.name, "components": [...object.behaviors], "depth": object.depth ?? 0 })),
		"systems": model.rules.map((rule) => rule.name)
	};
}

/** The generated `game.ts` — the scene assembly, parameterized by the block model; wires the library, never the logic. */
function generateSceneFile(game: AuthoredGame): string {
	const tilemap = game.tilemapImport ?? "./Tilemap";

	// Position is imported for setPosition; the rest come from the entities' attached components.
	const componentNames = new Set<string>(["Position"]);

	for (const entity of game.entities) {
		for (const component of entity.components) {
			componentNames.add(component);
		}
	}

	const componentImports = [...componentNames].map((name) => `import { ${name} } from "${COMPONENT_META[name]?.from ?? "./schemas/" + name.toLowerCase()}";`).join("\n");
	const systemImports = game.systems.map((name) => `import { ${name} } from "${SYSTEM_META[name]?.from ?? "./systems/" + name}";`).join("\n");
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

/** The generated `levels/<level>.ts` — reconstructs the Tilemap from the painted grid: the sprite tilesets it uses, a
 *  background backdrop, the walkable floor layer, and the placed objects. Readable, house-style code (a coordinate list
 *  + a tiny paint loop), not an opaque blob — the visible code is a core value. */
function generateLevelFile(game: AuthoredGame): string {
	const map = game.map;

	if (map === undefined) {
		throw new Error("generateLevelFile requires an authored map");
	}

	const assets = spriteDataUrls();
	const presetBySprite = new Map(OBJECT_PRESETS.map((preset) => [preset.type, preset.sprite]));
	const spriteOf = (type: string): string => presetBySprite.get(type) ?? type;

	// Tileset order fixes the gids. Floor (gray_square) + backdrop (wall_block) are always present so painting works;
	// each distinct placed object's sprite follows.
	const objectSprites = [...new Set(map.objects.map((object) => spriteOf(object.type)))].filter((sprite) => sprite !== "wall_block" && sprite !== "gray_square");
	const tilesetOrder = ["wall_block", "gray_square", ...objectSprites].filter((name) => assets[name] !== undefined);

	const gid: Record<string, number> = {};

	tilesetOrder.forEach((name, index) => { gid[name] = index + 1; });

	const tilesetLines = tilesetOrder.map((name) => `${game.level}.addTileset("${name}", "${assets[name]}");`).join("\n");
	const gidEntries = tilesetOrder.map((name) => `"${name}": ${gid[name]}`).join(", ");
	const floorLines = map.floor.map(([x, y]) => `\t[${x}, ${y}]`).join(",\n");
	const objectLines = map.objects.map((object) => `\t["${spriteOf(object.type)}", ${object.x}, ${object.y}]`).join(",\n");

	return `import { Tilemap } from "../Tilemap";

export const ${game.level} = new Tilemap(${map.width}, ${map.height}, ${map.tile}, ${map.tile});

${tilesetLines}

const gid: Record<string, number> = { ${gidEntries} };

// A tiled backdrop, then the walkable floor. Any cell WITHOUT a floor tile is a wall (see Tilemap.load).
${game.level}.addLayer("background")
	.addProperty({ "name": "ge_charLayer", "type": "string", "value": "background" })
	.fill(gid.wall_block);

const floor = ${game.level}.addLayer("layer1")
	.addProperty({ "name": "ge_charLayer", "type": "string", "value": "layer1" });

for (const [x, y] of [
${floorLines}
] as [number, number][]) {
	floor.bitblt(x, y, [[gid.gray_square]]);
}

// Placed objects — spawned by load() into ECS entities via game.ts's entityConfig (keyed by these names).
const objects = ${game.level}.addObjectLayer("objects");

for (const [name, x, y] of [
${objectLines}
] as [string, number, number][]) {
	objects.bitblt(x, y, [[gid[name]]]);
}
`;
}

/**
 * Generate all of a game's code files from its block model: the constant infra, the library component + system files the
 * used behaviors require, the generated level (when a map is authored), and the generated `game.ts` assembly. Returns
 * `{ path → content }` — a complete, self-contained, runnable game.
 */
export function generateGame(game: AuthoredGame): Record<string, string> {
	const files: Record<string, string> = {};
	const vendored = dozerFiles();

	// Infra — constant, vendored verbatim.
	for (const path of INFRA_FILES) {
		if (vendored[path] !== undefined) {
			files[path] = vendored[path];
		}
	}

	// Components to emit: everything the entities attach, Position (setPosition), and each system's needs.
	const componentNames = new Set<string>(["Position"]);

	for (const entity of game.entities) {
		for (const component of entity.components) {
			componentNames.add(component);
		}
	}

	for (const system of game.systems) {
		for (const need of SYSTEM_META[system]?.needs ?? []) {
			componentNames.add(need);
		}
	}

	for (const name of componentNames) {
		const meta = COMPONENT_META[name];

		if (meta !== undefined && vendored[meta.path] !== undefined) {
			files[meta.path] = vendored[meta.path];
		}
	}

	// Systems — vendored verbatim (the heavy behavior logic).
	for (const system of game.systems) {
		const meta = SYSTEM_META[system];

		if (meta !== undefined && vendored[meta.path] !== undefined) {
			files[meta.path] = vendored[meta.path];
		}
	}

	// Level — generated from the painted grid (when authored).
	if (game.map !== undefined) {
		files["levels/" + game.level + ".ts"] = generateLevelFile(game);
	}

	// Assembly.
	files["game.ts"] = generateSceneFile(game);

	return files;
}
