// The cosmetic extension's wiring (extensions/cosmetic), against the vscode stand-in (vscode/fake.ts): activated, it reads
// the changes through the editor's git and BABLR's verdicts, after the boot and again after a change, and a file whose
// change is formatting or comments only is marked, a meaningful one isn't — the check the architecture tour made end to
// end, now the feature's own.
import "./vscode/hooks.mjs";

import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

// (the extension is loaded as CommonJS, so the stand-in is too: one instance, the one it registered with)
const require = createRequire(import.meta.url);
const { fake } = require("vscode");
const { activate } = require("../extensions/cosmetic/extension.ts");

/** The editor's core, as the extension asks it: the changed files, a file's texts, and BABLR's verdict on them. */
function answer(files) {
	fake.commands.set("editor.git.status", () => ({ "files": Object.keys(files).map((path) => ({ "path": path, "status": "M" })) }));
	fake.commands.set("editor.git.file", (path) => ({ "head": "before " + path, "working": "after " + path }));
	fake.commands.set("editor.annotations.classify", (_head, working) => ({ "value": { "verdict": files[working.slice("after ".length)] } }));
}

/** Let `ms` pass, a step at a time — a timer set by one that ran is due within the same `ms` too (one `tick` doesn't run
 *  those) — and what the timers started settle. */
async function elapse(ms) {
	for (let passed = 0; passed < ms; passed += 100) {
		mock.timers.tick(100);

		for (let turn = 0; turn < 5; turn += 1) {
			await new Promise((resolve) => { setImmediate(resolve); });
		}
	}
}

test("a formatting-only change is marked, a meaningful one isn't, after the boot and after a change", async () => {
	fake.reset();
	mock.timers.enable({ "apis": ["setTimeout"] });

	const subscriptions = [];

	try {
		answer({ "src/a.ts": "cosmetic", "src/b.ts": "semantic", "README.md": "cosmetic" });
		activate({ "subscriptions": subscriptions });

		// Nothing read during the boot…
		await elapse(29_000);
		assert.equal(fake.decorationOf("src/a.ts"), undefined);

		// …then a read: the cosmetic code file marked; the meaningful one, and a file BABLR doesn't read, not.
		await elapse(3000);
		assert.equal(fake.decorationOf("src/a.ts")?.badge, "≈");
		assert.equal(fake.decorationOf("src/b.ts"), undefined);
		assert.equal(fake.decorationOf("README.md"), undefined);
		assert.deepEqual(await fake.commands.get("cosmetic.list")(), { "src/a.ts": "cosmetic", "src/b.ts": "semantic" });

		// A change on disk is read again, once it settles: a.ts's change is meaningful now, and its mark goes.
		answer({ "src/a.ts": "semantic", "src/b.ts": "semantic" });
		fake.change("src/a.ts");
		await elapse(1000);
		assert.equal(fake.decorationOf("src/a.ts")?.badge, "≈");
		await elapse(1500);
		assert.equal(fake.decorationOf("src/a.ts"), undefined);
	} finally {
		for (const subscription of subscriptions) {
			subscription.dispose();
		}

		mock.timers.reset();
	}
});
