// W5 measurement shim (`--fast` in the harness). Since 2026-09-05 the same validation-free path is the production
// default via patches/@bablr+record (strict mode: globalThis[Symbol.for('@bablr/record:strict')] = true).
// The BABLR runtime spends ~40% of parse time validating and freezing records; this removes the checking only.
// Upstream fix: a runtime build or flag without deep-freeze validation. `setPrototypeOf(null)` must stay:
// @bablr/btree asserts null prototypes. Verified byte-identical output on all corpus cases.
// Experiment: a drop-in for @bablr/record without the recursive `validate` walk (the profile puts that walk at
// ~30% of parse time). Records are still frozen and null-prototyped; only the invariant *checking* is skipped.
// Wired in by test/fast-record-hooks.mjs:  node --import ./test/fast-record-register.mjs …
const { freeze, isFrozen, getPrototypeOf, setPrototypeOf, getOwnPropertyNames, getOwnPropertySymbols } = Object;
const { isArray } = Array;
const cache = new WeakSet();
const isObjecty = (v) => (typeof v === "object" || typeof v === "function") && v !== null;

export function freezeRecord(obj) {
	if (getPrototypeOf(obj) !== null) { setPrototypeOf(obj, null); }
	if (!isFrozen(obj)) { freeze(obj); }

	return obj;
}

export function deepFreezeRecord(obj) {
	if (!isObjecty(obj) || cache.has(obj)) { return obj; }
	freezeRecord(obj);
	cache.add(obj);
	for (const name of getOwnPropertyNames(obj)) { deepFreezeRecord(obj[name]); }
	for (const name of getOwnPropertySymbols(obj)) { deepFreezeRecord(obj[name]); }

	return obj;
}

export const isRecord = () => true;
export const isDeepRecord = () => true;
export function *recordKeys(obj) { if (isArray(obj)) { for (let i = 0; i < obj.length; i++) { yield i; } } else { for (const k in obj) { yield k; } } }
export function *recordValues(obj) { if (isArray(obj)) { for (let i = 0; i < obj.length; i++) { yield obj[i]; } } else { for (const k in obj) { yield obj[k]; } } }
export function *recordEntries(obj) { if (isArray(obj)) { for (let i = 0; i < obj.length; i++) { yield [i, obj[i]]; } } else { for (const k in obj) { yield [k, obj[k]]; } } }
export function *arrayKeys(obj) { for (let i = 0; i < obj.length; i++) { yield i; } }
export function *arrayValues(obj) { for (let i = 0; i < obj.length; i++) { yield obj[i]; } }
export function *arrayEntries(obj) { for (let i = 0; i < obj.length; i++) { yield [i, obj[i]]; } }
