import assert from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { createVM } from "../../src/interpret.ts";

// A call's steps, as counted before calls got cheaper (no `arguments` object nothing names, a parameter frame with only
// the stacks its program uses): a debugger's time travel, a profile and recorded evidence all index by step, so making a
// call cheaper must not change how many it takes.
const SHAPES: [string, string, unknown, number][] = [
	["identifiers", "function f(a, b) { return a + b; }\nf(1, 2) + f(3);", Number.NaN, 23],
	["no parameters", "function f() { return 1; }\nf() + f();", 2, 21],
	["defaults", "function f(a, b = a * 2, c = () => b) { return a + b + c(); }\nf(1) + f(1, 5);", 16, 45],
	["rest", "function f(a, ...rest) { return a + rest.length; }\nf(1, 2, 3) + f(1);", 4, 31],
	["destructured", "function f({ x, y = 2 }, [p, , q = 4] = [1]) { return x + y + p + q; }\nf({ x: 1 }) + f({ x: 1, y: 3 }, [5, 6, 7]);", 24, 34],
	["spread arguments", "function f(a, b, c) { return a + b + c; }\nconst xs = [2, 3];\nf(1, ...xs) + f(...xs, 4);", 15, 29],
	["arguments", "function f(a) { return arguments.length + arguments[0] + a; }\nf(1, 2, 3);", 5, 21],
	["arguments in an arrow", "function f() { const g = () => arguments[0]; return g(); }\nf(7);", 7, 24],
	["methods", "const o = { k: 3, m(v) { return v + this.k; } };\nclass C { constructor(x) { this.x = x; } s(y) { return y + this.x; } }\no.m(1) + new C(2).s(3);", 9, 55],
	["callbacks", "[1, 2, 3].map((v, i) => v * i).reduce((a, b) => a + b);", 8, 18],
	["generator", "function* g(a, b = 1) { yield a; yield b; }\nlet t = 0;\nfor (const v of g(5)) { t += v; }\nt;", 6, 41],
	["recursion", "function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\nfib(6);", 8, 291]
];

for (const [name, code, result, steps] of SHAPES) {
	test(`a call takes the steps it did: ${name}`, () => {
		const { vm } = createVM(code);

		assert.deepStrictEqual(vm.run(), result);
		assert.strictEqual(vm.steps, steps);
	});
}

test("a call takes the steps it did: async, stepped or not", async () => {
	for (const [steppedAsync, steps] of [[false, 28], [true, 29]] as const) {
		const { vm } = createVM("async function f(a, b = 2) { const v = await a; return v + b; }\nawait f(Promise.resolve(1));", { "steppedAsync": steppedAsync });

		assert.strictEqual(await vm.runAsync(), 3);
		assert.strictEqual(vm.steps, steps);
	}
});

test("a parameter is observed and traced as it was, at the step and the statement it was", () => {
	const told: string[] = [];
	const { vm } = createVM("function f(a, ...rest) { return a + rest.length; }\nf(1, 2, 3) + f(1);", {
		"observe": (node, site, value) => {
			if (site === "parameter") {
				told.push(`observe ${((node as ts.ParameterDeclaration).name as ts.Identifier).text}=${JSON.stringify(value)} @${vm.steps}`);
			}
		},
		"trace": (event) => {
			if (ts.isParameter(event.node)) {
				told.push(`${event.kind} ${event.name}=${JSON.stringify(event.value)} @${event.step}`);
			}
		}
	});

	vm.run();
	assert.deepStrictEqual(told, [
		// (an observation by `vm.steps`; a trace event by the statement clock — statement 1, then the first call's `return`)
		"observe a=1 @6",
		"bind a=1 @1",
		"observe rest=[2,3] @6",
		"bind rest=[2,3] @1",
		"observe a=1 @18",
		"bind a=1 @2",
		"observe rest=[] @18",
		"bind rest=[] @2"
	]);
});

test("an `arguments` object is made only for a function that names it — and is the same where it does", () => {
	const shadowed = createVM("function f(a, arguments) { return arguments; }\nf(1, 2);");

	assert.strictEqual(shadowed.vm.run(), 2);

	const declared = createVM("function f() { var arguments; return arguments.length; }\nf(1, 2);");

	assert.strictEqual(declared.vm.run(), 2);

	// Named only in a nested function: the outer one makes one too (a scan of the function, not of each scope).
	const nested = createVM("function outer() { function inner() { return arguments.length; } return inner(1, 2, 3); }\nouter(1);");

	assert.strictEqual(nested.vm.run(), 3);
});
