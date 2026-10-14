// Span annotations (src/annotations.ts): every call answers one of three, never a bare undefined.
import assert from "node:assert/strict";
import { test } from "node:test";

import { annotations } from "../src/annotations.ts";

/** Commands that answer `answers[command]` — a function of the arguments, or a thrown error. */
function commands(answers) {
	return {
		"executeCommand": async (command, ...rest) => {
			if (!(command in answers)) {
				throw new Error(`command '${command}' not found`);
			}

			return answers[command](...rest);
		}
	};
}

test("the answer, as the bridge gives it", async () => {
	const ref = { "span": "a1", "file": "a.ts" };
	const editor = annotations(commands({
		"editor.annotations.spans": () => ({ "value": [{ "id": "a1", "start": 0, "end": 1 }] }),
		"editor.annotations.refer": (_source, _file, ranges) => ({ "value": ranges.map((_, index) => (index === 0 ? ref : undefined)) }),
		"editor.annotations.resolve": () => ({ "value": [{ "status": "attached", "alternatives": [] }] })
	}));

	assert.deepEqual(await editor.spans("a"), { "value": [{ "id": "a1", "start": 0, "end": 1 }] });
	assert.deepEqual(await editor.refer("a", "a.ts", [{ "start": 0, "end": 1 }, { "start": 1, "end": 1 }]), { "value": [ref, undefined] }, "a range no span stands for is undefined in the answer");
	assert.deepEqual(await editor.resolve("a", "a.ts", [ref]), { "value": [{ "status": "attached", "alternatives": [] }] });
});

test("a text BABLR can't parse: why, not a lost annotation", async () => {
	const editor = annotations(commands({
		"editor.annotations.refer": () => ({ "unparsable": "rejected root state" }),
		"editor.annotations.resolve": () => ({ "unparsable": "rejected root state" })
	}));

	assert.deepEqual(await editor.refer("do x++", "a.js", [{ "start": 0, "end": 1 }]), { "unparsable": "rejected root state" });
	assert.deepEqual(await editor.resolve("do x++", "a.js", [{ "span": "a1", "file": "a.js" }]), { "unparsable": "rejected root state" });
});

test("no editor BABLR: unavailable, and why", async () => {
	const none = annotations(commands({}));
	const odd = annotations(commands({ "editor.annotations.spans": () => [1, 2] }));

	assert.match((await none.refer("a", "a.ts", [{ "start": 0, "end": 1 }])).unavailable, /not found/u);
	assert.ok("unavailable" in await odd.spans("a"), "an answer of another shape (an older bridge's bare array) isn't taken as one");
});

test("nothing asked, nothing to ask the editor", async () => {
	const none = annotations(commands({}));

	assert.deepEqual(await none.spans(""), { "value": [] });
	assert.deepEqual(await none.refer("a", "a.ts", []), { "value": [] });
	assert.deepEqual(await none.resolve("a", "a.ts", []), { "value": [] });
});
