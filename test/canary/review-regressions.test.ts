/**
 * Regression tests for the findings of the post-S6 review. Each test is the probe that exposed the
 * bug, kept so it can't come back.
 */
import { test } from "node:test";
import assert from "node:assert";
import { runCanary, runCanaryAsync } from "../../src/canary.ts";
import { createVM, interpret } from "../../src/interpret.ts";
import { TsvalInternalError } from "../../src/errors.ts";

// --- #1: the sanitized environment must not leak the real `Function` / `eval` ---

test("#1 sandbox: intrinsic .constructor.constructor is the eval shim, not the real Function", () => {
	for (const code of [
		`const F = [].constructor.constructor; F("return globalThis.fetch")()`,
		`"".constructor.constructor("return fetch")()`,
		`Object.getPrototypeOf(() => 0).constructor("return 1")()`,
		`Reflect.get(Array, "constructor")("return 2")()`,
		`(async () => 0).constructor("return 3")()`,
		`(function* () {}).constructor("yield 1")`,
		`Reflect.apply([].constructor.constructor, null, ["return 4"])`,
		`Reflect.construct([].constructor.constructor, ["return 5"])`,
		`[].constructor.constructor.call(null, "return 6")`,
		`[].constructor.constructor.apply(null, ["return 7"])`,
		`[].constructor.constructor.bind(null)("return 8")`,
		`const { constructor: F } = Array; F("return 9")()`,
		`setTimeout("fetch('https://x')", 0)`,
	]) {
		const r = runCanary(code, { predicted: [] });
		assert.ok(r.aborted, `expected an eval divergence for: ${code} (got ${JSON.stringify({ ok: r.ok, err: String(r.error) })})`);
		assert.strictEqual(r.divergence?.capability, "eval", code);
	}
});

test("#1 sandbox: a declared eval capability still records the code and denies execution", () => {
	const r = runCanary(`const F = [].constructor.constructor; typeof F("return fetch")()`, { predicted: ["eval"] });
	assert.ok(r.ok);
	assert.deepStrictEqual(r.observedCaps, ["eval"]);
	assert.strictEqual(r.completion, "undefined", "the shim returns a no-op, never runs the code");
});

// --- #2: reaches after an await / in a timer must be observed, and never escape as uncaught ---

test("#2 async: a reach after an await is caught by runCanaryAsync", async () => {
	const r = await runCanaryAsync(`(async () => { await 0; fetch("https://late.com"); })()`, { predicted: [] });
	assert.ok(r.aborted);
	assert.strictEqual(r.divergence?.value, "https://late.com");
	assert.strictEqual(r.pendingAsync, 0);
});

test("#2 async: a reach in a timer / microtask / .then is caught by runCanaryAsync", async () => {
	for (const code of [`setTimeout(() => fetch("https://timer.com"), 1)`, `queueMicrotask(() => fetch("https://micro.com"))`, `Promise.resolve().then(() => fetch("https://then.com"))`]) {
		const r = await runCanaryAsync(code, { predicted: [] });
		assert.ok(r.aborted, `expected divergence for: ${code}`);
		assert.strictEqual(r.divergence?.capability, "net");
	}
});

test("#2 async: the synchronous runCanary fails loud when async work is left outstanding", () => {
	const r = runCanary(`(async () => { await 0; fetch("https://late.com"); })()`, { predicted: [] });
	assert.strictEqual(r.ok, false);
	assert.ok(r.pendingAsync > 0 || String(r.error).includes("runCanaryAsync"));
});

test("#2 async: a divergence rejecting an awaited promise cannot be swallowed by guest try/catch", async () => {
	const r = await runCanaryAsync(`(async () => { try { await (async () => { await 0; fetch("https://inner.com"); })(); } catch (e) { return "swallowed"; } return "clean"; })()`, { predicted: [] });
	assert.ok(r.aborted);
	assert.notStrictEqual(r.completion, "swallowed");
});

test("#2 async: no late uncaught errors leak out of a completed async canary", async () => {
	const late: unknown[] = [];
	const onUncaught = (e: unknown) => late.push(e);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUncaught);
	try {
		await runCanaryAsync(`setTimeout(() => fetch("https://t"), 1); (async () => { await 0; fetch("https://a"); })();`, { predicted: [] });
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUncaught);
	}
	assert.deepStrictEqual(late, []);
});

// --- #3: fork must rebind cloned closures to the forked VM ---

test("#3 fork: a host-invoked closure from the fork runs on the fork", () => {
	const vm = createVM("function mk(){ let c = 0; return { inc: () => ++c }; } const o = mk(); o;");
	vm.run();
	const fork = vm.fork();
	let originalHits = 0;
	let forkHits = 0;
	const original = vm.callGuestFromHost.bind(vm);
	const forked = fork.callGuestFromHost.bind(fork);
	vm.callGuestFromHost = (...a) => (originalHits++, original(...a));
	fork.callGuestFromHost = (...a) => (forkHits++, forked(...a));
	(fork.rootScope.get("o") as { inc(): number }).inc();
	assert.deepStrictEqual({ originalHits, forkHits }, { originalHits: 0, forkHits: 1 });
});

// --- #4: await/yield inside a synchronous sub-evaluation must fail loud, not yield undefined ---

test("#4 await inside a computed key / default value is an internal error, not a silent undefined", async () => {
	const p = interpret(`(async () => { const o = { [await Promise.resolve("k")]: 1 }; return Object.keys(o)[0]; })()`) as Promise<unknown>;
	await assert.rejects(p, (e: unknown) => e instanceof TsvalInternalError);
});

// --- #7: fork policy — accessors rebind, class prototypes are shared consistently ---

test("#7 fork: object-literal accessors keep independent captured state", () => {
	const vm = createVM("function mk(){ let n = 1; return { get v(){ return n; }, set v(x){ n = x; } }; } const o = mk(); o;");
	vm.run();
	const fork = vm.fork();
	(vm.rootScope.get("o") as { v: number }).v = 99;
	assert.strictEqual((fork.rootScope.get("o") as { v: number }).v, 1);
});

test("#7 fork: a class prototype is shared, so a forked instance's proto is its constructor's prototype", () => {
	const vm = createVM("class A { m(){ return 1; } } const a = new A(); a;");
	vm.run();
	const fork = vm.fork();
	const A = fork.rootScope.get("A") as { prototype: object };
	const a = fork.rootScope.get("a") as object;
	assert.strictEqual(Object.getPrototypeOf(a), A.prototype);
});
