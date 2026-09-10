import * as assert from "node:assert/strict";

// stub.ts is dev-linked to the tsval interpreter (the ../packages/tsval workspace). If that build is not
// resolvable yet, there is nothing to test — skip, like silo-anchor does for its engine deps.
let stub: typeof import("../src/stub");

try {
	stub = await import("../src/stub");
} catch {
	console.log("silo-stub: skipped (tsval is not resolvable yet)");
	process.exit(0);
}

const { autostub, respondFirst } = stub;

function withTimeout(promise: Promise<unknown>, ms = 300) {
	return Promise.race([promise, new Promise((resolve) => {
		setTimeout(() => { resolve("TIMEOUT"); }, ms);
	})]);
}

// ── autostub: undefined-safe downstream, and safe where a stub must NOT stand in ──
const s = autostub() as any;

assert.equal(typeof s.a.b[0].c(), "function");
assert.equal(typeof new s.Thing(), "function");
// Not a thenable: `await stub` yields the stub instead of hanging forever.
assert.equal(typeof s.then, "undefined");
assert.equal(typeof await withTimeout((async () => await s)()), "function");
// Coercion does not throw: logs and URLs built from a stubbed response keep flowing.
assert.equal(`${s.name}`, "[stub]");
assert.equal(s.a.b + "", "[stub]");
assert.equal(JSON.stringify({ "v": s }), "{}");
// Not iterable, and other symbols are undefined.
assert.equal(typeof s[Symbol.iterator], "undefined");
assert.throws(() => [...s], TypeError);

// ── respondFirst: fixtures, factories, auto-stubs ──
assert.deepEqual(respondFirst(`const r = fetch("https://x"); r.ok`, { "responses": { "fetch": { "ok": true } } }), { "completion": true, "stubbed": ["fetch"] });
let calls = 0;

assert.equal(respondFirst(`load() + load()`, { "responses": { "load": () => (calls += 1) } }).completion, 3);
assert.equal(typeof respondFirst(`db().query("x").rows[0].id`, { "autostubs": ["db"] }).completion, "function");
// An auto-stubbed source that is awaited completes (the stub is not a thenable).
assert.equal(typeof respondFirst(`(async () => { const r = await fetch("https://x"); return r.status; })()`, { "autostubs": ["fetch"] }).completion, "object");

// ── respondFirst: synthesis from the declared return type ──
const synth = (code: string, names: string[]) => respondFirst(code, { "synthesize": names }).completion;

assert.deepEqual(synth(`declare function load(): { id: number; name: string; active: boolean; tags: string[]; role: "admin" | "user"; nested?: { n: number } }; load()`, ["load"]), { "id": 0, "name": "string", "active": false, "tags": ["string"], "role": "admin", "nested": { "n": 0 } });
// A promised result stays a promise: `.then` works, and so does `await`.
assert.equal(synth(`declare function load(): Promise<{ id: number }>; load().then((u) => u.id); "ran"`, ["load"]), "ran");
const awaited = synth(`declare function load(): Promise<{ id: number }>; (async () => (await load()).id)()`, ["load"]) as Promise<unknown>;

assert.equal(await awaited, 0);
// Tuples are arrays; builtins are usable stand-ins, not stubs.
assert.deepEqual(synth(`declare function f(): [string, number]; f()`, ["f"]), ["string", 0]);
assert.equal(synth(`declare function f(): { when: Date; m: Map<string, number> }; const v = f(); [v.when.getTime() + 1, v.m.size].join(",")`, ["f"]), "1,0");
// Declared members only: a class-typed result does not drag inherited methods along.
assert.deepEqual(Object.keys(synth(`interface Row extends Array<number> { label: string } declare function f(): Row; f()`, ["f"]) as object), ["label"]);
// A recursive type terminates. (Not named `Node`: the typed program includes the DOM lib, and a script-scope alias collides with its `Node`.)
assert.deepEqual(synth(`type Link = { value: number; next: Link | null }; declare function head(): Link; head()`, ["head"]), { "value": 0, "next": null });
assert.equal(typeof synth(`type Loop = { self: Loop }; declare function loop(): Loop; loop().self.self`, ["loop"]), "function");
// Identity: `load.call(…)` / `load.apply(…)` are synthesized too.
assert.deepEqual(synth(`declare function load(): { id: number }; [load.call(null).id, load.apply(null, []).id]`, ["load"]), [0, 0]);
// An incidental host call in an argument list is not the synthesized source.
assert.equal(synth(`declare function load(d: Date): { href: string }; load(new Date(0)).href`, ["load"]), "string");
// Undeclared: the type is `any`, the result an auto-stub (documented).
assert.equal(typeof synth(`load().anything`, ["load"]), "function");

console.log("silo-stub: ok");
