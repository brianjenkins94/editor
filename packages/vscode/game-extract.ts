/**
 * Projection extraction — turns a game project's source into the plain `GameProjection` model, by querying the
 * BABLR CST via `game-cst`. Runs in the game-worker (off the main thread); the workbench never imports this or
 * `game-cst`, so the BABLR parser stays out of the workbench bundle.
 *
 * Every projected element that maps to a single source node carries that node's span, so the view can edit it
 * back surgically (paint a tile → replace one gid literal). It's a projection of the CST, not regex over text.
 */
import { arrayElements, callArguments, callsNamed, calleeName, findAll, identify, kids, numberValue, objectProperties, parse, stringValue } from "./game-cst";
import type { Identity, Node } from "./game-cst";
import type { Component, EntityType, GameProjection, Layer, Level, PlacedTile, ProjectSources, System, Tileset } from "./game-model";

/** Find a `new Ctor(...)` / `Ctor(...)` whose callee is `name`, returning its argument nodes. */
function constructorArgs(root: Node, name: string): Node[] | undefined {
	const call = findAll(root, (node) => (node.type === "NewExpression" || node.type === "CallExpression") && calleeName(node) === name)[0];

	return call === undefined ? undefined : callArguments(call);
}

/** The gid of a grid cell node (a Number), or 0 for a hole (`_`/undefined identifier). */
function cellGid(cell: Node): number {
	return cell.type === "Number" ? numberValue(cell) : 0;
}

/** Extract the level (Tilemap builder) into a Level model, with per-cell spans + stable node ids. */
export function extractLevel(file: string, code: string, identity: Identity): Level | undefined {
	const root = parse(code);
	const ctorArgs = constructorArgs(root, "Tilemap");

	if (ctorArgs === undefined) {
		return undefined;
	}

	const number = (node: Node | undefined, fallback: number): number => (node !== undefined && node.type === "Number" ? numberValue(node) : fallback);
	const width = number(ctorArgs[0], 0);
	const height = number(ctorArgs[1], 0);
	const tileW = number(ctorArgs[2], 32);
	const tileH = number(ctorArgs[3], 32);

	const tilesets: Tileset[] = callsNamed(root, "addTileset").map((call) => {
		const args = callArguments(call);

		return { "name": args[0] !== undefined ? stringValue(args[0]) : "", "url": args[1] !== undefined ? stringValue(args[1]) : "" };
	});

	// Each layer is one top-level statement chain: `level1.addLayer("l")…fill(n)` / `…bitblt(dx,dy,[[…]])`. Scope
	// the fill/bitblt to their statement so they bind to the right layer.
	const layers: Layer[] = [];

	for (const statement of findAll(root, (node) => node.type === "ExpressionStatement")) {
		const layerCall = callsNamed(statement, "addLayer")[0] ?? callsNamed(statement, "addObjectLayer")[0];

		if (layerCall === undefined) {
			continue;
		}

		const isObjectLayer = calleeName(layerCall) === "addObjectLayer";
		const nameArg = callArguments(layerCall)[0];
		const fillCall = callsNamed(statement, "fill")[0];
		const fillArg = fillCall !== undefined ? callArguments(fillCall)[0] : undefined;
		const tiles: PlacedTile[] = [];

		for (const bitblt of callsNamed(statement, "bitblt")) {
			const args = callArguments(bitblt);
			const dx = number(args[0], 0);
			const dy = number(args[1], 0);
			const grid = args[2] !== undefined ? arrayElements(args[2]).map((row) => arrayElements(row)) : [];

			// Replicate util/phaser/Tilemap.ts's exact placement math (its x/y transposition + inclusive bounds).
			for (let x = 0; x <= (grid[0]?.length ?? 0); x += 1) {
				for (let y = 0; y <= grid.length; y += 1) {
					const cell = grid[x]?.[y];

					if (cell === undefined) {
						continue;
					}

					const gid = cellGid(cell);

					if (gid === 0) {
						continue; // a hole — nothing placed (the span still exists if we later want to paint into it)
					}

					tiles.push({ "gid": gid, "tx": dx + y, "ty": dy + x, "span": { "file": file, "start": cell.start, "end": cell.end }, "nodeId": identity.idOf(cell) });
				}
			}
		}

		layers.push({ "name": nameArg !== undefined ? stringValue(nameArg) : "", "isObjectLayer": isObjectLayer, "fill": fillArg !== undefined && fillArg.type === "Number" ? numberValue(fillArg) : undefined, "tiles": tiles });
	}

	return { "file": file, "width": width, "height": height, "tileW": tileW, "tileH": tileH, "tilesets": tilesets, "layers": layers };
}

