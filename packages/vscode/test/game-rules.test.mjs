// The FIRST TEST of the Handmade author model, on paper then in code: the example's push and win are COMPOSED from primitives
// (nothing high-level pre-made), a built-in behavior is itself just a reusable function of those primitives, a rule
// composes the behavior, and the compiled systems reverse-project back to the same rules (the round-trip). Run: tsx --test.
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { referTo } from "@brianjenkins94/util/silo/annotations";
import { anchorGame } from "../extensions/event-sheet/anchors.ts";
import { compileGame, exampleBehaviors, exampleRules, fly } from "../extensions/event-sheet/rules.ts";
import { recognizeGame } from "../extensions/event-sheet/recognizer.ts";

/** A reference to the span standing for each range of a text — what the editor's `editor.annotations.refer` answers,
 *  here straight from BABLR and silo (tokens left out of the shapes: these tests look at the ids). */
const referOf = async (source, file, ranges) => {
	const shapes = spanAnchors(source).filter((span) => span.type !== null).map((span) => ({ ...span, "atoms": [] }));

	return ranges.map((range) => {
		const id = pickAnchor(shapes, range.start, range.end);

		return id === undefined ? undefined : referTo(shapes, id, file);
	});
};

// Minimal schemas + an entity config, so behaviors and objects recognize alongside the compiled rules.
const SCHEMAS = {
	"schemas/position.ts": "export const Position = { \"x\": new Uint8Array(1024), \"y\": new Uint8Array(1024) };\n",
	"schemas/player.ts": "export const Player = [];\n",
	"schemas/pushable.ts": "export const Pushable = [];\n",
	"schemas/target.ts": "export const Target = [];\n"
};
const GAME = {
	"game.ts": [
		"import { Player } from \"./schemas/player\";",
		"import { Pushable } from \"./schemas/pushable\";",
		"import { Target } from \"./schemas/target\";",
		"",
		"export const config = {",
		"\t\"player\": { \"components\": [Player], \"depth\": 2 },",
		"\t\"boulder\": { \"components\": [Pushable], \"depth\": 1 },",
		"\t\"target\": { \"components\": [Target], \"depth\": 0 }",
		"};",
		""
	].join("\n")
};

