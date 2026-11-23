/**
 * Stepped async's promise jobs are the machine's own (src/promises.ts), so their order is tsval's — held here to Node's:
 * each program runs natively and in tsval with an event loop, and logs the same lines in the same order.
 *
 *   node --test test/vm/promise-order.test.ts
 */
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

/** Each program, by what it orders. */
const PROGRAMS: Record<string, string> = {
	"then and queueMicrotask, in the order they're queued": "Promise.resolve().then(() => log(1)); queueMicrotask(() => log(2)); Promise.resolve().then(() => log(3));",
	"a promise resolved with a promise adopts it two jobs later": "const a = Promise.resolve(); new Promise((r) => r(a)).then(() => log('adopted')); a.then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"an async function returning a promise": "async function f() { return Promise.resolve(); } f().then(() => log('f')); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"await a value, then a promise": "(async () => { await null; log('a1'); await Promise.resolve(); log('a2'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"await a thenable": "(async () => { await { then(r) { log('then called'); r(); } }; log('after'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"all, race, any and allSettled": "Promise.all([1, Promise.resolve(2)]).then((v) => log('all ' + v)); Promise.race([Promise.resolve('r1'), 'r2']).then((v) => log('race ' + v)); Promise.any([Promise.reject(1), Promise.resolve('any')]).then((v) => log('any ' + v)); Promise.allSettled([Promise.reject('x'), 1]).then((v) => log('settled ' + JSON.stringify(v))); Promise.any([Promise.reject('a'), Promise.reject('b')]).catch((e) => log(e.constructor.name + ' ' + e.errors)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"finally, passing on what settled": "Promise.resolve('v').finally(() => log('fin')).then((v) => log('then ' + v)); Promise.reject('e').finally(() => { log('fin2'); return Promise.resolve(); }).catch((e) => log('caught ' + e)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5));",
	"a rejection passed on to its catch": "Promise.reject('no').then(() => log('never')).then(() => log('never')).catch((e) => log('caught ' + e)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"an executor's throw, and a promise resolved with itself": "new Promise(() => { throw 'thrown'; }).catch((e) => log('exec ' + e)); const p = Promise.resolve().then(() => p); p.catch((e) => log(e.constructor.name));",
	"a promise is a Promise, and resolving one is it": "const p = Promise.resolve(1); log(Promise.resolve(p) === p); log(p instanceof Promise); log((async () => {})() instanceof Promise); log(p.then(() => {}) instanceof Promise);",
	"withResolvers": "const { promise, resolve } = Promise.withResolvers(); promise.then((v) => log('w ' + v)); resolve(1); resolve(2); Promise.resolve().then(() => log(1));",
	"handlers that aren't functions pass the outcome on": "Promise.resolve(5).then(null, null).then(7).then((v) => log('pass ' + v)); Promise.reject(6).then(1).catch((e) => log('passed ' + e));",
	"then forwarded by call, apply and Reflect.apply": "const p = Promise.resolve(); Reflect.apply(p.then, p, [() => log(1)]); p.then(() => log(2)); queueMicrotask(() => log(3)); p.then.call(p, () => log(4)); p.then.apply(p, [() => log(5)]); p.catch.call(p, () => log('never')); log('sync');",
	"async functions calling each other": "async function inner() { log('inner'); return 'i'; } async function outer() { const v = await inner(); log('outer ' + v); return v; } outer().then((v) => log('done ' + v)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"return await, and a throw caught where it's awaited": "async function f() { return await Promise.resolve('ra'); } async function g() { throw new Error('boom'); } f().then((v) => log(v)); g().catch((e) => log('caught ' + e.message)); (async () => { try { await g(); } catch (e) { log('awaited ' + e.message); } })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"a resolve after a reject does nothing": "new Promise((resolve, reject) => { reject('first'); resolve('second'); }).then((v) => log('v ' + v), (e) => log('e ' + e));",
	"for await over values and promises": "(async () => { for await (const x of [1, Promise.resolve(2)]) log('x' + x); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5)).then(() => log(6));",
	"an async generator": "async function* g() { yield 1; yield 2; } (async () => { for await (const v of g()) log('g' + v); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5)).then(() => log(6));",
	"a subclass's then": "class P extends Promise {} const p = P.resolve(1); log(p instanceof P); p.then((v) => log('sub ' + v)); Promise.resolve().then(() => log(1)).then(() => log(2));",
	"a subclass's species, finally and statics": "class P extends Promise { static get [Symbol.species]() { log('species'); return Promise; } } const p = new P((r) => r(1)); const q = p.then((v) => v); log(q instanceof P); p.finally(() => log('fin')).then((v) => log('f ' + v)); P.all([1, 2]).then((v) => log('all ' + v)); log(P.withResolvers().promise instanceof P); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"async generator requests queued at once": "async function* g() { log('start'); const x = yield 1; log('got ' + x); yield 2; } const it = g(); it.next('a').then((r) => log(JSON.stringify(r))); it.next('b').then((r) => log(JSON.stringify(r))); it.next('c').then((r) => log(JSON.stringify(r))); it.next('d').then((r) => log(JSON.stringify(r))); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"async generator return and throw": "async function* g() { try { yield 1; yield 2; } finally { log('cleanup'); } } const a = g(); a.next().then((r) => log('n ' + r.value)); a.return('r').then((r) => log('ret ' + JSON.stringify(r))); const b = g(); b.throw(new Error('t')).catch((e) => log('thrown at start ' + e.message)); const c = g(); c.next().then(() => c.throw(new Error('inside'))).catch((e) => log('c ' + e.message)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5));",
	"async generator yielding a rejection, caught at the yield": "async function* g() { try { yield Promise.reject(new Error('no')); } catch (e) { log('caught ' + e.message); yield 'after'; } } (async () => { for await (const v of g()) log('v ' + v); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4));",
	"yield* an async generator": "async function* inner() { yield 'i1'; yield 'i2'; return 'ir'; } async function* outer() { const r = yield* inner(); log('inner returned ' + r); yield 'o'; } (async () => { for await (const v of outer()) log(v); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5)).then(() => log(6)).then(() => log(7)).then(() => log(8));",
	"break out of for await closes the generator, and waits for it": "async function* g() { try { yield 1; yield 2; } finally { log('g done'); } } (async () => { for await (const v of g()) { log(v); break; } log('broke'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5));",
	"leaving for await by a throw, a return, and an outer continue": "async function* g(name) { try { yield 1; yield 2; } finally { log(name + ' closed'); } } (async () => { try { for await (const v of g('t')) { throw new Error('out'); } } catch (e) { log('caught ' + e.message); } })(); (async () => { for await (const v of g('r')) { return 'ret'; } })().then((v) => log(v)); (async () => { outer: for (const i of [0, 1]) { for await (const v of g('c' + i)) { continue outer; } } log('continued'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5)).then(() => log(6));",
	"leaving for await over a sync iterable with a return": "const it = { [Symbol.iterator]() { let i = 0; return { next: () => ({ value: i++, done: false }), return: () => { log('sync return'); return { done: true }; } }; } }; (async () => { for await (const v of it) { log('v' + v); if (v === 1) break; } log('after'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5)).then(() => log(6));",
	"combinators with nothing, errors and thenables": "Promise.all([]).then((v) => log('empty ' + v.length)); Promise.race(5).catch((e) => log(e.constructor.name)); Promise.all([{ then(r) { r('t'); } }]).then((v) => log('thenable ' + v)); Promise.any([]).catch((e) => log('any ' + e.errors.length)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"a thenable whose then throws, and one that settles twice": "Promise.resolve({ get then() { throw new Error('getter'); } }).catch((e) => log('get ' + e.message)); Promise.resolve({ then(r, j) { r('once'); j('twice'); r('thrice'); } }).then((v) => log('v ' + v)); new Promise((r) => r({ then() { throw new Error('thrown'); } })).catch((e) => log('then ' + e.message)); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3));",
	"await in loops, between then chains": "(async () => { for (let i = 0; i < 3; i++) { await i; log('loop ' + i); } })(); (async () => { log('b0'); await Promise.resolve(); log('b1'); await new Promise((r) => queueMicrotask(r)); log('b2'); })(); Promise.resolve().then(() => log(1)).then(() => log(2)).then(() => log(3)).then(() => log(4)).then(() => log(5));"
};

/** `src` run natively, to its last job: what it logged. */
async function native(src: string): Promise<unknown[]> {
	const lines: unknown[] = [];

	// eslint-disable-next-line no-new-func, ts/no-implied-eval -- the control: the program as Node runs it
	new Function("log", src)((value: unknown) => { lines.push(value); });
	await new Promise((resolve) => { setTimeout(resolve, 0); });

	return lines;
}

/** `src` run in tsval, with an event loop: what it logged. */
async function stepped(src: string): Promise<unknown[]> {
	const lines: unknown[] = [];
	const { vm } = createVM(src, { "globals": { "log": (value: unknown) => { lines.push(value); } }, "eventLoop": { "pace": "fast" } });

	while (!vm.finished) {
		vm.runToBreakpoint();

		while (vm.idle) {
			await vm.whenSettled();
			vm.runToBreakpoint();
		}
	}

	return lines;
}

for (const [what, src] of Object.entries(PROGRAMS)) {
	test(`promise jobs as Node orders them: ${what}`, async () => {
		assert.deepStrictEqual(await stepped(src), await native(src));
	});
}
