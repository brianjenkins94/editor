// Event-sheet source-map spec — the load-bearing artifact of the event sheet (see the event-sheet vision): the
// BIDIRECTIONAL map between event rows and the generated lines they own, and its DURABLE form keyed on content-addressed
// anchors. Proven here before any real vocabulary/UI, because everything (stepping, click-to-jump, orphan detection)
// hangs off it. Run: node --test (needs bablr/dist built).
//
// Invariants: every generated line is either chrome or maps to exactly one row; a row owns a CONTIGUOUS line range;
// rowAt and spanOf are inverse; the durable anchor of a row is shift-resistant (an unrelated row added above doesn't
// change it) yet self-edit-aware (changing a row's own action changes its anchor → orphan).
import assert from "node:assert/strict";
import test from "node:test";
// Node 24 strips the types; rowAnchors' only runtime import is bablr/dist (gitignored, local/CI-built).
import { generate, sampleSheet } from "../event-sheet.ts";
import { rowAnchors } from "../event-sheet-anchors.ts";

test("every generated line is chrome or maps to exactly one row", () => {
	const program = generate(sampleSheet);
	const lineCount = program.code.replace(/\n$/u, "").split("\n").length;

	for (let line = 1; line <= lineCount; line += 1) {
		const rowId = program.rowAt(line);

		// undefined (chrome) or a real row id — never a dangling id.
		if (rowId !== undefined) {
			assert.ok(sampleSheet.rows.some((row) => row.id === rowId), "line " + line + " maps to a known row");
		}
	}

	// The function signature (line 1) and the final closing brace are chrome.
	assert.equal(program.rowAt(1), undefined, "the update() signature belongs to no row");
	assert.equal(program.rowAt(lineCount), undefined, "the closing brace belongs to no row");
});

test("each row owns a single contiguous line range, and rowAt/spanOf are inverse", () => {
	const program = generate(sampleSheet);

	for (const row of sampleSheet.rows) {
		const span = program.spanOf(row.id);

		assert.ok(span !== undefined, row.id + " produced code");
		assert.ok(span.startLine <= span.endLine, row.id + " span is well-formed");

		// spanOf → rowAt: every line in the span maps back to this row.
		for (let line = span.startLine; line <= span.endLine; line += 1) {
			assert.equal(program.rowAt(line), row.id, "line " + line + " belongs to " + row.id);
		}

		// The lines just outside the span do NOT belong to this row (contiguity — one block, not scattered).
		assert.notEqual(program.rowAt(span.startLine - 1), row.id, row.id + " does not own the line above its span");
		assert.notEqual(program.rowAt(span.endLine + 1), row.id, row.id + " does not own the line below its span");
	}

	// Rows appear in the generated file in sheet order, not overlapping.
	const starts = sampleSheet.rows.map((row) => program.spanOf(row.id).startLine);

	assert.deepEqual([...starts].sort((a, b) => a - b), starts, "row spans are in sheet order");
});

test("click-to-jump: an unknown row has no span, a real row lands on its condition comment", () => {
	const program = generate(sampleSheet);

	assert.equal(program.spanOf("row-does-not-exist"), undefined);

	// The first line a row owns is its label comment — the natural jump target.
	const shoot = program.spanOf("row-shoot");
	const firstLine = program.code.split("\n")[shoot.startLine - 1];

	assert.match(firstLine, /when "Space" is pressed/u, "jumping to row-shoot lands on its labelled block");
});

test("durable anchor: shift-resistant to an unrelated row, self-edit-aware for its own", () => {
	const before = rowAnchors(generate(sampleSheet));
	const shootAnchor = before.get("row-shoot");

	assert.ok(typeof shootAnchor === "string", "row-shoot has a durable anchor");

	// (a) Add a NEW row ABOVE row-shoot. Its emitted lines shift down, but its content is unchanged → same anchor.
	const withRowAbove = {
		"rows": [
			sampleSheet.rows[0],
			{ "id": "row-new", "condition": { "kind": "everyTick" }, "actions": [{ "kind": "log", "arg": "tick" }] },
			...sampleSheet.rows.slice(1)
		]
	};
	const shifted = rowAnchors(generate(withRowAbove));

	assert.equal(shifted.get("row-shoot"), shootAnchor, "an unrelated row added above does not change row-shoot's anchor");

	// (b) EDIT row-shoot's own action. Its emitted statement changes → new content → new anchor (orphans the old key).
	const edited = {
		"rows": sampleSheet.rows.map((row) => (row.id === "row-shoot"
			? { ...row, "actions": [{ "kind": "spawn", "arg": "missile" }] }
			: row))
	};
	const afterEdit = rowAnchors(generate(edited));

	assert.notEqual(afterEdit.get("row-shoot"), shootAnchor, "changing row-shoot's own action changes its anchor (→ orphan / diverged)");
});
