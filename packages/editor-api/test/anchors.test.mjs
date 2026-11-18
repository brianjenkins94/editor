// Anchors (src/anchors.ts): ranges of a text that ran, found again in the file as it is — here, as it is when it doesn't
// parse (typing paused mid-statement), where they follow the lines around the edit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Anchors } from "../src/anchors.ts";

/** A VS Code API whose BABLR refers to every range and can't parse any text it's asked to find them in. */
const unparsable = {
	"workspace": { "asRelativePath": (uri) => uri.path.slice(1) },
	"Uri": { "file": (path) => ({ "path": path }) },
	"commands": {
		"executeCommand": async (command, _source, file, asked) => (command === "editor.annotations.refer" ? { "value": asked.map((_, index) => ({ "span": `s${String(index)}`, "file": file })) } : { "unparsable": "rejected root state" })
	}
};

/** The range of `line` (0-based) in `text`. */
function rangeOf(text, line) {
	const lines = text.split("\n");
	const start = lines.slice(0, line).reduce((sum, each) => sum + each.length + 1, 0);

	return [start, start + lines[line].length];
}

test("a line edited around, still there, is where it is now: a line moved up by a fix on save, before typing stopped mid-statement", async () => {
	// (what ran: a fix on save put a blank line after the imports)
	const ran = "import { readFileSync } from \"node:fs\";\n\nconst total = 3 * 10;\nconst back = readFileSync(\"out.txt\");\n";
	const now = "const total = 3 * 10;\nconst more = (\n";
	const anchors = new Anchors(unparsable, "/live.mjs", ran);

	// (back's line, changed, follows line for line after it)
	assert.deepEqual(await anchors.lines(now, [rangeOf(ran, 2), rangeOf(ran, 3)]), [0, 1], "total's line is where it is now");
});

test("lines that changed follow line for line, between the lines around them", async () => {
	const ran = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
	const now = "const a = 1;\nconst b = (\nconst c = 3;\nconst d = 4;\n";
	const anchors = new Anchors(unparsable, "/lines.mjs", ran);

	assert.deepEqual(await anchors.lines(now, [0, 1, 2, 3].map((line) => rangeOf(ran, line))), [0, 1, 2, 3]);

	const shorter = "const a = 1;\nconst x = (\n";

	assert.deepEqual(await new Anchors(unparsable, "/lines.mjs", ran).lines(shorter, [0, 1, 2, 3].map((line) => rangeOf(ran, line))), [0, 1, undefined, undefined], "past the end of what's there now, gone");
});
