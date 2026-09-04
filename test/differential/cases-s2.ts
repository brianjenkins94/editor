/**
 * S2 differential corpus: control flow, destructuring, spread, and the assorted coverage added in S2.
 * Same `assertDifferential` oracle — Node is the source of truth for every expected value.
 */
export const S2_CASES: string[] = [
	// --- loops ---
	`let s = 0; for (let i = 0; i < 5; i++) s += i; s`,
	`let s = 0; for (let i = 10; i > 0; i -= 2) s += i; s`,
	`let s = 0, i = 0; while (i < 6) { s += i; i++; } s`,
	`let s = 0, i = 0; do { s += i; i++; } while (i < 4); s`,
	`let s = 0; for (const x of [3, 4, 5]) s += x; s`,
	`let out = ""; for (const c of "abc") out += c + c; out`,
	`let keys = ""; for (const k in { a: 1, b: 2, c: 3 }) keys += k; keys`,
	`let s = 0; for (let i = 0; i < 100; i++) { if (i === 10) break; s += 1; } s`,
	`let s = 0; for (let i = 0; i < 10; i++) { if (i % 2 === 0) continue; s += i; } s`,
	`const acc = []; for (let i = 0; i < 3; i++) acc.push(() => i); acc.map((f) => f()).join(",")`,
	`let s = 0; outer: for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (j === 1) continue outer; s += 10; } s`,
	`let s = 0; done: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (i * j > 4) break done; s++; } } s`,
	`const sum = (arr) => { let t = 0; for (const x of arr) t += x; return t; }; sum([1, 2, 3, 4, 5])`,

	// --- switch ---
	`let r; switch (2) { case 1: r = "a"; break; case 2: r = "b"; break; default: r = "c"; } r`,
	`let r = ""; switch (1) { case 1: r += "x"; case 2: r += "y"; break; case 3: r += "z"; } r`,
	`let r; switch (99) { case 1: r = "a"; break; default: r = "d"; } r`,
	`function grade(n) { switch (true) { case n >= 90: return "A"; case n >= 80: return "B"; default: return "F"; } } grade(85)`,

	// --- try / catch / finally ---
	`let r; try { throw new Error("boom"); } catch (e) { r = e.message; } r`,
	`let r = ""; try { r += "t"; throw 1; } catch { r += "c"; } finally { r += "f"; } r`,
	`function f() { try { return "a"; } finally { /* no override */ } } f()`,
	`let log = ""; function f() { try { return "r"; } finally { log += "fin"; } } const v = f(); log + v`,
	`let s = 0; try { try { throw 5; } finally { s += 1; } } catch (e) { s += e; } s`,
	`let r; try { JSON.parse("{bad}"); } catch (e) { r = e instanceof SyntaxError; } r`,
	`let out = ""; for (let i = 0; i < 3; i++) { try { if (i === 1) continue; out += i; } finally { out += "!"; } } out`,

	// --- destructuring ---
	`const [a, b, c] = [1, 2, 3]; a * 100 + b * 10 + c`,
	`const [a, , c] = [1, 2, 3]; a + c`,
	`const [first, ...rest] = [1, 2, 3, 4]; first + rest.length`,
	`const { x, y } = { x: 5, y: 7 }; x - y`,
	`const { a: p, b: q } = { a: 1, b: 2 }; p * 10 + q`,
	`const { a, ...rest } = { a: 1, b: 2, c: 3 }; a + Object.keys(rest).length`,
	`const { a = 10, b = 20 } = { a: 1 }; a + b`,
	`const [x = 9, y = 8] = [1]; x + y`,
	`const { a: { b } } = { a: { b: 42 } }; b`,
	`const [[a, b], [c, d]] = [[1, 2], [3, 4]]; a + b + c + d`,
	`const nums = [[1, 2], [3, 4]]; let s = 0; for (const [x, y] of nums) s += x * y; s`,

	// --- default & rest parameters ---
	`function f(a, b = 10) { return a + b; } f(5)`,
	`function f(a, b = a * 2) { return a + b; } f(4)`,
	`function f(...xs) { return xs.reduce((s, x) => s + x, 0); } f(1, 2, 3, 4)`,
	`function f({ x, y = 5 }) { return x + y; } f({ x: 3 })`,
	`function f([a, b], c) { return a + b + c; } f([1, 2], 3)`,
	`const g = (a, b = 1, ...rest) => a + b + rest.length; g(10)`,

	// --- spread ---
	`const a = [1, 2]; const b = [...a, 3, 4]; b.join("-")`,
	`const a = [3, 4, 5]; Math.max(...a)`,
	`const o = { a: 1, b: 2 }; const p = { ...o, c: 3 }; p.a + p.b + p.c`,
	`const o = { a: 1 }; const p = { ...o, a: 9 }; p.a`,
	`function f(a, b, c) { return a + b + c; } f(...[1, 2, 3])`,

	// --- optional chaining / element-access callee ---
	`const o = { a: { b: () => 7 } }; o.a.b()`,
	`const o = null; o?.x ?? "safe"`,
	`const fns = [() => "zero", () => "one"]; fns[1]()`,
	`const o = { m: () => 3 }; o["m"]()`,
];
