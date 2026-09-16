// Assertions for lib/cosmetic.ts (cosmetic vs semantic change classification).   node test/cosmetic.mjs
import * as assert from "node:assert/strict";
import { classifyChange } from "../lib/cosmetic";

const cases = [
	// COSMETIC — only whitespace / comments differ
	["identical", "const x = 1", "const x = 1", "cosmetic"],
	["reindent / extra spaces", "const x = 1", "const   x   =   1", "cosmetic"],
	["line breaks", "const x = 1 + 2", "const x =\n\t1 +\n\t2", "cosmetic"],
	["added line comment", "const x = 1", "const x = 1 // note", "cosmetic"],
	["changed comment text", "// a\nconst x = 1", "// b\nconst x = 1", "cosmetic"],
	["added block comment", "const x = 1", "/* doc */\nconst x = 1", "cosmetic"],

	// SEMANTIC — structure or a token changed
	["changed literal value", "const x = 1", "const x = 2", "semantic"],
	["renamed identifier", "const x = 1", "const y = 1", "semantic"],
	["added statement", "const x = 1", "const x = 1\nconst y = 2", "semantic"],
	["changed operator", "const x = 1 + 2", "const x = 1 - 2", "semantic"],
	["reordered operands", "const x = a + b", "const x = b + a", "semantic"]
];

let passed = 0;

for (const [name, before, after, expected] of cases) {
	const actual = classifyChange(before, after);

	assert.equal(actual, expected, `${name}: expected ${expected}, got ${actual}`);
	passed += 1;
}

console.log(`cosmetic classifier: ${passed}/${cases.length} assertions passed`);
