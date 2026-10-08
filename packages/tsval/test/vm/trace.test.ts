import type { TraceEvent, VM } from "../../src/vm.ts";
import type ts from "typescript";
import assert from "node:assert";
import { test } from "node:test";
import { runToEnd } from "../../src/explore.ts";
import { createVM } from "../../src/interpret.ts";

/** Run `code`, each traced value as `line: name = value` (strings quoted), its call and its loops' turns after it:
 *  `@call` and `[turn,turn]` when not the top level or not in a loop. */
function traced(code: string): string[] {
	const seen: string[] = [];
	const { vm, sourceFile } = createVM(code, {
		"trace": (event: TraceEvent) => {
			const line = sourceFile.getLineAndCharacterOfPosition(event.node.getStart(sourceFile)).line + 1;
			const value = typeof event.value === "string" ? `'${event.value}'` : Array.isArray(event.value) ? `[${event.value.join(",")}]` : String(event.value);
			const where = `${event.call === 0 ? "" : ` @${event.call}`}${event.loops.length === 0 ? "" : ` [${event.loops.map((loop) => loop.turn).join(",")}]`}`;

			seen.push(`${line}: ${event.name} = ${value}${where}`);
		}
	});

	vm.run();

	return seen;
}

test("trace is told nothing unless asked: a program runs the same without it", () => {
	const { vm } = createVM("let a = 1; for (let i = 0; i < 3; i++) { a += i; } a;");

	assert.strictEqual(vm.run(), 4);
});

test("Bret Victor's binary search: each line's values, by turn of the loop, in one call", () => {
	assert.deepStrictEqual(traced([
		"function binarySearch(key, array) {",
		"	let low = 0;",
		"	let high = array.length - 1;",
		"	while (true) {",
		"		const mid = Math.floor((low + high) / 2);",
		"		const value = array[mid];",
		"		if (value < key) {",
		"			low = mid + 1;",
		"		} else if (value > key) {",
		"			high = mid - 1;",
		"		} else {",
		"			return mid;",
		"		}",
		"	}",
		"}",
		"binarySearch('d', ['a', 'b', 'c', 'd', 'e', 'f']);"
	].join("\n")), [
		"1: key = 'd' @1",
		"1: array = [a,b,c,d,e,f] @1",
		"2: low = 0 @1",
		"3: high = 5 @1",
		"5: mid = 2 @1 [0]",
		"6: value = 'c' @1 [0]",
		"7: if = 0 @1 [0]",
		"8: low = 3 @1 [0]",
		"5: mid = 4 @1 [1]",
		"6: value = 'e' @1 [1]",
		"7: if = 1 @1 [1]",
		"9: if = 0 @1 [1]",
		"10: high = 3 @1 [1]",
		"5: mid = 3 @1 [2]",
		"6: value = 'd' @1 [2]",
		"7: if = 1 @1 [2]",
		"9: if = 1 @1 [2]",
		"12: return = 3 @1 [2]"
	]);
});

test("loops: a for's own variable each turn, nested loops' turns outermost first, a for…of's element", () => {
	assert.deepStrictEqual(traced([
		"let sum = 0;",
		"for (let i = 0; i < 2; i++) {",
		"	for (const x of [10, 20]) {",
		"		sum += x * i;",
		"	}",
		"}"
	].join("\n")), [
		"1: sum = 0",
		"2: i = 0",
		"3: x = 10 [0,0]",
		"4: sum = 0 [0,0]",
		"3: x = 20 [0,1]",
		"4: sum = 0 [0,1]",
		"2: i = 1 [0]",
		"3: x = 10 [1,0]",
		"4: sum = 10 [1,0]",
		"3: x = 20 [1,1]",
		"4: sum = 30 [1,1]",
		"2: i = 2 [1]"
	]);
});

test("a call's function: the callee, told with each value of the call", () => {
	const callees: string[] = [];
	const { vm, sourceFile } = createVM("function twice(n) {\n\treturn n * 2;\n}\nconst a = twice(1);", {
		"trace": (event) => { callees.push(`${event.name}: ${event.callee === undefined ? "top level" : (event.callee as ts.FunctionDeclaration).name?.getText(sourceFile)}`); }
	});

	vm.run();
	assert.deepStrictEqual(callees, ["n: twice", "return: twice", "a: top level"]);
});

test("calls: each numbered in the order made, its loops its own", () => {
	assert.deepStrictEqual(traced([
		"function twice(n) {",
		"	return n * 2;",
		"}",
		"const a = twice(1);",
		"const b = twice(a);"
	].join("\n")), [
		"1: n = 1 @1",
		"2: return = 2 @1",
		"4: a = 2",
		"1: n = 2 @2",
		"2: return = 4 @2",
		"5: b = 4"
	]);
});

test("patterns and assignments: each name a destructuring binds, a member target as written", () => {
	assert.deepStrictEqual(traced([
		"const [first, { second }] = [1, { second: 2 }];",
		"let a, b;",
		"[a, b] = [first, second];",
		"const o = { p: 0 };",
		"o.p += 5;",
		"a++;"
	].join("\n")), [
		"1: first = 1",
		"1: second = 2",
		"3: a = 1",
		"3: b = 2",
		"4: o = [object Object]",
		"5: o.p = 5",
		"6: a = 2"
	]);
});

/** What a trace event's call and loops should be, read off the whole frame stack as it is when the event is told: the
 *  first call (or construction) frame from the top, and the loops in a turn above it — the walk each event once made. */
