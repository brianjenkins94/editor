/**
 * Bundled sample projects for the shell's LHS project picker (the pre-auth, offline source of "projects").
 *
 * These ship in the app bundle — zero network, no GitHub — and are the first source the picker offers; public
 * GitHub repos (Trees API + raw.githubusercontent) become a second source later, and sign-in/commit-back later
 * still. The catalog lives HERE (app side, next to the VFS) rather than in the shell, so the shell only sends a
 * project id over the hub and the app resolves it to files — keeping file contents off the postMessage channel.
 *
 * Files mount UNDER the existing `/workspace` root (namespaced by sample id), so the workspace's managed
 * `tsconfig.json` applies and the in-browser TS server type-checks them. Opening a sample writes its files and
 * focuses its entry; see workbench-entry.tsx `openProject`.
 */

/** One file in a sample project. Matches the snapshot file shape (path + contents). */
export interface SampleFile { "path": string; "contents": string }

/** A bundled sample project the picker can open. */
export interface Sample {
	"id": string;
	"name": string;
	"description": string;
	"files": SampleFile[];
	/** Files (absolute paths) to open + focus once the sample is written. */
	"openEditors": string[];
}

/** Metadata-only view sent to the shell over the hub (no file contents). */
export interface SampleInfo { "id": string; "name": string; "description": string }

const HELLO = `// A tiny starter. Edit me — saves flow back to the host over the pane bus.
function greet(name: string): string {
	return \`Hello, \${name}!\`;
}

for (const who of ["world", "editor", "capabilities"]) {
	console.log(greet(who));
}
`;

const CAPABILITIES = `// A sample for the capability IDE. Run it under the tsval debugger (F5) and a gated capability call
// HARD-STOPS at its line — the enforce end of the pipeline (detect → resolve → surface → enforce).
import { spawn } from "node:child_process";

// STATIC: a literal URL — flagged inline even though this isn't called at load.
export async function health(): Promise<Response> {
	return fetch("https://api.example.com/health");
}

// DYNAMIC: computed resources the static half can't resolve — the canary resolves them at runtime.
const region = "us-east";
const version = "v2";
export const config = fetch("https://" + region + ".api.example.com/" + version + "/config");

const tool = ["n", "p", "m"].join(""); // "npm"
spawn(tool, ["run", "build"]);
`;

const FIZZBUZZ = `// Classic FizzBuzz — a self-contained loop to poke at with the debugger.
function fizzbuzz(n: number): string {
	if (n % 15 === 0) { return "FizzBuzz"; }
	if (n % 3 === 0) { return "Fizz"; }
	if (n % 5 === 0) { return "Buzz"; }

	return String(n);
}

for (let i = 1; i <= 20; i += 1) {
	console.log(fizzbuzz(i));
}
`;