test("push and win compile from primitives to readable systems, and a built-in is a reusable function of primitives", () => {
	const files = compileGame(exampleRules, exampleBehaviors);

	// The built-in `gridPush` is a reusable FUNCTION composed only of primitives — no magic, and no input coupling.
	const push = files["behaviors/gridPush.ts"];

	assert.ok(typeof push === "string", "the behavior compiles to its own reusable file");
	assert.match(push, /export function gridPush\(world, self, dir\)/u, "it is an exported reusable function");
	assert.match(push, /isWall\(world/u, "walls-stop-you, from the ifWall primitive");
	assert.match(push, /entityAt\(world, targetX, targetY, Pushable\)/u, "\"the cell ahead has a Rock\"");
	assert.match(push, /Position\.x\[rock\] = pastX/u, "push THAT rock (the emergent push)");
	assert.match(push, /Position\.x\[self\] = targetX/u, "then move the acting entity");
	assert.doesNotMatch(push, /Phaser|pressed\(/u, "the behavior is pure — input lives in the rule, not the built-in");

	// The rule COMPOSES the behavior — it imports and calls it, and does NOT re-inline the push.
	const move = files["systems/playerMove.ts"];

	assert.match(move, /import \{ gridPush \} from "\.\.\/behaviors\/gridPush"/u, "the rule pulls in the built-in");
	assert.match(move, /gridPush\(world, eid, dir\);/u, "the rule composes it");
	assert.doesNotMatch(move, /Position\.x\[rock\]/u, "the push is not re-inlined — it lives in the reusable behavior");

	// Win is the aggregate, also from primitives.
	const win = files["systems/winSystem.ts"];

	assert.match(win, /query\(world, \[Target, Position\]\)/u);
	assert.match(win, /world\.onWin/u);
});

test("the compiled game reverse-projects back to the example's map (the round-trip)", () => {
	const files = { ...SCHEMAS, ...GAME, ...compileGame(exampleRules, exampleBehaviors) };
	const model = recognizeGame(files, ts);

	// Behaviors (components) recovered — the game genuinely needs only these four.
	assert.deepEqual(model.behaviors.map((behavior) => behavior.name), ["Player", "Position", "Pushable", "Target"]);

	// Objects recovered from the entity config.
	assert.deepEqual(model.objects.map((object) => object.name).sort(), ["boulder", "player", "target"]);

	// Rules recovered with the right subjects; the reusable behavior is not itself a rule (it never queries directly).
	const rules = new Map(model.rules.map((rule) => [rule.name, rule]));

	assert.deepEqual([...rules.keys()].sort(), ["playerMove", "winSystem"]);

	const move = rules.get("playerMove");

	assert.deepEqual(move?.queries, [["Player", "Position"]], "the Player is the subject");
	assert.equal(move?.rows.length, 0, "the rule is a clean composition — the push decomposes inside the behavior, not here");
	assert.deepEqual(move?.composes, ["gridPush"], "the rule reports the behavior it composes");

	const win = rules.get("winSystem");

	assert.deepEqual([...(win?.queries ?? [])].sort(), [["Pushable", "Position"], ["Target", "Position"]].sort());
	assert.equal(win?.rows.length, 0, "win is an aggregate, not event->action rows");

	// The library round-trips: the reusable behavior is recognized as its own first-class node.
	assert.deepEqual(model.composites.map((composite) => composite.name), ["gridPush"], "the built-in behavior is recognized");

	const push = model.composites.find((composite) => composite.name === "gridPush");

	assert.deepEqual(push?.uses, ["Position", "Pushable"], "it reports the components it touches");
	assert.deepEqual(push?.composes, [], "it composes no other behavior");
	assert.equal(push?.defPath, "behaviors/gridPush.ts", "it deep-links to its own file");
});

test("arcade: continuous movement compiles to deterministic fixed-point code, no nondeterminism", () => {
	// A real-time rule: for each Ship, every tick, fly (move by the held keys).
	const shipRule = { "kind": "perEntity", "name": "shipFly", "subject": "Ship", "on": "step", "body": [{ "use": "fly" }] };
	const files = compileGame([shipRule], [fly]);
	const behavior = files["behaviors/fly.ts"];
	const system = files["systems/shipFly.ts"];

	// Continuous integer movement from held input.
	assert.match(behavior, /Position\.x\[self\] \+= input\.x \* 3/u, "moves by held keys in integer pixels");
	assert.match(behavior, /held\(world\)/u);
	assert.match(behavior, /\.isDown/u, "reads HELD keys (continuous), not one-shot");

	// Deterministic by construction: none of the usual nondeterminism sources can appear (the vocabulary can't emit them).
	for (const source of [/Math\./u, /\bDate\b/u, /performance/u, /\bdelta\b/u, /random/u, /Date\.now/u]) {
		assert.doesNotMatch(behavior, source, "behavior is free of " + source);
		assert.doesNotMatch(system, source, "system is free of " + source);
	}

	// A step rule has no `dir` in scope, so the composed call doesn't pass one.
	assert.match(system, /fly\(world, eid\);/u, "step rule composes fly with just (world, self)");
	assert.doesNotMatch(system, /fly\(world, eid, dir\)/u);
});

test("composed behaviors get durable anchors (the library keeps its identity across edits)", async () => {
	const files = { ...SCHEMAS, ...GAME, ...compileGame(exampleRules, exampleBehaviors) };
	const model = await anchorGame(files, recognizeGame(files, ts), referOf);

	const push = model.composites.find((composite) => composite.name === "gridPush");

	assert.ok(typeof push?.ref?.span === "string" && push.ref?.span.length > 0, "the composite carries a durable anchor id");

	// Its id is its own — not shared with the rules that compose it.
	const ruleAnchors = model.rules.map((rule) => rule.ref?.span).filter((anchor) => anchor !== undefined);

	assert.ok(!ruleAnchors.includes(push.ref?.span), "the composite's anchor is distinct from the rules'");

	// A cosmetic edit ABOVE the behavior (a new comment line) must not change its anchor — that is the point of anchoring.
	const shifted = { ...files, "behaviors/gridPush.ts": "// a new comment above\n" + files["behaviors/gridPush.ts"] };
	const reanchored = await anchorGame(shifted, recognizeGame(shifted, ts), referOf);
	const pushAgain = reanchored.composites.find((composite) => composite.name === "gridPush");

	assert.equal(pushAgain?.ref?.span, push.ref?.span, "the anchor survives an edit above it (move-stable)");
});
