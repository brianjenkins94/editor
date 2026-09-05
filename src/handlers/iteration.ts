/**
 * Iteration protocol: iterator records (cached `next`), the cloneable array-iteration fast path, IteratorStep/IteratorClose, async-or-sync iterators.
 */
import ts from "typescript";
import type { Iteration } from "../frame.ts";
import type { VM } from "../vm.ts";
import { isObjectLike } from "./realm.ts";
import { on } from "./registry.ts";

/** GetIterator(async): `@@asyncIterator` via GetMethod (present-but-not-callable is a TypeError, not a
 *  fallback), else the sync iterator — and either result must be an object. */
export function getAsyncOrSyncIterator(vm: VM, iterable: unknown): { record: IterRecord; sync: boolean } {
	if (iterable == null) throw new TypeError(`${String(iterable)} is not async iterable`);
	const asyncFactory = (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
	if (asyncFactory != null) {
		if (typeof asyncFactory !== "function") throw new TypeError("Symbol.asyncIterator is not a function");
		const iterator = (asyncFactory as () => unknown).call(iterable);
		if (!isObjectLike(iterator)) throw new TypeError("Result of the Symbol.asyncIterator method is not an object");
		return { record: { iterator: iterator as object, next: (iterator as { next?: unknown }).next }, sync: false };
	}
	return { record: getIterator(vm, iterable), sync: true };
}

/** GetMethod: undefined/null → absent; otherwise must be callable. */
export function getMethod(obj: unknown, name: string): ((...a: unknown[]) => unknown) | undefined {
	const fn = (obj as Record<string, unknown>)[name];
	if (fn == null) return undefined;
	if (typeof fn !== "function") throw new TypeError(`${name} is not a function`);
	return fn as (...a: unknown[]) => unknown;
}

/** The spec's Iterator Record: the iterator plus its `next` method, read ONCE at GetIterator time
 *  (observable: a `next` getter fires once, and a later reassignment of `next` is not seen). */
export interface IterRecord {
	iterator: object;
	next: unknown;
}

/**
 * Iteration state for an array whose iteration is pristine (see getIterator): a PLAIN object, so a
 * fork mid-iteration clones it — a host ArrayIterator would be shared, and one fork's steps would
 * starve the other's (`exploreCanary` forks inside `for…of` bodies). Observably the same as the
 * intrinsic: each step reads `length` then the index (through any getter or Proxy trap); once
 * exhausted it stays done without reading again; results are guest-realm objects.
 */
export interface ArrayIteration {
	array: ArrayLike<unknown>;
	index: number;
	done: boolean;
	Obj: ObjectConstructor;
}

export const arrayIterationNext = function (this: ArrayIteration): IteratorResult<unknown> {
	const result = new this.Obj() as unknown as { value: unknown; done: boolean };
	if (!this.done) {
		const i = this.index;
		if (i < this.array.length) {
			this.index = i + 1;
			result.value = this.array[i];
			result.done = false;
			return result;
		}
		this.done = true;
	}
	result.value = undefined;
	result.done = true;
	return result;
};

/** GetIterator: a TypeError (not a property-of-null error) when the value isn't iterable. */
export function getIterator(vm: VM, value: unknown): IterRecord {
	const factory = value == null ? undefined : (value as { [Symbol.iterator]?: () => Iterator<unknown> })[Symbol.iterator];
	if (typeof factory !== "function") throw new TypeError(`${value === null ? "null" : typeof value === "object" ? "object" : String(value)} is not iterable`);
	const realm = vm.realm;
	if (Array.isArray(value) && factory === realm.arrayValues && realm.arrayIteratorPrototype.next === realm.arrayIteratorNext) {
		const iteration: ArrayIteration = { array: value, index: 0, done: false, Obj: realm.Object };
		return { iterator: iteration, next: arrayIterationNext };
	}
	const iterator = factory.call(value);
	if (typeof iterator !== "object" || iterator === null) throw new TypeError("Result of the Symbol.iterator method is not an object");
	return { iterator, next: (iterator as { next?: unknown }).next };
}

/** IteratorNext: call the cached `next` (must be callable); the result must be an object. */
export function iterNext(record: IterRecord, ...args: unknown[]): IteratorResult<unknown> {
	if (typeof record.next !== "function") throw new TypeError("iterator.next is not a function");
	const result = (record.next as (...a: unknown[]) => unknown).apply(record.iterator, args);
	if (typeof result !== "object" || result === null) throw new TypeError("Iterator result is not an object");
	return result as IteratorResult<unknown>;
}

/**
 * IteratorStep + IteratorValue on an open iteration (a loop frame's, a pattern frame's): the value,
 * or undefined once exhausted (`it.done`, which stays set — no further `next` calls). An iterator
 * whose `next`/`done`/`value` throws is marked done first: the error is the iterator's own, so no
 * IteratorClose is attempted on it (spec).
 */
export function iterationStep(it: Iteration): unknown {
	if (it.done) return undefined;
	try {
		const r = iterNext(it.record);
		if (r.done) {
			it.done = true;
			return undefined;
		}
		return r.value;
	} catch (error) {
		it.done = true;
		throw error;
	}
}

/** IteratorClose on an iteration unless it is exhausted; marks it done either way. */
export function closeIteration(it: Iteration, abrupt: boolean): void {
	if (it.done) return;
	it.done = true;
	closeIterator(it.record.iterator, false, abrupt);
}

/** IteratorClose: call `return()` on an iterator a pattern didn't exhaust. On an abrupt completion the
 *  original error wins over anything `return()` throws; on a normal one, `return()`'s errors surface. */
export function closeIterator(iterator: object, done: boolean, abrupt: boolean): void {
	if (done) return;
	const ret = (iterator as { return?: unknown }).return;
	if (ret == null) return;
	if (abrupt) {
		try {
			if (typeof ret === "function") (ret as () => unknown).call(iterator);
		} catch {
			/* the original error wins */
		}
		return;
	}
	if (typeof ret !== "function") throw new TypeError("iterator.return is not a function");
	const result = (ret as () => unknown).call(iterator);
	if (typeof result !== "object" || result === null) throw new TypeError("iterator.return() did not return an object");
}