const DOZER_FILES: SampleFile[] = [
	{ "path": "/workspace/samples/dozer/package.json", "contents": `{
	"name": "dozer",
	"type": "module",
	"scripts": {
		"dev": "vite"
	},
	"dependencies": {
		"phaser": "4.2.1",
		"bitecs": "0.4.0"
	}
}
` },
	// eslint-disable-next-line webawesome/no-html-in-strings -- sample project FILE CONTENTS (a real index.html the editor loads as data), not app chrome
	{ "path": "/workspace/samples/dozer/index.html", "contents": `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Dozer</title>
	<style>
		html, body { margin: 0; height: 100%; background: #000; }
		#app { width: 100%; height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
		#game-container { display: flex; justify-content: center; align-items: center; }
	</style>
</head>
<body>
	<div id="app"><div id="game-container"></div></div>
	<script type="module">
		import Phaser from "phaser";
		import { createScene } from "./scene.ts";
		import * as game from "./game.ts";

		const phaserGame = new Phaser.Game({
			"type": Phaser.AUTO,
			"render": { "pixelArt": true },
			"parent": "game-container",
			"scale": { "mode": Phaser.Scale.FIT },
			"scene": createScene(game)()
		});

		function resize() {
			const canvas = document.querySelector("canvas");
			if (!canvas) { return; }
			const height = canvas.parentElement.clientHeight;
			const ratio = phaserGame.config.width / phaserGame.config.height;
			canvas.style.width = (height * ratio) + "px";
			canvas.style.height = height + "px";
		}
		phaserGame.events.on("ready", resize);
		window.addEventListener("resize", resize);
	</script>
</body>
</html>
` },
	{ "path": "/workspace/samples/dozer/scene.ts", "contents": `/**
 * Functional Phaser scenes.
 *
 * Instead of subclassing \`Phaser.Scene\`, a game is a plain module of free functions — \`init\`, \`preload\`,
 * \`preupdate\`, \`create\`, \`update\` — each taking the scene as its first argument.  This keeps game logic
 * decoupled from Phaser's class machinery (the functions are trivially unit-testable and shareable).
 *
 * \`createScene\` turns such a module into the scene factory Phaser's game config expects, replacing the
 * hand-rolled \`scene: function() { … }\` block each game's index.html used to carry (see games/dozer).
 */
import Phaser from "phaser";

// The scene carries a couple of convenience bags games hang state on.  \`systems\` is the per-tick system
// list update() runs; \`components\` is a free-form registry.  (\`world\` is declared by Tilemap.ts.)
declare module "phaser" {
	interface Scene {
		"components": Record<string, unknown>;
		"systems": ((world: any) => void)[];
	}
}

/**
 * A game expressed as lifecycle functions.  Every hook is optional except a \`name\` (the scene key).
 * Each receives the live \`Phaser.Scene\`; \`init\`/\`preload\`/\`create\` also forward Phaser's own args.
 */
export interface GameModule {
    /** Scene key. */
	"name": string;
	"init"?: (scene: Phaser.Scene, ...args: any[]) => void;
	"preload"?: (scene: Phaser.Scene, ...args: any[]) => void;
    /** Runs once, on the first \`preupdate\` after \`preload\` — for setup that needs loaded assets. */
	"preupdate"?: (scene: Phaser.Scene) => void;
	"create"?: (scene: Phaser.Scene, ...args: any[]) => void;
	"update"?: (scene: Phaser.Scene, time: number, delta: number) => void;
}

/**
 * Build a Phaser scene factory from a game module.  Returns the \`() => Phaser.Scene\` callback Phaser's
 * config expects: it constructs a bare \`Phaser.Scene(name)\`, seeds the \`components\`/\`systems\` bags, and
 * points each lifecycle hook at the module's function (injecting the scene).  \`preupdate\` is fired once,
 * after the first \`preload\`, via Phaser's \`preupdate\` event.
 */
export function createScene(mod: GameModule): () => Phaser.Scene {
	return () => {
		const scene = new Phaser.Scene(mod.name);

		scene.components = {};
		scene.systems = [];

		scene.init = (...args: any[]) => { mod.init?.(scene, ...args); };
		scene.preload = (...args: any[]) => {
			mod.preload?.(scene, ...args);
			if (mod.preupdate) { scene.events.once("preupdate", () => { mod.preupdate(scene); }); }
		};

		scene.create = (...args: any[]) => { mod.create?.(scene, ...args); };
		scene.update = (time: number, delta: number) => { mod.update?.(scene, time, delta); };

		return scene;
	};
}
` },
	{ "path": "/workspace/samples/dozer/Tilemap.ts", "contents": `import { addComponent, addEntity } from "bitecs";
import Phaser from "phaser";

// https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare module "phaser" {
	interface Scene {
		"world": any;
		"systems": ((world: any) => void)[];
	}
}

class Layer {
	data: number[];
	height: number;
	id: number;
	name: string;
	opacity = 1;
	type = "tilelayer";
	visible = true;
	width: number;
	x = 0;
	y = 0;
	properties?: object[];

	constructor(name: string, tilemap: Tilemap) {
		this.data = new Array(tilemap.width * tilemap.height).fill(0);
		this.height = tilemap.height;
		this.id = tilemap.nextlayerid;
		this.name = name;
		this.width = tilemap.width;
	}

	addProperty(property: object) {
		this.properties ??= [];
		this.properties.push(property);

		return this;
	}

	fill(gid: number) {
		this.data = this.data.fill(gid);

		return this;
	}

	bitblt(dx: number, dy: number, source: (number | undefined)[][]) {
		for (let x = 0; x <= source[0].length; x++) {
			for (let y = 0; y <= source.length; y++) {
				if (source[x]?.[y] !== undefined) {
					this.data[((dy + x) * this.width) + dx + y] = source[x][y];
				}
			}
		}

		return this;
	}
}

export class Tilemap {
	compressionlevel = -1;
	height: number;
	infinite = false;
	layers: any[] = [];
	nextlayerid = 1;
	nextobjectid = 1;
	orientation = "orthogonal";
	renderorder = "right-down";
	tiledversion = "1.11.0";
	tileheight: number;
	tilesets: any[] = [];
	tilewidth: number;
	type = "map";
	version = "1.10";
	width: number;

	constructor(width: number, height: number, tileWidth = 32, tileHeight = 32) {
		this.width = width;
		this.height = height;
		this.tilewidth = tileWidth;
		this.tileheight = tileHeight;
	}

	addTileset(name: string, imagePath: string, tileProperties: object[] = []) {
		this.tilesets.push({
			"columns": 1,
            // FIXME: This assumes one tile per tileset.
			"firstgid": this.tilesets.length + 1,
			"image": imagePath,
			"imageheight": this.tileheight,
			"imagewidth": this.tilewidth,
			"margin": 0,
			"name": name,
			"spacing": 0,
			"tilecount": 1,
			"tileheight": this.tileheight,
			"tilewidth": this.tilewidth,
			"tiles": tileProperties
		});
		this.nextobjectid += 1;
	}

	addLayer(name: string) {
		this.layers.push(new Layer(name, this));
		this.nextlayerid += 1;

		return this.layers.at(-1) as Layer;
	}

	addObjectLayer(name: string) {
		const parent = this;

		class ObjectLayer {
			draworder = "topdown";
			id = 8;
			name: string;
			objects: object[] = [];
			opacity = 1;
			type = "objectgroup";
			visible = true;
			x = 0;
			y = 0;
			properties?: object[];

			constructor(n: string) { this.name = n; }

			addProperty(property: object) {
				this.properties ??= [];
				this.properties.push(property);

				return this;
			}

			addObject(gid: number, x: number, y: number) {
				this.objects.push({
					"gid": gid,
					"height": parent.tileheight,
                    // FIXME: This assumes one tile per tileset.
                    // It might be better to use the name for lookup.
					"id": (this.objects as any[]).length + 1,
					"name": parent.tilesets.find((ts) => ts.firstgid === gid)["name"],
					"rotation": 0,
					"type": "",
					"visible": true,
					"width": parent.tilewidth,
					"x": x * parent.tilewidth,
					"y": y * parent.tileheight
				});
			}

			bitblt(dx: number, dy: number, source: (number | undefined)[][]) {
				for (let x = 0; x <= source[0].length; x++) {
					for (let y = 0; y <= source.length; y++) {
						if (source[x]?.[y] !== undefined) {
							this.addObject(source[x][y], dx + y, dy + x);
						}
					}
				}

				return this;
			}
		}

		this.layers.push(new ObjectLayer(name));
		this.nextlayerid += 1;

		return this.layers.at(-1) as ObjectLayer;
	}
}

// entityConfig maps object-layer names to component refs and an optional
// onSpawn callback for setting initial component data (e.g. Position x/y).
export type EntityConfig = Record<string, {
	"components"?: any[];
	"depth"?: number;
	"onSpawn"?: (eid: number, tx: number, ty: number) => void;
}>;

export function load(
	scene: Phaser.Scene,
	levelName: string,
	tilemapData: Tilemap,
	entityConfig: EntityConfig
) {
	scene.cache.tilemap.add(levelName, {
		"format": Phaser.Tilemaps.Formats.TILED_JSON,
		"data": tilemapData
	});

	for (const { name, image } of tilemapData.tilesets) {
		scene.load.image(name, image);
	}

	scene.load.once("complete", function() {
		const { world } = scene;

        // ── Visual tile layers ────────────────────────────────────────────────
		const map = scene.make.tilemap({ "key": levelName });

		for (const { name, tilewidth, tileheight, margin, spacing } of tilemapData.tilesets) {
			map.addTilesetImage(
				name,
				name,
				tilewidth,
				tileheight,
				margin,
				spacing
			);
		}

		for (const layerData of tilemapData.layers) {
			if (layerData.type !== "tilelayer") { continue; }
			map.createLayer(layerData.name, map.tilesets);
		}

        // ── Resources on the world ────────────────────────────────────────────
		world.sprites = new Map<number, Phaser.GameObjects.Sprite>();
		world.tileConfig = {
			"tileWidth": tilemapData.tilewidth,
			"tileHeight": tilemapData.tileheight,
			"mapWidth": tilemapData.width * tilemapData.tilewidth,
			"mapHeight": tilemapData.height * tilemapData.tileheight
		};

        // Non-background tile layers paint the *floor* (walkable area).
        // Every map position that has no floor tile is a wall.
		const floor = new Set<string>();

		for (const layerData of tilemapData.layers) {
			if (layerData.type !== "tilelayer" || layerData.name === "background") { continue; }
			for (let i = 0; i < layerData.data.length; i++) {
				if (layerData.data[i] !== 0) {
					floor.add(\`\${i % layerData.width},\${Math.floor(i / layerData.width)}\`);
				}
			}
		}

		world.walls = new Set<string>();
		for (let ty = 0; ty < tilemapData.height; ty++) {
			for (let tx = 0; tx < tilemapData.width; tx++) {
				if (!floor.has(\`\${tx},\${ty}\`)) {
					world.walls.add(\`\${tx},\${ty}\`);
				}
			}
		}

        // ── ECS entity spawning ───────────────────────────────────────────────
		for (const layerData of tilemapData.layers) {
			if (layerData.type !== "objectgroup") { continue; }

			for (const obj of layerData.objects as any[]) {
				const config = entityConfig[obj.name];

				if (!config) { continue; }

				const tx = Math.round(obj.x / tilemapData.tilewidth);
				const ty = Math.round(obj.y / tilemapData.tileheight);

				const eid = addEntity(world);

				const sprite = scene.add.sprite(
					tx * tilemapData.tilewidth + tilemapData.tilewidth / 2,
					ty * tilemapData.tileheight + tilemapData.tileheight / 2,
					obj.name
				);

				if (config.depth !== undefined) { sprite.setDepth(config.depth); }
				world.sprites.set(eid, sprite);

				for (const component of config.components ?? []) {
					addComponent(world, eid, component);
				}

				config.onSpawn?.(eid, tx, ty);
			}
		}
	});
}
` },
	{ "path": "/workspace/samples/dozer/game.ts", "contents": `import { addComponent, createWorld } from "bitecs";
import { load } from "./Tilemap";
import { level1 } from "./levels/level1";

import { MoveIntent } from "./schemas/moveIntent";
import { Player } from "./schemas/player";
import { Position } from "./schemas/position";
import { Pushable } from "./schemas/pushable";

import { Target } from "./schemas/target";
import { inputSystem } from "./systems/input";
import { movementSystem } from "./systems/movement";
import { renderSystem } from "./systems/render";
import { winSystem } from "./systems/win";

export const name = "level1";

export function init(_scene) {}

export function preload(scene) {
	scene.world = createWorld();

	function setPosition(eid: number, tx: number, ty: number) {
		addComponent(scene.world, eid, Position);
		Position.x[eid] = tx;
		Position.y[eid] = ty;
	}

	load(scene, "level1", level1, {
		"player": { "components": [MoveIntent, Player], "depth": 2, "onSpawn": setPosition },
		"boulder": { "components": [Pushable], "depth": 1, "onSpawn": setPosition },
		"target": { "components": [Target], "depth": 0, "onSpawn": setPosition }
	});
}

export function create(scene) {
	const { mapWidth, mapHeight } = scene.world.tileConfig;

	scene.game.scale.setGameSize(mapWidth, mapHeight);

    // Keyboard cursors live on the world so systems only need \`world\`.
	scene.world.cursors = scene.input.keyboard!.createCursorKeys();
	scene.world.onWin = () => {
		scene.add.text(mapWidth / 2, mapHeight / 2, "You Win!", {
			"fontSize": "32px",
			"color": "#ffffff",
			"backgroundColor": "#000000",
			"padding": { "x": 16, "y": 8 }
		}).setOrigin(0.5).setDepth(10);
		scene.systems = [];
	};

	scene.systems = [inputSystem, movementSystem, renderSystem, winSystem];
}

export function preupdate(_scene) {}

export function update(scene, _time, _delta) {
	for (const system of scene.systems) {
		system(scene.world);
	}
}
` },
	{ "path": "/workspace/samples/dozer/schemas/direction.ts", "contents": `// None = 0 so uninitialized TypedArray slots mean "no intent".
export const Direction = {
	"None": 0,
	"Up": 1,
	"Right": 2,
	"Down": 3,
	"Left": 4
} as const;
` },
	{ "path": "/workspace/samples/dozer/schemas/position.ts", "contents": `export const Position = {
	"x": new Uint8Array(1024),
	"y": new Uint8Array(1024)
};
` },
	{ "path": "/workspace/samples/dozer/schemas/player.ts", "contents": `// Tag component — no data, just marks the player entity.
export const Player: number[] = [];
` },
	{ "path": "/workspace/samples/dozer/schemas/moveIntent.ts", "contents": `export const MoveIntent = {
	"direction": new Uint8Array(1024)
};
` },
	{ "path": "/workspace/samples/dozer/schemas/pushable.ts", "contents": `// Tag component — marks entities the player can push (boulders).
export const Pushable: number[] = [];
` },
	{ "path": "/workspace/samples/dozer/schemas/target.ts", "contents": `// Tag component — marks goal tiles that boulders must be pushed onto.
export const Target: number[] = [];
` },
	{ "path": "/workspace/samples/dozer/levels/level1.ts", "contents": `import { Tilemap } from "../Tilemap";

const _ = undefined;

export const level1 = new Tilemap(20, 12);

level1.addTileset("wall_block", "data:image/png;base64,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");
level1.addTileset("boulder", "data:image/png;base64,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");
level1.addTileset("gray_square", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsIAAA7CARUoSoAAAAA0SURBVFhH7c6hAQAgEMSwg/23usHAsMMLUlOb1fZksP0+FgAAAAAAAAAAAAAAAADA74DkAve8A4iSjVtsAAAAAElFTkSuQmCC");
level1.addTileset("target", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsIAAA7CARUoSoAAAAEgSURBVFhHzZZLDsIwDETbHoE17OD+B2LJGq4AGDUoTfwZD0HwNlRqPDNxHNH5/mRKcDuc1ied3eW8PmFAASJTCySMG4A1bvGCLOtvxyhzwdNSA4w0L1ia3REg5lZLmdpNgEgAnfCMzjuAV4QatyCaYQDNfOTa1xCOEBS0d5qGUNaa17BFCjzzArquYAawkqPUITytBd3VNxBdtQN1Ys9c1nm7Q7oAz0BLLeiFiKACaIZsCLoDo6ACaHPBDirdgdqQNRfm6/6ofpDUZ8oaIBoLMjzsgEWIrnkEn7RVQDsIz0CmC5m1P/87/p8PEsErENAgGZ1NACEqFqwgTG0XQECEGLTg6i1AW53B0jSv4cgQnpZ6BC3skSCbgALUZCY8Zpoe9Q/MhkWd6cIAAAAASUVORK5CYII=");
level1.addTileset("player", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFWSURBVEhLzZNtbsJADEQ5ek/EGfjLqYKXGXvtteMkKkI8uSj1xzwRtbft/rxVSP9S8Swy+pj9RTBrLg2/xmMFUwoy7qwrv5kZfU0JYCzI47Z15XaLkCnIcOuEgHsVU/CIWCfEyYGV62OzDLki8OmoS4IMlop0wOcgyHTfAG8WEfKCGwE2y5BOAJAeBKMZHAaPFel0AvRrgVQUdCGYZQ4EVvIjn00IZpQqnL3vzwt4rLD/uwL25Uk+DwUZE+w5kO4FmSmgVOFMIyDwDv4aBTxW2N+bAUR4h5WNDB4r0ukE+P+0FKkyffTfHAgyWPJBe4VNnkW6b4CHJassbJYhXxRk8GaXrLKwybPIFGDJwFiQxyVuKZ/MY0U63TdQ8XHZcmYKKFU40768UDyMo6rZhWCWkb6dIeuwmRl9jPdKlk4K9uqLAln9IDPW0pe/v3+WOabg44zk+/MFYuw1W//IPqMAAAAASUVORK5CYII=");

level1.addLayer("background")
	.addProperty({
		"name": "ge_charLayer",
		"type": "string",
		"value": "background"
	})
	.fill(1);

level1.addLayer("layer1")
	.addProperty({
		"name": "ge_charLayer",
		"type": "string",
		"value": "layer1"
	})
	.bitblt(7, 3, [
		[_, _, 3, _, _, _],
		[_, _, 3, _, _, _],
		[_, _, 3, 3, 3, 3],
		[3, 3, 3, 3, _, _],
		[_, _, _, 3, _, _],
		[_, _, _, 3, _, _]
	]);

level1.addObjectLayer("objects")
	.bitblt(7, 3, [
		[_, _, 4, _, _, _],
		[_, _, _, _, _, _],
		[_, _, 2, _, 2, 4],
		[4, _, 2, 5, _, _],
		[_, _, _, 2, _, _],
		[_, _, _, 4, _, _]
	]);
` },
	{ "path": "/workspace/samples/dozer/systems/input.ts", "contents": `import Phaser from "phaser";
import { query } from "bitecs";
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
` },
	{ "path": "/workspace/samples/dozer/systems/movement.ts", "contents": `import { query } from "bitecs";
import { Direction } from "../schemas/direction";
import { MoveIntent } from "../schemas/moveIntent";
import { Position } from "../schemas/position";
import { Pushable } from "../schemas/pushable";

const deltas: Record<number, [number, number]> = {
	[Direction.Up]: [0, -1],
	[Direction.Right]: [1, 0],
	[Direction.Down]: [0, 1],
	[Direction.Left]: [-1, 0]
};

function entityAt(world, x: number, y: number, exclude = -1): number | undefined {
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

		if (!dir) { continue; } // Direction.None === 0

		const [dx, dy] = deltas[dir];
		const x = Position.x[eid];
		const y = Position.y[eid];
		const nx = x + dx;
		const ny = y + dy;

		if (walls.has(\`\${nx},\${ny}\`)) {
			MoveIntent.direction[eid] = Direction.None;
			continue;
		}

		const pushedEid = entityAt(world, nx, ny);

		if (pushedEid !== undefined) {
			const bx = nx + dx;
			const by = ny + dy;

			if (walls.has(\`\${bx},\${by}\`) || entityAt(world, bx, by, pushedEid) !== undefined) {
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
` },
	{ "path": "/workspace/samples/dozer/systems/render.ts", "contents": `import { query } from "bitecs";
import { Position } from "../schemas/position";

export function renderSystem(world) {
	const { sprites, "tileConfig": { tileWidth, tileHeight } } = world;

	for (const eid of query(world, [Position])) {
		const sprite = sprites.get(eid);

		if (!sprite) { continue; }

		sprite.x = Position.x[eid] * tileWidth + tileWidth / 2;
		sprite.y = Position.y[eid] * tileHeight + tileHeight / 2;
	}
}
` },
	{ "path": "/workspace/samples/dozer/systems/win.ts", "contents": `import { query } from "bitecs";
import { Position } from "../schemas/position";
import { Pushable } from "../schemas/pushable";
import { Target } from "../schemas/target";

export function winSystem(world) {
	const targets = new Set<string>();

	for (const eid of query(world, [Target, Position])) {
		targets.add(\`\${Position.x[eid]},\${Position.y[eid]}\`);
	}

	if (!targets.size) { return; }

	for (const eid of query(world, [Pushable, Position])) {
		if (!targets.has(\`\${Position.x[eid]},\${Position.y[eid]}\`)) { return; }
	}

	world.onWin?.();
}
` },
];

