/**
 * The ECA grammar + compiler — the AUTHOR model for Handmade (the kids' maker-space; see the event-sheet vision).
 *
 * This is the FIRST TEST of the whole thesis, on paper then in code. A game's behavior is composed from a small, fixed
 * toolbox of primitive EVENTS, CONDITIONS, and ACTIONS (the vocabulary GameMaker / Construct / StarCraft already settled),
 * connected by Automator-style INTERLOCK — each step binds typed values into scope that later steps consume. Nothing
 * high-level is pre-made.
 *
 * KEY IDEA (the built-in library): a BEHAVIOR is a reusable FUNCTION composed of those same primitives — exactly what our
 * built-ins are, and exactly what a kid could open, own, or write themselves. So "push a rock" is not opaque magic handed
 * down; it is `gridPush` below, built from `if the cell ahead has a rock, and the cell beyond is free, move it, then move
 * me`. A RULE then COMPOSES a behavior: "for each Player, on a pressed direction, grid-push." Rules and behaviors are the
 * same material at two scales.
 *
 * The payoff and the test: `compileGame` lowers the composition to readable ECS (behaviors → `behaviors/`, rules →
 * `systems/`), and `recognizeGame` (game-recognizer.ts) reads the systems back into the same rules — so the blocks and the
 * code are two views of one thing (the round-trip). No UI here; this proves the model before any is built. The compiled
 * code mirrors the dozer sample's proven systems (walls on `world.walls`, cursors on `world.cursors`, bitECS `query`) so it
 * runs by construction, and uses string concatenation over template literals only so the strings embed cleanly, exactly as
 * game-generator.ts does.
 */

// ── the primitive vocabulary (a subset, typed for the interlock) ────────────────────────────────────────────────

/** A statement in a per-entity body (a rule's or a behavior's). Each may CONSUME typed values in scope and BIND new ones
 *  (the interlock): `me` (the acting entity — the loop entity in a rule, the `self` parameter in a behavior) and `dir` (a
 *  Direction) are seeded by the caller; cells and found entities are bound here. */
export type Stmt =
	/** Bind a Cell = the cell one step in `dir` from an entity in scope ("the cell ahead of me / of the rock"). */
	| { "let": string; "cellAheadOf": string }
	/** Guard: if the cell is a wall, stop ("walls stop you"). */
	| { "ifWall": string }
	/** Guard: if the cell is blocked — a wall, or a solid of type `by` other than `ignoring` — stop. */
	| { "ifBlocked": string; "by": string; "ignoring": string }
	/** Condition that BINDS: if the cell holds an `a` (a component type), bind it as `bind` and run `then` ("if it has a Rock"). */
	| { "ifHas": string; "a": string; "bind": string; "then": Stmt[] }
	/** Action: move an entity in scope onto a cell in scope. */
	| { "move": string; "to": string }
	/** Compose a reusable behavior on the acting entity ("grid-push me in dir"). */
	| { "use": string };

/** A reusable behavior = a named function composed of primitives, applied to an entity + direction. THIS is what a
 *  built-in is: transparent, ownable, and buildable by the kid from the same toolbox. Compiles to `behaviors/<name>.ts`. */
export interface Behavior {
	"name": string;
	"body": Stmt[];
}

/** A per-entity rule: for each entity matching the subject, on this event, run the body. `subject` is the specificity
 *  dial — a component/tag that scopes the query (and names `me`); "any Mover" broadens it, "the Player" narrows it. */
export interface PerEntityRule {
	"kind": "perEntity";
	"name": string;
	"subject": string;
	"on": "keyDirection" | "step";
	"body": Stmt[];
}

/** An aggregate rule: on this event, if every `allOn` is standing on a `goal`, win. Not per-entity — it reads whole sets. */
export interface AggregateRule {
	"kind": "aggregate";
	"name": string;
	"on": "step";
	"allOn": string;
	"goal": string;
}

export type Rule = PerEntityRule | AggregateRule;

// ── the built-in library: behaviors, each composed of primitives ────────────────────────────────────────────────

/** Grid movement with pushing — a built-in, but nothing more than primitives: the cell ahead, walls stop you, and if a
 *  Pushable is there, push it when the cell beyond is free. A kid could build this, and could open it to see there is no
 *  magic. */
