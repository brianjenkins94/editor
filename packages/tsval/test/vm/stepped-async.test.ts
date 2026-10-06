import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";
import type { VM } from "../../src/vm.ts";

/** A program's log, through an injected `log`. */
function logged(): { "lines": unknown[]; "globals": Record<string, unknown> } {
	const lines: unknown[] = [];

	return { "lines": lines, "globals": { "log": (...values: unknown[]) => { lines.push(values.length === 1 ? values[0] : values); } } };
}

/** Drive `vm` to its next breakpoint (or the end), letting pending async work settle while it's idle. */
async function toBreakpoint(vm: VM): Promise<void> {
	vm.runToBreakpoint();

	while (vm.idle) {
		await vm.whenSettled();
		vm.runToBreakpoint();
	}
}

/** Drive `vm` to the end, through every breakpoint and settlement. */
async function toEnd(vm: VM): Promise<void> {
	while (!vm.finished) {
		await toBreakpoint(vm);
	}
}

test("stepped async: the same output, in the same order, as the host's own promise queue", async () => {
	const { lines, globals } = logged();
	const src = [
		"async function inner(x) { log('inner ' + x); const y = await Promise.resolve(x * 2); log('inner got ' + y); return y + 1; }",
		"async function outer() { log('outer'); const z = await inner(1); log('outer got ' + z); return z; }",
		"outer().then((value) => log('then ' + value));",
		"log('sync end');"
	].join("\n");
	const { vm } = createVM(src, { "globals": globals, "steppedAsync": true });

	await toEnd(vm);
	assert.deepStrictEqual(lines, ["outer", "inner 1", "sync end", "inner got 2", "outer got 3", "then 3"]);
});

test("stepped async: a breakpoint after an await is a stop on the main stack, with the function's scope", async () => {
	const { globals } = logged();
	const src = ["async function main() {", "  const a = await Promise.resolve(41);", "  const b = a + 1;", "  log(b);", "}", "main();"].join("\n");
	const { vm } = createVM(src, { "globals": globals, "steppedAsync": true });

	vm.addBreakpointsByLine(4);
	await toBreakpoint(vm);
	assert.strictEqual(vm.finished, false);
	assert.strictEqual(vm.location()?.line, 3);
	assert.strictEqual(vm.top?.scope.bindings.get("b")?.value, 42);
	await toEnd(vm);
});

test("stepped async: a promise's callback is a job too — a breakpoint in it stops", async () => {
	const { lines, globals } = logged();
	const src = ["Promise.resolve(2).then((value) => {", "  const doubled = value * 2;", "  log(doubled);", "  return doubled;", "}).then((value) => log('after ' + value));"].join("\n");
	const { vm } = createVM(src, { "globals": globals, "steppedAsync": true });

	vm.addBreakpointsByLine(3);
	await toBreakpoint(vm);
	assert.strictEqual(vm.location()?.line, 2);
	assert.strictEqual(vm.top?.scope.bindings.get("doubled")?.value, 4);
	await toEnd(vm);
	assert.deepStrictEqual(lines, [4, "after 4"]);
});

test("stepped async: a throw rejects the async function's promise, and is caught where it's awaited", async () => {
	const { lines, globals } = logged();
	const src = [
		"async function fails() { await null; throw new Error('nope'); }",
		"async function main() { try { await fails(); } catch (error) { log('caught ' + error.message); } }",
		"main();",
		"fails().catch((error) => log('rejected ' + error.message));"
	].join("\n");
	const { vm } = createVM(src, { "globals": globals, "steppedAsync": true });

	await toEnd(vm);
	assert.deepStrictEqual(lines.slice().sort((a, b) => String(a).localeCompare(String(b))), ["caught nope", "rejected nope"]);
});

test("stepped async: a top-level await suspends the program, and it goes on when the value settles", async () => {
	const { lines, globals } = logged();
	const { vm } = createVM("const value = await Promise.resolve(7);\nlog(value);", { "globals": globals, "steppedAsync": true });

	await toEnd(vm);
	assert.deepStrictEqual(lines, [7]);
});

test("stepped async: a fork at a stop resumes its own pending work, apart from the original", async () => {
	const { lines, globals } = logged();
	const src = ["let count = 0;", "async function tick() { await null; count += 1; log(count); }", "tick();", "log('stop here');"].join("\n");
	const { vm } = createVM(src, { "globals": globals, "steppedAsync": true });

	vm.addBreakpointsByLine(4);
	await toBreakpoint(vm); // stopped at `log('stop here')`, tick() suspended

	const fork = vm.fork();

	await toEnd(fork);
	assert.deepStrictEqual(lines, ["stop here", 1]);
	await toEnd(vm);
	assert.deepStrictEqual(lines, ["stop here", 1, "stop here", 1], "the original's own count, not the fork's");
});

test("without steppedAsync: async code runs on the host's promise queue, as before", async () => {
	const { lines, globals } = logged();
	const { vm } = createVM("async function main() { await null; log('later'); }\nmain();\nlog('now');", { "globals": globals });

	vm.run();
	assert.deepStrictEqual(lines, ["now"]);
	await new Promise((resolve) => { setTimeout(resolve, 0); });
	assert.deepStrictEqual(lines, ["now", "later"]);
});
