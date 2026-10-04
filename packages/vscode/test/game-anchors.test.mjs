// Durable-anchoring spec — proves the BABLR half: each recognized node gets a content-addressed anchor that is
// move-stable (an unrelated edit above it doesn't change it) yet self-edit-aware (changing its own content does). That
// durability is why we anchor at all. Run: node --test (needs bablr/dist built).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as url from "node:url";
import ts from "typescript";
import { pickAnchor, spanAnchors } from "@brianjenkins94/bablr";
import { anchorGame } from "../extensions/event-sheet/anchors.ts";
import { recognizeGame } from "../extensions/event-sheet/recognizer.ts";

const fixtureDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "example");

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

/** BABLR's anchors for ranges of a text — what the editor's `editor.bablr.anchors` answers, here straight from BABLR. */
const anchorsOf = async (source, ranges) => {
	const anchors = spanAnchors(source);

	return ranges.map((range) => pickAnchor(anchors, range.start, range.end));
};

/** Project + anchor, and return the anchor id for a named behavior. */
async function behaviorAnchor(files, name) {
	const model = await anchorGame(files, recognizeGame(files, ts), anchorsOf);

	return model.behaviors.find((behavior) => behavior.name === name)?.anchor;
}

test("every recognized node gets an anchor, and the five behaviors' anchors are distinct", async () => {
	const files = readGame(fixtureDir);
	const model = await anchorGame(files, recognizeGame(files, ts), anchorsOf);

	for (const node of [...model.behaviors, ...model.objects, ...model.rules, ...model.rules.flatMap((rule) => rule.rows)]) {
		assert.equal(typeof node.anchor, "string", (node.name ?? node.event) + " has an anchor");
	}

	// The three tags are all `export const X: number[] = []` — identical initializers. Distinct anchors proves we anchor
	// on the declaration (name included), not the shared empty array.
	const anchors = model.behaviors.map((behavior) => behavior.anchor);

	assert.equal(new Set(anchors).size, anchors.length, "behavior anchors are unique");
});

test("move-stable: an unrelated edit above a node does not change its anchor", async () => {
	const files = readGame(fixtureDir);
	const before = await behaviorAnchor(files, "Position");

	// Shift Position down by prepending unrelated lines to its file.
	const shifted = { ...files, "schemas/position.ts": "// a new comment\n\n" + files["schemas/position.ts"] };

	assert.equal(await behaviorAnchor(shifted, "Position"), before, "Position's anchor is unchanged by a shift above it");
});

test("self-edit-aware: changing a node's own content changes its anchor", async () => {
	const files = readGame(fixtureDir);
	const before = await behaviorAnchor(files, "Position");

	// Rename Position's field x → z (its own content changes).
	const edited = { ...files, "schemas/position.ts": files["schemas/position.ts"].replace(/"x"/u, "\"z\"") };

	assert.notEqual(await behaviorAnchor(edited, "Position"), before, "editing Position's own field changes its anchor");
});
