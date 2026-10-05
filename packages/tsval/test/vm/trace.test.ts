import type { TraceEvent } from "../../src/vm.ts";
import type ts from "typescript";
import assert from "node:assert";
import { test } from "node:test";
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