export const SAMPLES: Sample[] = [
	{
		"id": "dozer",
		"name": "Dozer",
		"description": "A tiny Sokoban on bitECS + Phaser — the game-maker reference target.",
		"files": DOZER_FILES,
		"openEditors": ["/workspace/samples/dozer/game.ts"]
	},
	{
		"id": "hello",
		"name": "Hello, TypeScript",
		"description": "A minimal starter — one function, a loop, a console.",
		"files": [{ "path": "/workspace/samples/hello/main.ts", "contents": HELLO }],
		"openEditors": ["/workspace/samples/hello/main.ts"]
	},
	{
		"id": "capabilities",
		"name": "Capability demo",
		"description": "fetch + spawn with computed resources — the capability IDE's showcase.",
		"files": [{ "path": "/workspace/samples/capabilities/capabilities.ts", "contents": CAPABILITIES }],
		"openEditors": ["/workspace/samples/capabilities/capabilities.ts"]
	},
	{
		"id": "fizzbuzz",
		"name": "FizzBuzz",
		"description": "A tiny loop to step through in the debugger.",
		"files": [{ "path": "/workspace/samples/fizzbuzz/fizzbuzz.ts", "contents": FIZZBUZZ }],
		"openEditors": ["/workspace/samples/fizzbuzz/fizzbuzz.ts"]
	}
];

/** The metadata list the picker renders (no file contents). */
export function sampleList(): SampleInfo[] {
	return SAMPLES.map(({ id, name, description }) => ({ "id": id, "name": name, "description": description }));
}

/** Resolve a sample by id (undefined when unknown). */
export function sampleById(id: string): Sample | undefined {
	return SAMPLES.find((sample) => sample.id === id);
}
