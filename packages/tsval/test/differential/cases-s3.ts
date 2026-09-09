/**
 * S3 differential corpus: generators (synchronously observable) and async functions (awaited).
 */

/** Generator programs whose observable value is produced synchronously. */
export const GENERATOR_CASES: string[] = [
	`function* g() { yield 1; yield 2; yield 3; } [...g()]`,
	`function* g() { yield 1; yield 2; } const it = g(); it.next().value + it.next().value`,
	`function* g() { const x = yield 1; yield x + 10; } const it = g(); it.next(); it.next(5).value`,
	`function* g() { yield* [1, 2]; yield* [3, 4]; } [...g()]`,
	`function* squares(n) { for (let i = 0; i < n; i++) yield i * i; } [...squares(5)]`,
	`function* g() { yield 1; return 99; yield 2; } const it = g(); it.next(); const r = it.next(); [r.value, r.done]`,
	`function* g() { try { yield 1; } finally { } yield 2; } Array.from(g())`,
	`function* inner() { yield "a"; return "R"; } function* outer() { const r = yield* inner(); yield r; } [...outer()]`,
	`function* fib() { let [a, b] = [0, 1]; while (true) { yield a; [a, b] = [b, a + b]; } } const it = fib(); const out = []; for (let i = 0; i < 8; i++) out.push(it.next().value); out`,
	`function* g() { yield 1; yield 2; yield 3; } let s = 0; for (const x of g()) s += x; s`,
	`function* g() { yield 1; yield 2; } const [a, b] = g(); a * 10 + b`,
	`function* range(a, b) { for (let i = a; i < b; i++) yield i; } Math.max(...range(3, 7))`,
];

/** Async programs whose completion value is a Promise (compared after awaiting). */
export const ASYNC_CASES: string[] = [
	`(async () => 42)()`,
	`(async () => { const x = await Promise.resolve(10); return x + 1; })()`,
	`(async () => { const a = await Promise.resolve(2); const b = await Promise.resolve(3); return a * b; })()`,
	`(async () => { try { await Promise.reject(new Error("boom")); } catch (e) { return "caught:" + e.message; } })()`,
	`(async () => { let s = 0; for (const x of [1, 2, 3]) s += await Promise.resolve(x); return s; })()`,
	`(async () => { const vals = await Promise.all([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]); return vals; })()`,
	`(async () => { const f = async (n) => n * 2; return (await f(5)) + (await f(10)); })()`,
	`(async () => { await Promise.resolve(); return "after-await"; })()`,
	`(async () => { const results = []; for (const n of [1, 2, 3]) results.push(await Promise.resolve(n * n)); return results; })()`,
	`(async () => { throw new Error("rejected"); })()`,
	`(async () => { let sum = 0; let i = 0; while (i < 4) { sum += await Promise.resolve(i); i++; } return sum; })()`,

	// --- async generators + for await ---
	`(async () => { async function* g() { yield 1; yield 2; } const out = []; for await (const v of g()) out.push(v); return out; })()`,
	`(async () => { async function* g() { const a = await Promise.resolve(10); yield a; yield await Promise.resolve(20); } const out = []; for await (const v of g()) out.push(v); return out; })()`,
	`(async () => { const out = []; for await (const v of [Promise.resolve(1), 2, Promise.resolve(3)]) out.push(v); return out; })()`,
	`(async () => { async function* inner() { yield "a"; yield "b"; return "R"; } async function* outer() { const r = yield* inner(); yield r; } const out = []; for await (const v of outer()) out.push(v); return out; })()`,
	`(async () => { async function* g() { yield* [1, 2]; yield 3; } const out = []; for await (const v of g()) out.push(v); return out; })()`,
	`(async () => { async function* g() { yield 1; yield 2; yield 3; } const it = g(); const a = await it.next(); const b = await it.next(); await it.return(9); const c = await it.next(); return [a.value, b.value, c.done]; })()`,
	`(async () => { async function* g() { let i = 0; while (true) yield i++; } const out = []; for await (const v of g()) { out.push(v); if (v >= 3) break; } return out; })()`,
	`(async () => { async function* g() { try { yield 1; throw new Error("in-gen"); } catch (e) { yield "caught:" + e.message; } } const out = []; for await (const v of g()) out.push(v); return out; })()`,
	`(async () => { async function* g() { const x = yield 1; yield x * 2; } const it = g(); await it.next(); const r = await it.next(21); return r.value; })()`,
	`(async () => { let s = 0; for await (const v of [1, 2, 3, 4]) { if (v % 2) continue; s += v; } return s; })()`,
];
