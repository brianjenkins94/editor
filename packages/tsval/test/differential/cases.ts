/**
 * Starter differential corpus (ASSIGNMENT S0). Self-contained programs (no injected globals beyond
 * `console`) so Node and tsval see the same environment. Larger corpora (ts-evaluator tests,
 * TypeScript tests/cases, test262) plug into the same `assertDifferential` oracle later (S2+).
 */
export const STARTER_CASES: string[] = [
	// literals + arithmetic
	`1 + 2 * 3`,
	`(1 + 2) * 3`,
	`10 % 3`,
	`2 ** 10`,
	`-5 + 3`,
	`~0`,
	`!false`,
	`5 & 3`,
	`5 | 2`,
	`1 << 4`,
	`"a" + "b" + "c"`,
	`1 < 2`,
	`3 >= 3`,
	`1 === 1`,
	`(1 as number) + 2`,

	// variables + scoping
	`const a = 5; const b = a + 1; b * 2`,
	`let x = 1; x = x + 41; x`,
	`let y = 10; y += 5; y *= 2; y`,
	`var v = 7; v`,
	`let c = 0; c++; c++; c`,
	`let d = 5; --d`,
	`{ let inner = 99; } let outer = 1; outer`,

	// conditionals
	`1 < 2 ? "yes" : "no"`,
	`let r; if (3 > 2) { r = "a"; } else { r = "b"; } r`,
	`true && "kept"`,
	`false || "fallback"`,
	`null ?? "default"`,
	`undefined ?? 0`,

	// functions
	`function add(a, b) { return a + b; } add(20, 22)`,
	`const sq = (n) => n * n; sq(9)`,
	`const g = function () { return 42; }; g()`,
	`function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } fib(12)`,
	`function outer() { function inner() { return 5; } return inner() * 2; } outer()`,
	`const make = (x) => () => x; make(7)()`,
	`function rest(...xs) { return xs.length; } rest(1, 2, 3, 4)`,

	// objects + arrays + members
	`const o = { a: 1, b: 2 }; o.a + o.b`,
	`const arr = [10, 20, 30]; arr[0] + arr[2]`,
	`const o = { x: 1 }; o.x = 5; o.x`,
	`const a = [1, 2, 3]; a[1] = 9; a[1]`,
	`[1, 2, 3].length`,
	`"hello".toUpperCase()`,
	`Math.max(1, 5, 3)`,
	`[1, 2, 3, 4].filter((x) => x % 2 === 0).length`,
	`const shorthand = 5; const obj = { shorthand }; obj.shorthand`,

	// templates
	"`x = ${1 + 1}`",
	"const name = 'world'; `hello ${name}!`",

	// console (observable side effect)
	`console.log("a", 1, true); 0`,
	`console.log(1); console.log(2); "done"`,

	// throwing
	`throw new Error("boom")`,
	`null.x`,
	`undefinedIdentifier`,

	// `this` — module/strict semantics (a deliberate decision; the oracle runs strict to match)
	`typeof this`,
	`function o() { function i() { return this; } return i(); } typeof o()`,
	`const obj = { v: 3, m() { return this.v; } }; obj.m()`,
	`const obj = { v: 3, m() { return this.v; } }; const f = obj.m; (() => { try { return typeof f(); } catch (e) { return e.constructor.name; } })()`,
	`const arrow = () => this; typeof arrow()`,

	// strict-mode semantics (the supported surface): no implicit globals, block-scoped function
	// declarations, read-only `undefined`/`NaN`/`Infinity`
	`(() => { try { undeclaredName = 1; return "created"; } catch (e) { return e.constructor.name; } })()`,
	`(() => { { function inBlock() { return 1; } } try { return typeof inBlock; } catch (e) { return e.constructor.name; } })()`,
	`(() => { { function inBlock() { return 2; } return inBlock(); } })()`,
	`(() => { try { undefined = 1; return "assigned"; } catch (e) { return e.constructor.name; } })()`,
	`(() => { try { NaN = 1; return "assigned"; } catch (e) { return e.constructor.name; } })()`,
	`function f() { "use strict"; return typeof this; } f()`,

	// `var` hoisting out of nested blocks (a plain read before the declaration)
	`function f() { const r = y; if (true) { var y = 1; } return r; } f()`,
	`function f() { const r = typeof z; for (let i = 0; i < 1; i++) { var z = 2; } return r + z; } f()`,
	`function f() { try { var t = 1; } catch (e) {} return t; } f()`,
	`function f() { switch (1) { case 1: var s = "s"; } return s; } f()`,
	`function f() { { var [a, { b }] = [1, { b: 2 }]; } return a + b; } f()`,

	// typeof / void
	`typeof 42`,
	`typeof "s"`,
	`typeof undefinedThing`,
	`void 0`,
];
