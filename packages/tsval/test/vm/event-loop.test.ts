import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";
import type { VM } from "../../src/vm.ts";

/** A program's log, through an injected `log`. */
function logged(): { "lines": unknown[]; "globals": Record<string, unknown> } {
	const lines: unknown[] = [];

	return { "lines": lines, "globals": { "log": (...values: unknown[]) => { lines.push(values.length === 1 ? values[0] : values); } } };
}

/** Drive `vm` to its next breakpoint (or the end), letting pending work settle and timers come due while it's idle. */
async function toBreakpoint(vm: VM): Promise<void> {
	vm.runToBreakpoint();

	while (vm.idle) {
		await vm.whenSettled();
		vm.runToBreakpoint();
	}
}

async function toEnd(vm: VM): Promise<void> {
	while (!vm.finished) {
		await toBreakpoint(vm);
	}
}

test("event loop: the same order as Node's — sync, microtasks, setImmediate, then timers by due time", async () => {
	const { lines, globals } = logged();
	const src = [
		"setTimeout(() => log('timeout 20'), 20);",
		"setTimeout(() => log('timeout 10'), 10);",
		"setImmediate(() => log('immediate'));",
		"Promise.resolve().then(() => log('then'));",
		"queueMicrotask(() => log('microtask'));",
		"setTimeout(() => { log('timeout 10, second'); Promise.resolve().then(() => log('then, in a timer')); }, 10);",
		"log('sync');"
	].join("\n");
	const { vm } = createVM(src, { "globals": globals, "eventLoop": { "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, ["sync", "then", "microtask", "immediate", "timeout 10", "timeout 10, second", "then, in a timer", "timeout 20"]);
});

test("event loop: Date reads the virtual clock — it moves only as timers fire, to their due time", async () => {
	const { lines, globals } = logged();
	const src = ["log(Date.now());", "setTimeout(() => { log(Date.now()); log(new Date().getTime()); }, 50);", "log(new Date(0).getTime());"].join("\n");
	const { vm } = createVM(src, { "globals": globals, "eventLoop": { "now": 1_000, "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, [1_000, 0, 1_050, 1_050]);
	assert.ok(new Date() instanceof Date && typeof Date.now() === "number");
});

test("event loop: Math.random is seeded — the same seed, the same numbers", async () => {
	const draw = async (seed: number): Promise<unknown[]> => {
		const { lines, globals } = logged();
		const { vm } = createVM("log([Math.random(), Math.random(), Math.random()]); log(Math.max(1, 2));", { "globals": globals, "eventLoop": { "seed": seed, "pace": "fast" } });

		await toEnd(vm);

		return lines;
	};

	const [first, second, other] = [await draw(42), await draw(42), await draw(7)];

	assert.deepStrictEqual(first, second);
	assert.notDeepStrictEqual(first, other);
	assert.ok((first[0] as number[]).every((value) => value >= 0 && value < 1));
	assert.strictEqual(first[1], 2, "the rest of Math is the host's");
});

test("event loop: an interval ticks until cleared, and an unref'd timer doesn't keep the program alive", async () => {
	const { lines, globals } = logged();
	const src = [
		"let ticks = 0;",
		"const interval = setInterval(() => { ticks += 1; log('tick ' + ticks + ' at ' + Date.now()); if (ticks === 3) clearInterval(interval); }, 100);",
		"setTimeout(() => log('never'), 10_000).unref();"
	].join("\n");
	const { vm } = createVM(src, { "globals": globals, "eventLoop": { "now": 0, "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, ["tick 1 at 100", "tick 2 at 200", "tick 3 at 300"]);
});

test("event loop: a breakpoint in a timer's callback stops there, and a fork from it runs the same way", async () => {
	const { lines, globals } = logged();
	const src = [
		"let total = 0;",
		"for (const delay of [30, 10, 20]) {",
		"  setTimeout(() => {",
		"    total += delay;",
		"    log(delay + ' at ' + Date.now() + ' · ' + Math.random().toFixed(6));",
		"  }, delay);",
		"}"
	].join("\n");
	const { vm } = createVM(src, { "globals": globals, "eventLoop": { "now": 0, "seed": 1, "pace": "fast" } });

	vm.addBreakpointsByLine(4);
	await toBreakpoint(vm);
	assert.strictEqual(vm.location()?.line, 3);
	let scope = vm.top?.scope;

	while (scope !== undefined && !scope.bindings.has("delay")) {
		scope = scope.parent;
	}

	assert.strictEqual(scope?.bindings.get("delay")?.value, 10, "the first due: 10");

	const fork = vm.fork();

	fork.breakpoints.clear();
	vm.breakpoints.clear();
	await toEnd(fork);

	const forked = lines.splice(0);

	await toEnd(vm);
	assert.deepStrictEqual(lines, forked, "the fork's run is the original's");
	assert.deepStrictEqual(forked.map((line) => String(line).split(" ·")[0]), ["10 at 10", "20 at 20", "30 at 30"]);
});

test("event loop: an error in a timer's callback is the program's", async () => {
	const { vm } = createVM("setTimeout(() => { throw new Error('boom'); }, 5);", { "eventLoop": { "pace": "fast" } });

	await assert.rejects(toEnd(vm), /boom/u);
});

test("event loop: paced to real time, a timer waits its delay; fast, it doesn't — the order the same", async () => {
	const time = async (pace: "real" | "fast"): Promise<number> => {
		const { globals } = logged();
		const { vm } = createVM("setTimeout(() => log('late'), 60);", { "globals": globals, "eventLoop": { "pace": pace } });
		const started = performance.now();

		await toEnd(vm);

		return performance.now() - started;
	};

	assert.ok(await time("real") >= 50);
	assert.ok(await time("fast") < 40);
});

test("event loop: `crypto`'s random numbers are its seeded generator's, and `performance.now` its clock: the same run every time", async () => {
	const run = async (seed: number): Promise<unknown[]> => {
		const { lines, globals } = logged();
		const { vm } = createVM(`
const bytes = crypto.getRandomValues(new Uint8Array(4));
log(crypto.randomUUID());
log([...bytes]);
log(performance.now());
setTimeout(() => { log(performance.now()); }, 250);
`, { "globals": globals, "eventLoop": { "now": 1_000_000, "seed": seed, "pace": "fast" } });

		await toEnd(vm);

		return lines;
	};
	const first = await run(7);

	assert.deepEqual(await run(7), first);
	assert.notDeepEqual(await run(8), first);
	assert.match(String(first[0]), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
	assert.equal(first[2], 0, "from where the loop started");
	assert.equal(first[3], 250, "it moves as a timer fires");
});

test("event loop: a timer native code sets — a function the host compiled, `new Function`'s — is the machine's, as the guest's are", async () => {
	const { lines, globals } = logged();
	const src = [
		"native(setTimeout, clearTimeout, log);",
		"setTimeout(() => log('guest 20'), 20);"
	].join("\n");
	// (host code: its timers set, one from its own callback, and one cleared — what new Function's code does)
	const native = (set: typeof setTimeout, clear: typeof clearTimeout, log: (value: unknown) => void): void => {
		set(() => {
			log("native 10");
			set(() => { log("native, from its callback"); }, 15);
		}, 10);
		clear(set(() => { log("never"); }, 5));
	};
	const { vm } = createVM(src, { "globals": { ...globals, "native": native }, "eventLoop": { "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, ["native 10", "guest 20", "native, from its callback"]);
});

test("a then forwarded by call, apply or Reflect.apply keeps its place among the microtasks, as V8's does", async () => {
	const { lines, globals } = logged();
	const src = "const p = Promise.resolve(); Reflect.apply(p.then, p, [() => log(1)]); p.then(() => log(2)); queueMicrotask(() => log(3)); p.then.call(p, () => log(4)); p.then.apply(p, [() => log(5)]); log('sync');";
	const { vm } = createVM(src, { "globals": globals, "eventLoop": { "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, ["sync", 1, 2, 3, 4, 5]);
});

test("a thenable a built-in hands back is the value itself, not an external result: only a promise is (a package's query builder isn't run by being returned)", async () => {
	const { lines, globals } = logged();
	const calls: string[] = [];
	const src = [
		"const t = { then(r) { r(1); } };",
		"log([[t].pop() === t, Object.defineProperty(t, 'x', { value: 1 }) === t, Reflect.apply((v) => v, null, [t]) === t]);",
		"const query = builder();",
		"log(typeof query.then);",
		"query.then((rows) => log(rows));"
	].join("\n");
	const builder = (): object => ({ "then": (resolve: (rows: string[]) => void) => { calls.push("then"); resolve(["row"]); } });
	const { vm } = createVM(src, { "globals": { ...globals, "builder": builder }, "eventLoop": { "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual([lines, calls], [[[true, true, true], "function", ["row"]], ["then"]]);
});

test("only a promise a host API makes is external: what the language's own functions hand back is the program's — a promise it constructed, one passed through `pop`, an object made from Promise.prototype", async () => {
	const { lines, globals } = logged();
	const src = [
		"class Sub extends Promise {}",
		"const made = Reflect.construct(Promise, [(r) => r(1)], Sub);",
		"log([made instanceof Sub, [made].pop() === made, Reflect.apply((v) => v, null, [made]) === made]);",
		"const fake = Object.create(Promise.prototype);",
		"log([fake].pop() === fake);",
		"const fetched = later();",
		"log(fetched === hostPromise);"
	].join("\n");
	const hostPromise = Promise.resolve("from the host");
	const { vm } = createVM(src, { "globals": { ...globals, "later": () => hostPromise, "hostPromise": hostPromise }, "eventLoop": { "pace": "fast" } });

	await toEnd(vm);
	assert.deepStrictEqual(lines, [[true, true, true], true, false]);
});
