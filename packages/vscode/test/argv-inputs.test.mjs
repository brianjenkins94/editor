// A mocked process.argv (extensions/worker-pod/inputs.ts, the notes margin's Mock): read as a command line's, a run per `|`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInputs } from "../extensions/worker-pod/inputs.ts";

test("inputs: runs by |, arguments by spaces, quotes keeping a space", () => {
	assert.deepEqual(parseInputs("US | CA | FR --coupon \"SPRING 10\""), [["US"], ["CA"], ["FR", "--coupon", "SPRING 10"]]);
	assert.deepEqual(parseInputs(""), [[]], "nothing: one run, with no inputs");
	assert.deepEqual(parseInputs("a | | 'b c'"), [["a"], [], ["b c"]]);
	assert.deepEqual(parseInputs("\"\""), [[""]], "an empty argument, quoted");
});