export const gridPush: Behavior = {
	"name": "gridPush",
	"body": [
		{ "let": "target", "cellAheadOf": "me" },
		{ "ifWall": "target" },
		{ "ifHas": "target", "a": "Pushable", "bind": "rock", "then": [
			{ "let": "past", "cellAheadOf": "rock" },
			{ "ifBlocked": "past", "by": "Pushable", "ignoring": "rock" },
			{ "move": "rock", "to": "past" }
		] },
		{ "move": "me", "to": "target" }
	]
};

/** dozer's built-in library. */
export const dozerBehaviors: Behavior[] = [gridPush];

/** The built-in behavior library a rule can COMPOSE — reusable functions of primitives, each one a kid can open and fork.
 *  (Authoring a behavior's own primitive body in the UI is a later slice; for now the library provides them.) */
export function builtinBehaviors(): Behavior[] {
	return [gridPush];
}

/** The behavior names these rules compose (via `use`) — so the generator knows which behaviors to emit alongside them. */
export function behaviorsUsedBy(rules: Rule[]): string[] {
	const used = new Set<string>();

	const walk = (body: Stmt[]): void => {
		for (const statement of body) {
			if ("use" in statement) {
				used.add(statement.use);
			} else if ("ifHas" in statement) {
				walk(statement.then);
			}
		}
	};

	for (const rule of rules) {
		if (rule.kind === "perEntity") {
			walk(rule.body);
		}
	}

	return [...used];
}

// ── dozer, composed: rules that pick a subject + event and compose a behavior ────────────────────────────────────

/** Move & push: the Player, on a pressed direction, composes the gridPush behavior. */
export const dozerMove: PerEntityRule = {
	"kind": "perEntity",
	"name": "playerMove",
	"subject": "Player",
	"on": "keyDirection",
	"body": [{ "use": "gridPush" }]
};

/** Win: on every tick, if every Pushable is on a Target, win. */
export const dozerWin: AggregateRule = {
	"kind": "aggregate",
	"name": "winSystem",
	"on": "step",
	"allOn": "Pushable",
	"goal": "Target"
};

/** dozer as a rule-set — the input to the compiler (with dozerBehaviors as its library). */
export const dozerRules: Rule[] = [dozerMove, dozerWin];

// ── the compiler ────────────────────────────────────────────────────────────────────────────────────────────────

/** The runtime helpers the primitives lower to — the toolbox's small, fixed support code. Emitted only when used. */
const HELPERS: Record<string, string> = {
	"pressed": [
		"function pressed(world) {",
		"\tconst { cursors } = world;",
		"",
		"\tif (Phaser.Input.Keyboard.JustDown(cursors.up)) { return { x: 0, y: -1 }; }",
		"\tif (Phaser.Input.Keyboard.JustDown(cursors.right)) { return { x: 1, y: 0 }; }",
		"\tif (Phaser.Input.Keyboard.JustDown(cursors.down)) { return { x: 0, y: 1 }; }",
		"\tif (Phaser.Input.Keyboard.JustDown(cursors.left)) { return { x: -1, y: 0 }; }",
		"",
		"\treturn undefined;",
		"}"
	].join("\n"),
	"isWall": [
		"function isWall(world, x, y) {",
		"\treturn world.walls.has(x + \",\" + y);",
		"}"
	].join("\n"),
	"entityAt": [
		"function entityAt(world, x, y, component, exclude) {",
		"\tfor (const eid of query(world, [component, Position])) {",
		"\t\tif (eid !== exclude && Position.x[eid] === x && Position.y[eid] === y) {",
		"\t\t\treturn eid;",
		"\t\t}",
		"\t}",
		"",
		"\treturn undefined;",
		"}"
	].join("\n")
};

/** Compilation context: the emitted body lines, plus what the body references (to emit imports + helpers). */
interface Ctx {
	"lines": string[];
	/** Bound cells → their x/y expressions. */
	"cells": Map<string, { "x": string; "y": string }>;
	"helpers": Set<string>;
	"components": Set<string>;
	/** Behaviors this body composes (→ imports). */
	"uses": Set<string>;
	/** The acting-entity variable: `eid` inside a rule loop, `self` inside a behavior. */
	"self": string;
	/** How "stop" lowers: `continue` inside a loop (a rule), `return` inside a behavior. */
	"stop": string;
}

