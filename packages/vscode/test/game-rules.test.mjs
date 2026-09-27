// The FIRST TEST of the Handmade author model, on paper then in code: dozer's push and win are COMPOSED from primitives
// (nothing high-level pre-made), a built-in behavior is itself just a reusable function of those primitives, a rule
// composes the behavior, and the compiled systems reverse-project back to the same rules (the round-trip). Run: tsx --test.
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { anchorGame } from "../game-anchors.ts";
import { compileGame, dozerBehaviors, dozerRules } from "../game-rules.ts";
import { recognizeGame } from "../game-recognizer.ts";

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
	const files = compileGame(dozerRules, dozerBehaviors);

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

test("the compiled game reverse-projects back to dozer's map (the round-trip)", () => {
	const files = { ...SCHEMAS, ...GAME, ...compileGame(dozerRules, dozerBehaviors) };
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

test("composed behaviors get durable anchors (the library keeps its identity across edits)", () => {
	const files = { ...SCHEMAS, ...GAME, ...compileGame(dozerRules, dozerBehaviors) };
	const model = anchorGame(files, recognizeGame(files, ts));

	const push = model.composites.find((composite) => composite.name === "gridPush");

	assert.ok(typeof push?.anchor === "string" && push.anchor.length > 0, "the composite carries a durable anchor id");

	// Its id is its own — not shared with the rules that compose it.
	const ruleAnchors = model.rules.map((rule) => rule.anchor).filter((anchor) => anchor !== undefined);

	assert.ok(!ruleAnchors.includes(push.anchor), "the composite's anchor is distinct from the rules'");

	// A cosmetic edit ABOVE the behavior (a new comment line) must not change its anchor — that is the point of anchoring.
	const shifted = { ...files, "behaviors/gridPush.ts": "// a new comment above\n" + files["behaviors/gridPush.ts"] };
	const reanchored = anchorGame(shifted, recognizeGame(shifted, ts));
	const pushAgain = reanchored.composites.find((composite) => composite.name === "gridPush");

	assert.equal(pushAgain?.anchor, push.anchor, "the anchor survives an edit above it (move-stable)");
});