/** Extract an ECS component from one schema file (`export const X = {…}` / `= []`), anchored to its name node. */
export function extractComponent(code: string, identity: Identity): Component | undefined {
	const root = parse(code);
	const declarator = findAll(root, (node) => node.type === "VariableDeclarator")[0];

	if (declarator === undefined) {
		return undefined;
	}

	const nameNode = kids(declarator).find((child) => child.type === "Identifier");
	// The init may be wrapped (e.g. `{…} as const` → AsExpression), so descend to the first Object/Array.
	const init = findAll(declarator, (node) => node.type === "Object" || node.type === "Array")[0];

	if (nameNode === undefined || init === undefined) {
		return undefined;
	}

	const nodeId = identity.idOf(nameNode);

	if (init.type === "Array") {
		return { "name": nameNode.text, "kind": "tag", "fields": [], "nodeId": nodeId };
	}

	const properties = objectProperties(init);
	const isData = properties.some(([, value]) => /new\s|Array/u.test(value.text));

	return { "name": nameNode.text, "kind": isData ? "data" : "enum", "fields": properties.map(([key]) => key), "nodeId": nodeId };
}

/** Extract the object-spawn wiring from game.ts's `load(scene, name, level, { <obj>: {components, depth} })`,
 *  each anchored to its config Object node. */
export function extractEntities(gameCode: string, identity: Identity): EntityType[] {
	const root = parse(gameCode);
	const config = callArguments(callsNamed(root, "load")[0] ?? root).find((argument) => argument.type === "Object");

	if (config === undefined) {
		return [];
	}

	return objectProperties(config).map(([name, object]) => {
		const props = objectProperties(object);
		const components = props.find(([key]) => key === "components")?.[1];
		const depth = props.find(([key]) => key === "depth")?.[1];

		return {
			"name": name,
			"components": components !== undefined ? arrayElements(components).map((node) => node.text) : [],
			"depth": depth !== undefined && depth.type === "Number" ? numberValue(depth) : undefined,
			"nodeId": identity.idOf(object)
		};
	});
}

/** The Identifier nodes of `scene.systems = [a, b, c]` (the non-empty assignment) in execution order — each is
 *  the anchor a system's event-sheet row / breakpoint / disposition pins to. */
export function extractSystemNodes(gameCode: string): Node[] {
	const root = parse(gameCode);
	let best: Node[] = [];

	for (const assignment of findAll(root, (node) => node.type === "AssignmentExpression")) {
		const array = kids(assignment).find((child) => child.type === "Array");
		const target = kids(assignment).find((child) => child.type === "MemberExpression");

		if (array === undefined || target === undefined || kids(target).find((child) => child.field === "property")?.text !== "systems") {
			continue;
		}

		const nodes = arrayElements(array).filter((node) => node.type === "Identifier");

		if (nodes.length > best.length) {
			best = nodes;
		}
	}

	return best;
}

/** Parse one system file into its queries (component lists) + body (imports stripped, for the code preview). */
export function extractSystem(name: string, code: string): System {
	const root = parse(code);
	const queries = callsNamed(root, "query").map((call) => {
		const array = callArguments(call).find((argument) => argument.type === "Array");

		return array !== undefined ? arrayElements(array).map((node) => node.text) : [];
	});
	const body = code.split("\n").filter((line) => !/^\s*import\s/u.test(line)).join("\n").trim();

	return { "name": name, "queries": queries, "body": body };
}

/** systemName → its source-file basename (inputSystem → input.ts). */
export function systemFileBase(name: string): string {
	return name.replace(/System$/u, "");
}

/** Extract the whole projection from a project's sources. Tolerant of missing files. Each element is anchored to
 *  its stable BABLR node id, and every identified node's line is merged into `nodeLines` (id → line). */
export function extractProjection(sources: ProjectSources): GameProjection {
	const nodeLines: Record<string, number> = {};
	const merge = (identity: Identity): Identity => {
		Object.assign(nodeLines, identity.nodeLines);

		return identity;
	};

	const level = sources.levelFile !== undefined && sources.levelCode !== undefined
		? extractLevel(sources.levelFile, sources.levelCode, merge(identify(sources.levelCode)))
		: undefined;

	const components: Component[] = [];

	for (const schema of sources.schemas) {
		const component = extractComponent(schema.code, merge(identify(schema.code)));

		if (component !== undefined) {
			components.push(component);
		}
	}

	const objects: EntityType[] = [];
	const systems: System[] = [];

	if (sources.gameCode !== undefined) {
		const gameIdentity = merge(identify(sources.gameCode));

		for (const object of extractEntities(sources.gameCode, gameIdentity)) {
			objects.push(object);
		}

		const byBase = new Map(sources.systems.map((entry) => [entry.file.slice(entry.file.lastIndexOf("/") + 1).replace(/\.ts$/u, ""), entry.code]));

		for (const node of extractSystemNodes(sources.gameCode)) {
			const name = node.text;
			const code = byBase.get(systemFileBase(name));
			const parsed = code !== undefined ? extractSystem(name, code) : { "name": name, "queries": [], "body": "" };

			systems.push({ ...parsed, "nodeId": gameIdentity.idOf(node) });
		}
	}

	return { "level": level, "components": components, "objects": objects, "systems": systems, "nodeLines": nodeLines };
}