/** The JS expression for an entity name in scope: `me` is the acting entity; any bound entity is its own name. */
function entityExpr(context: Ctx, name: string): string {
	return name === "me" ? context.self : name;
}

/** The x/y expressions for a cell name in scope. */
function cellExpr(context: Ctx, name: string): { "x": string; "y": string } {
	const cell = context.cells.get(name);

	if (cell === undefined) {
		throw new Error("unknown cell in scope: " + name);
	}

	return cell;
}

/** Emit one statement (and any nested body) at the given indent depth. */
function emitStmt(statement: Stmt, depth: number, context: Ctx): void {
	const pad = "\t".repeat(depth);

	if ("let" in statement) {
		const entity = entityExpr(context, statement.cellAheadOf);

		context.components.add("Position");
		context.lines.push(pad + "const " + statement.let + "X = Position.x[" + entity + "] + dir.x;");
		context.lines.push(pad + "const " + statement.let + "Y = Position.y[" + entity + "] + dir.y;");
		context.cells.set(statement.let, { "x": statement.let + "X", "y": statement.let + "Y" });

		return;
	}

	if ("ifWall" in statement) {
		const cell = cellExpr(context, statement.ifWall);

		context.helpers.add("isWall");
		context.lines.push(pad + "if (isWall(world, " + cell.x + ", " + cell.y + ")) { " + context.stop + "; }");

		return;
	}

	if ("ifBlocked" in statement) {
		const cell = cellExpr(context, statement.ifBlocked);

		context.helpers.add("isWall");
		context.helpers.add("entityAt");
		context.components.add(statement.by);
		context.lines.push(pad + "if (isWall(world, " + cell.x + ", " + cell.y + ") || entityAt(world, " + cell.x + ", " + cell.y + ", " + statement.by + ", " + entityExpr(context, statement.ignoring) + ") !== undefined) { " + context.stop + "; }");

		return;
	}

	if ("ifHas" in statement) {
		const cell = cellExpr(context, statement.ifHas);

		context.helpers.add("entityAt");
		context.components.add(statement.a);
		context.lines.push(pad + "const " + statement.bind + " = entityAt(world, " + cell.x + ", " + cell.y + ", " + statement.a + ");");
		context.lines.push(pad + "if (" + statement.bind + " !== undefined) {");

		for (const inner of statement.then) {
			emitStmt(inner, depth + 1, context);
		}

		context.lines.push(pad + "}");

		return;
	}

	if ("use" in statement) {
		context.uses.add(statement.use);
		context.lines.push(pad + statement.use + "(world, " + context.self + ", dir);");

		return;
	}

	// move
	const cell = cellExpr(context, statement.to);
	const entity = entityExpr(context, statement.move);

	context.components.add("Position");
	context.lines.push(pad + "Position.x[" + entity + "] = " + cell.x + ";");
	context.lines.push(pad + "Position.y[" + entity + "] = " + cell.y + ";");
}

/** Assemble a file: imports, the used helpers, then the body. */
function assembleFile(importLines: string[], helpers: Set<string>, bodyLines: string[]): string {
	const helperSources = [...helpers]
		.sort()
		.map((helper) => HELPERS[helper])
		.filter((src): src is string => src !== undefined);

	return [importLines.join("\n"), ...helperSources, bodyLines.join("\n")].join("\n\n") + "\n";
}

/** Import lines for a body, given what it references. `depth` picks the relative prefix (systems/ and behaviors/ are both
 *  one level under the game root, so schemas/behaviors are reached with `../`). */
function importsFor(context: Ctx, phaser: boolean, needsQuery: boolean): string[] {
	const imports: string[] = [];

	if (phaser) {
		imports.push("import Phaser from \"phaser\";");
	}

	if (needsQuery) {
		imports.push("import { query } from \"bitecs\";");
	}

	for (const component of [...context.components].sort()) {
		imports.push("import { " + component + " } from \"../schemas/" + component.toLowerCase() + "\";");
	}

	for (const behavior of [...context.uses].sort()) {
		imports.push("import { " + behavior + " } from \"../behaviors/" + behavior + "\";");
	}

	return imports;
}

