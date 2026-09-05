/**
 * Stepped destructuring: patterns whose defaults / computed keys / member targets contain `yield` or
 * `await` run on the explicit stack (a synthetic `pattern` frame) — differentially against Node —
 * and a fork taken mid-pattern is an ordinary frame clone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDifferential, assertDifferentialAsync } from "../differential/harness.ts";
import { createVM } from "../../src/index.ts";
import { patternSettings } from "../../src/handlers.ts";

const sync = [
	// defaults
	`function* g() { const [a = yield "d", b] = [undefined, 2]; return a + b; } const it = g(); const first = it.next().value; [first, it.next(40).value]`,
	`function* g() { const { a = yield 1, b: { c = yield 2 } = {} } = {}; return [a, c]; } const it = g(); it.next(); it.next("A"); it.next("C").value`,
	// computed keys
	`function* g() { const { [yield "k"]: v } = { key: 9 }; return v; } const it = g(); it.next(); it.next("key").value`,
	// member targets, incl. element access with a yielded key — the reference resolves before IteratorStep
	`const o = {}; const log = []; function* g() { [ o[yield "key"] ] = { [Symbol.iterator]() { log.push("iter"); let i = 0; return { next() { log.push("next"); return { value: 7, done: i++ > 0 }; } }; } }; } const it = g(); it.next(); it.next("p"); [o.p, log]`,
	// assignment expression value is the RHS, and nested patterns
	`let a, b, c; function* g() { const r = ([a, [b = yield "x", c]] = [1, [undefined, 3]]); return r; } const it = g(); it.next(); [it.next(2).value, a, b, c]`,
	// for-of head
	`const seen = []; function* g() { for (const [x = yield "h"] of [[], [5]]) seen.push(x); } const it = g(); it.next(); it.next(1); it.next(2); seen`,
	`let x; const seen = []; function* g() { for ([x = yield] of [[undefined], [3]]) seen.push(x); } const it = g(); it.next(); it.next("A"); it.next("B"); seen`,
	// object rest with a yield elsewhere in the pattern; elision; array rest
	`function* g() { const { a = yield, ...rest } = { b: 1, c: 2 }; return [a, rest]; } const it = g(); it.next(); it.next("A").value`,
	`function* g() { const [, second = yield, ...more] = [1, undefined, 3, 4]; return [second, more]; } const it = g(); it.next(); it.next("S").value`,
	// IteratorClose: `.return()` at a yield inside a default closes the open iterator
	`const log = []; const iter = { [Symbol.iterator]() { return { next() { return { value: undefined, done: false }; }, return() { log.push("closed"); return {}; } }; } }; function* g() { const [a = yield "waiting"] = iter; } const it = g(); it.next(); const r = it.return("R"); [log, r.value, r.done]`,
	// a throw injected at the yield closes it too; a throwing iterator is NOT closed
	`const log = []; const iter = { [Symbol.iterator]() { return { next() { return { value: undefined, done: false }; }, return() { log.push("closed"); return {}; } }; } }; function* g() { try { const [a = yield] = iter; } catch (e) { log.push("caught " + e); } } const it = g(); it.next(); it.throw("boom"); log`,
	`const log = []; const iter = { [Symbol.iterator]() { return { next() { throw new Error("next fails"); }, return() { log.push("closed"); return {}; } }; } }; function* g() { try { const [a = yield] = iter; } catch (e) { log.push(e.message); } } g().next(); log`,
	// NamedEvaluation of a default through the stepped path
	`function* g() { const [f = (yield, function () {})] = []; return f.name; } const it = g(); it.next(); it.next().value`,
	// errors from the pattern surface in the generator
	`function* g() { try { const [a = yield] = null; } catch (e) { return e.constructor.name; } } g().next().value`,
];

const asyncCases = [
	`(async () => { const { a = await Promise.resolve(5), b: [c] = [await 7] } = {}; return a + c; })()`,
	`(async () => { const o = {}; [o[await Promise.resolve("k")] = await 3] = []; return o; })()`,
	`(async () => { const out = []; for await (const [x = await Promise.resolve("d")] of [[], [1]]) out.push(x); return out; })()`,
	`(async () => { const it = { [Symbol.iterator]() { return { next() { return { value: undefined, done: false }; }, return() { throw new Error("close failed"); } }; } }; try { const [a = await Promise.reject(new Error("default failed"))] = it; } catch (e) { return e.message; } })()`,
];

for (const code of sync) test(`stepped pattern: ${code.slice(0, 70)}`, () => assertDifferential(code));
for (const code of asyncCases) test(`stepped pattern (async): ${code.slice(0, 70)}`, () => assertDifferentialAsync(code));

test("fork taken while a pattern frame is waiting on a default value is independent", () => {
	const prev = patternSettings.forceStepped;
	patternSettings.forceStepped = true;
	try {
		const vm = createVM(`const [a = 1 + 1, b] = [undefined, 5]; const r = a + b; r`);
		// While the default `1 + 1` evaluates, its node frame sits above the waiting pattern frame.
		const waiting = (): number => vm.frames.findIndex((f) => f.kind === "pattern" && f.awaiting === true);
		vm.runUntil(() => waiting() >= 0);
		const at = waiting();
		assert.ok(at >= 0, "stopped while a pattern frame waits on its default");
		const fork = vm.fork();
		const forkFrame = fork.frames[at];
		const original = vm.frames[at];
		assert.ok(forkFrame?.kind === "pattern" && original?.kind === "pattern");
		assert.notStrictEqual(forkFrame.temps, original.temps);
		vm.run();
		fork.run();
		assert.equal(vm.completion, 7);
		assert.equal(fork.completion, 7);
	} finally {
		patternSettings.forceStepped = prev;
	}
});