function walked(machine: VM): { "call": number; "callee"?: ts.Node; "loops": { "node": ts.Node; "turn": number }[] } {
	const loops: { "node": ts.Node; "turn": number }[] = [];

	for (let index = machine.frames.length - 1; index >= 0; index -= 1) {
		const frame = machine.frames[index]!;

		if (frame.kind === "call" || frame.kind === "construct") {
			return frame.node === null ? { "call": frame.call ?? 0, "loops": loops } : { "call": frame.call ?? 0, "callee": frame.node, "loops": loops };
		}

		if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
			loops.unshift({ "node": frame.node, "turn": frame.turn });
		}
	}

	return { "call": 0, "loops": loops };
}

/** A tracer checking each event's call and loops against `walked` (of the machine running), keeping each in `seen()` as
 *  `name @call [turns]`. */
function checking(machine: () => VM, seen: () => string[]): (event: TraceEvent) => void {
	return (event) => {
		const expected = walked(machine());

		assert.deepStrictEqual({ "call": event.call, "callee": event.callee, "loops": event.loops.map((loop) => ({ "node": loop.node, "turn": loop.turn })) }, { "callee": undefined, ...expected });
		seen().push(`${event.name} @${event.call} [${event.loops.map((loop) => loop.turn).join(",")}]`);
	};
}

const PROGRAMS: Record<string, string> = {
	"nested loops, labels, recursion, closures called later, a host-called callback": [
		"function fib(n) { if (n < 2) { return n; } let s = 0; for (let k = 0; k < 2; k++) { s += fib(n - 1 - k); } return s; }",
		"const later = [];",
		"outer: for (let i = 0; i < 3; i++) {",
		"	let j = 0;",
		"	while (j < 3) {",
		"		j++;",
		"		if (j === 2) { continue outer; }",
		"		later.push(() => { for (const x of [i, j]) { const y = x * 2; } return i + j; });",
		"	}",
		"}",
		"for (const f of later) { const r = f(); }",
		"const total = fib(5);",
		"let d = 0;",
		"do { d = d + 1; } while (d < 3);",
		"for (const key in { a: 1, b: 2 }) { const k2 = key; }",
		"for (let m = 0; m < 2; m++) { const mapped = [1, 2, 3].map((v) => { let acc = 0; for (let q = 0; q < v; q++) { acc += q; } return acc; }); }"
	].join("\n"),
	"exceptions unwinding through loops, break, finally": [
		"function thrower(n) { for (let a = 0; a < 5; a++) { if (a === n) { throw new Error('at ' + a); } } }",
		"for (let i = 0; i < 3; i++) {",
		"	try { for (let j = 0; j < 3; j++) { const v = j; if (j === i) { thrower(j); } } } catch (e) { const m = e.message; } finally { const f = i; }",
		"	for (const z of [1, 2]) { if (z === 2) { break; } const zz = z; }",
		"	const after = i;",
		"}"
	].join("\n"),
	"generators resumed from other loops, constructors": [
		"function* gen(n) { for (let i = 0; i < n; i++) { const sent = yield i; let w = sent; } }",
		"const g = gen(3);",
		"for (let k = 0; k < 4; k++) { const r = g.next(k); }",
		"for (const v of gen(2)) { for (let m = 0; m < 2; m++) { const both = v + m; } }",
		"class A { constructor(n) { for (let i = 0; i < n; i++) { this.v = i; } } }",
		"for (let c = 0; c < 2; c++) { const a = new A(c + 1); }"
	].join("\n")
};

for (const [name, code] of Object.entries(PROGRAMS)) {
	test(`trace context: each event's call and loops are the frame stack's — ${name}`, () => {
		const seen: string[] = [];
		let machine!: VM;

		({ "vm": machine } = createVM(code, { "trace": checking(() => machine, () => seen) }));
		machine.run();
		assert.ok(seen.some((line) => / \[\d+,\d+\]$/u.test(line)) && seen.some((line) => !line.includes(" @0 ")), "nested loops and calls were traced");
	});
}

test("trace context: stepped async — awaits in loops, timers' callbacks — each event the frame stack's", async () => {
	const seen: string[] = [];
	let machine!: VM;

	({ "vm": machine } = createVM([
		"async function tick(n) { for (let i = 0; i < n; i++) { const got = await i; } return n; }",
		"async function main() { for (let r = 0; r < 2; r++) { const t = await tick(r + 1); } }",
		"main();",
		"for (let x = 0; x < 2; x++) { setTimeout(() => { for (let y = 0; y < 2; y++) { const s = x + y; } }, 0); }"
	].join("\n"), { "trace": checking(() => machine, () => seen), "eventLoop": { "pace": "fast" } }));
	await runToEnd(machine);
	assert.ok(seen.includes("got @3 [0]") && seen.includes("s @4 [1]"), seen.join("\n"));
});

test("trace context: a fork mid-loop traces as the original does from there", () => {
	const code = PROGRAMS["nested loops, labels, recursion, closures called later, a host-called callback"]!;
	const whole: string[] = [];
	let original!: VM;

	({ "vm": original } = createVM(code, { "trace": checking(() => original, () => whole) }));
	original.run();

	for (const at of [40, 400, 1500]) {
		// (a fork shares its tracer: what's running, and where its events go, are switched as each runs)
		const before: string[] = [];
		const after: string[] = [];
		const forkedAfter: string[] = [];
		let running!: VM;
		let seen = before;

		({ "vm": running } = createVM(code, { "trace": checking(() => running, () => seen) }));

		const machine = running;

		for (let step = 0; step < at; step += 1) {
			machine.step();
		}

		const fork = machine.fork();

		seen = after;
		machine.run();
		running = fork;
		seen = forkedAfter;
		fork.run();
		assert.deepStrictEqual(forkedAfter, after);
		assert.deepStrictEqual([...before, ...after], whole);
	}
});