/** Compile a reusable behavior to `behaviors/<name>.ts` — a function of (world, self, dir), composed of primitives. */
export function compileBehavior(behavior: Behavior): { "path": string; "code": string } {
	const context: Ctx = { "lines": [], "cells": new Map(), "helpers": new Set(), "components": new Set(["Position"]), "uses": new Set(), "self": "self", "stop": "return" };

	for (const statement of behavior.body) {
		emitStmt(statement, 1, context);
	}

	const body = ["export function " + behavior.name + "(world, self, dir) {", ...context.lines, "}"];
	const needsQuery = context.helpers.has("entityAt") || context.uses.size > 0;

	return { "path": "behaviors/" + behavior.name + ".ts", "code": assembleFile(importsFor(context, context.helpers.has("pressed"), needsQuery), context.helpers, body) };
}

/** Compile a per-entity rule to `systems/<name>.ts`: `for each` subject entity, on its event, run the body. */
function compilePerEntity(rule: PerEntityRule): { "path": string; "code": string } {
	const context: Ctx = { "lines": [], "cells": new Map(), "helpers": new Set(), "components": new Set(["Position", rule.subject]), "uses": new Set(), "self": "eid", "stop": "continue" };
	const phaser = rule.on === "keyDirection";

	const inner: string[] = [];

	if (rule.on === "keyDirection") {
		context.helpers.add("pressed");
		inner.push("\t\tconst dir = pressed(world);");
		inner.push("\t\tif (dir === undefined) { continue; }");
		inner.push("");
	}

	for (const statement of rule.body) {
		emitStmt(statement, 2, context);
	}

	inner.push(...context.lines);

	const body = [
		"export function " + rule.name + "(world) {",
		"\tfor (const eid of query(world, [" + rule.subject + ", Position])) {",
		...inner,
		"\t}",
		"}"
	];

	return { "path": "systems/" + rule.name + ".ts", "code": assembleFile(importsFor(context, phaser, true), context.helpers, body) };
}

/** Compile an aggregate rule to `systems/<name>.ts`: read the goal cells, then win iff every subject stands on one. */
function compileAggregate(rule: AggregateRule): { "path": string; "code": string } {
	const context: Ctx = { "lines": [], "cells": new Map(), "helpers": new Set(), "components": new Set(["Position", rule.allOn, rule.goal]), "uses": new Set(), "self": "eid", "stop": "return" };

	const body = [
		"export function " + rule.name + "(world) {",
		"\tconst goals = new Set();",
		"",
		"\tfor (const goal of query(world, [" + rule.goal + ", Position])) {",
		"\t\tgoals.add(Position.x[goal] + \",\" + Position.y[goal]);",
		"\t}",
		"",
		"\tif (goals.size === 0) { return; }",
		"",
		"\tfor (const eid of query(world, [" + rule.allOn + ", Position])) {",
		"\t\tif (!goals.has(Position.x[eid] + \",\" + Position.y[eid])) { return; }",
		"\t}",
		"",
		"\tworld.onWin?.();",
		"}"
	];

	return { "path": "systems/" + rule.name + ".ts", "code": assembleFile(importsFor(context, false, true), context.helpers, body) };
}

/** Compile one rule to its `{ path, code }` system file. */
export function compileRule(rule: Rule): { "path": string; "code": string } {
	return rule.kind === "perEntity" ? compilePerEntity(rule) : compileAggregate(rule);
}

/** Compile a whole game — its behavior library and its rules — to `{ path → code }` files: the readable ECS the
 *  composition produces (`behaviors/` for the reusable functions, `systems/` for the rules). */
export function compileGame(rules: Rule[], behaviors: Behavior[] = []): Record<string, string> {
	const files: Record<string, string> = {};

	for (const behavior of behaviors) {
		const { path, code } = compileBehavior(behavior);

		files[path] = code;
	}

	for (const rule of rules) {
		const { path, code } = compileRule(rule);

		files[path] = code;
	}

	return files;
}
