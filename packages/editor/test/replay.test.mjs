// Stepping a recorded handler (RUNNING.md): what a recorded call kept, revived (extensions/worker-pod/snapshot.ts), and
// the call run again by tsval (replay-run.ts) — its own code stepped, each call it couldn't make handed its result.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createVM, runToEnd } from "@brianjenkins94/tsval";
import { replayGuard, replayProgram } from "../extensions/tsval/replay-run.ts";
import { encode, revive } from "../extensions/worker-pod/snapshot.ts";

const named = (name) => Object.defineProperty(() => undefined, "name", { "value": name });

test("a snapshot: data comes back as data, what can't as what stands in for it", () => {
	class Cart {
		constructor() { this.items = ["tea"]; }

		total() { return 1; }
	}

	const cyclic = { "name": "loop" };

	cyclic.self = cyclic;

	const encoded = JSON.parse(JSON.stringify(encode({ "n": 1, "text": "hi", "missing": undefined, "list": [1, [2, 3]], "when": new Date(5), "map": new Map([["a", 1]]), "set": new Set([2]), "setCount": function setCount() {}, "cart": new Cart(), "cyclic": cyclic, "nan": Number.NaN })));
	const back = revive(encoded, named);

	assert.deepEqual({ "n": back.n, "text": back.text, "list": back.list, "when": back.when.getTime(), "map": [...back.map], "set": [...back.set] }, { "n": 1, "text": "hi", "list": [1, [2, 3]], "when": 5, "map": [["a", 1]], "set": [2] });
	assert.ok("missing" in back && back.missing === undefined);
	assert.ok(Number.isNaN(back.nan));
	assert.equal(back.setCount.name, "setCount", "a function, as a stand-in by its name");
	assert.deepEqual(back.cart.items, ["tea"]);
	assert.equal(typeof back.cart.total, "function", "a class's method, a stand-in too");
	assert.deepEqual(Object.keys(back.cart), ["items"], "(not among its own keys)");
	assert.equal(back.cyclic.self, undefined, "a cycle, cut");
});

test("the program a replay runs: every line and column the file's, the function called with its recorded this and arguments", () => {
	const source = "import { thing } from \"./thing\";\nconst x = 1;\nexport const onClick = (event) => {\n\tconst step = 2;\n\treturn step;\n};\nconsole.log(x);\n";
	const fn = [2, 23, 5, 1];
	const program = replayProgram(source, fn);

	assert.equal(program.split("\n").length, source.split("\n").length, "the same lines");
	assert.equal(program.indexOf("(event)"), source.indexOf("(event)"), "nothing before it shifted");
	assert.equal(program.slice(source.indexOf("(event)"), source.indexOf("};") + 1), source.slice(source.indexOf("(event)"), source.indexOf("};") + 1), "the function where it was");
	assert.ok(!program.includes("import") && !program.includes("console"), "the rest blanked");
});

test("a recorded call, replayed: its code stepped on what it read, each call it couldn't make handed what it returned", async () => {
	const source = [
		"let count = 0;",
		"const onClick = (event) => {",
		"\tconst step = event.detail;",
		"\tconst next = count + step;",
		"\tconst saved = save(next);",
		"\tconst doubled = [next].map((each) => each * 2)[0];",
		"\tcount = saved + doubled;",
		"};",
		""
	].join("\n");
	// What the page recorded of the call: count was 2, save a page function (it returned 99), the event's detail 3.
	const replay = {
		"fn": [1, 16, 7, 1],
		"free": { "count": 2, "save": { "$": "f", "name": "save" } },
		"self": { "$": "u" },
		"args": [{ "$": "h", "name": "CustomEvent click", "p": { "detail": 3, "type": "click" }, "m": ["preventDefault"] }],
		"calls": [[4, 15, 99], [5, 17, [10]]]
	};
	const { standIn, hostGuard } = replayGuard(replay);
	const globals = { "__self": {}, "__args": replay.args.map((arg) => revive(arg, standIn)) };
	const { vm } = createVM(replayProgram(source, replay.fn), { "fileName": "/workspace/app.js", "globals": globals, "hostGuard": hostGuard, "eventLoop": { "pace": "fast" } });

	// What it read from outside itself, as the scope around it (as the debug worker binds it).
	for (const [name, value] of Object.entries(replay.free)) {
		vm.rootScope.bindings.set(name, { "value": revive(value, standIn), "kind": "let", "initialized": true });
	}

	vm.addBreakpointsByLine(6);
	vm.runToBreakpoint();
	assert.equal(vm.location()?.line, 5, "stopped where the stop was, in the replayed call");
	assert.deepEqual(["step", "next", "saved"].map((name) => vm.top.scope.get(name)), [3, 5, 99], "on what it read; save handed its result");

	await runToEnd(vm);
	assert.equal(vm.rootScope.get("count"), 99 + 10, "the callback ran for real (map with the program's own function): 5 × 2");
});
