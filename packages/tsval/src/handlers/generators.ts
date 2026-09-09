/**
 * Machine suspension: `yield`, `yield*` (delegation per spec), `await`.
 */
import type { NodeFrame, Received } from "../frame.ts";
import type { Scope } from "../scope.ts";
import type { GuestFunctionMeta } from "../values.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { closeIteration, getAsyncOrSyncIterator, getIterator, getMethod, iterNext } from "./iteration.ts";
import { isObjectLike } from "./realm.ts";
import { on } from "./registry.ts";

const K = ts.SyntaxKind;

//
// `yield` and `await` suspend the current fiber by setting `vm.paused` and stashing the pause payload
// in `vm.pauseValue`. The fiber driver (VM.createGenerator / VM.callAsync) stops, hands control out,
// and on resume feeds a value back via `vm.sentValue` (or injects a return/throw signal). Left as a
// frame at phase 2, the suspension point resumes exactly where it left off.

function yieldExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.YieldExpression;

	if (node.asteriskToken) {
		yieldStar(vm, frame, node);

		return;
	}

	if (frame.phase === 0) {
		if (node.expression) {
			vm.pushNode(node.expression, frame.scope);
			frame.phase = 1;
		} else {
			suspend(vm, frame, "yield", undefined, 2);
		}
	} else if (frame.phase === 1) {
		suspend(vm, frame, "yield", vm.pop(), 2);
	} else {
		vm.frames.pop();
		vm.push(vm.fromHost(vm.sentValue)); // `.next(v)` comes from the host caller
		vm.sentValue = undefined;
	}
}

/** Park the current frame at `resumePhase` and suspend the fiber with a payload of the given kind. */
export function suspend(vm: Machine, frame: NodeFrame, kind: "yield" | "await", value: unknown, resumePhase: number, raw = false): void {
	vm.pauseValue = value;
	vm.pauseKind = kind;
	vm.pauseRaw = raw;
	vm.paused = true;
	frame.phase = resumePhase;
}

/** Take the value fed back in on resume (the `.next(v)` argument / the settled awaited value). */
export function resumed(vm: Machine): unknown {
	const value = vm.fromHost(vm.sentValue);

	vm.sentValue = undefined;

	return value;
}

/** The guest function whose body `scope` belongs to (arrows are transparent), if any. */
export function enclosingFunctionMeta(scope: Scope): GuestFunctionMeta | undefined {
	for (let s: Scope | undefined = scope; s; s = s.parent) {
		if (s.functionMeta !== undefined) { return s.functionMeta; }
	}

	return undefined;
}

// (`Received` — what a yield* frame received — lives in frame.ts with the frame shapes)

/**
 * `yield* iterable` — the spec's delegation loop (14.4.14 / AsyncGeneratorYield):
 * - each resumption of the outer generator is forwarded to the inner iterator: `next(v)`, or
 *   `throw(e)` / `return(v)` (via GetMethod: a missing `throw` closes the iterator and throws a
 *   TypeError; a missing `return` returns from the *outer* generator);
 * - every inner result must be an object; `done` and `value` are read (their getters may throw);
 * - a sync generator yields the inner result object *as-is*; an async generator awaits inner results
 *   (a sync inner iterator is adapted), then awaits the value before yielding it;
 * - the expression's own value is the inner iterator's completion value.
 * The fiber driver routes `throw`/`return` to this frame (`frame.delegating`) instead of unwinding.
 */
export function yieldStar(vm: Machine, frame: NodeFrame, node: ts.YieldExpression): void {
	const meta = enclosingFunctionMeta(frame.scope);
	const asyncGen = meta?.isAsync === true && meta.isGenerator;

	switch (frame.phase) {
		case 0:
			vm.pushNode(node.expression!, frame.scope);
			frame.phase = 1;

			return;
		case 1: {
			const iterable = vm.pop();
			const record = asyncGen ? getAsyncOrSyncIterator(vm, iterable).record : getIterator(vm, iterable);

			frame.iteration = { "record": record, "done": false };
			frame.received = { "kind": "next", "value": undefined } satisfies Received;
			frame.phase = 2;

			return;
		}

		case 2: {
			// Dispatch the received completion to the inner iterator.
			const iteration = frame.iteration!;
			const it = iteration.record.iterator as Record<string, unknown>;
			const received = frame.received!;
			let innerResult: unknown;

			if (received.kind === "next") {
				innerResult = iterNext(iteration.record, received.value);
			} else if (received.kind === "throw") {
				const throwMethod = getMethod(it, "throw");

				if (throwMethod === undefined) {
					closeIteration(iteration, false);
					throw new TypeError("The iterator does not provide a 'throw' method");
				}

				innerResult = throwMethod.call(it, received.value);
			} else {
				const returnMethod = getMethod(it, "return");

				if (returnMethod === undefined) {
					vm.frames.pop();

					vm.raise({ "type": "return", "value": received.value });

					return; // the outer generator returns
				}

				innerResult = returnMethod.call(it, received.value);
				frame.returning = true;
			}

			if (asyncGen) {
				suspend(vm, frame, "await", innerResult, 3);

				return;
			}

			delegateResult(vm, frame, innerResult, false);

			return;
		}

		case 3:
		{ delegateResult(vm, frame, resumed(vm), true);

			return; } // the awaited inner result (async)

		case 6:
			// async: the inner value has been awaited (AsyncGeneratorYield) — now yield it
			frame.delegating = true;
			suspend(vm, frame, "yield", resumed(vm), 4);

			return;

		case 4: {
			// Resumed after a yield: either a forwarded throw/return (routed by the driver) or next(v).
			frame.delegating = false;
			const injected = frame.received;

			frame.received = injected !== undefined && injected.kind !== "next" ? injected : ({ "kind": "next", "value": resumed(vm) } satisfies Received);
			frame.phase = 2;

			return;
		}

		case 5:
			vm.frames.pop();
			vm.push(frame.result);
		// no default
	}
}

export function delegateResult(vm: Machine, frame: NodeFrame, innerResult: unknown, asyncGen: boolean): void {
	if (!isObjectLike(innerResult)) { throw new TypeError("Iterator result is not an object"); }
	const returning = frame.returning === true;

	frame.returning = false;
	const result = innerResult as { "done"?: unknown; "value"?: unknown };

	if (result.done) {
		const { value } = result; // (getter may throw)

		if (returning) {
			vm.frames.pop();

			vm.raise({ "type": "return", "value": value });

			return; // inner returned → the outer generator returns
		}

		frame.result = vm.fromHost(value);
		frame.phase = 5;

		return;
	}

	if (asyncGen) {
		suspend(vm, frame, "await", result.value, 6);

		return;
	}

	// sync: yield the inner result object itself (GeneratorYield(innerResult)), never re-wrapped.
	frame.received = undefined;
	frame.delegating = true;
	suspend(vm, frame, "yield", innerResult, 4, /* raw */ true);
}

function awaitExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.AwaitExpression;

	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		suspend(vm, frame, "await", vm.pop(), 2);
	} else {
		vm.frames.pop();
		vm.push(vm.fromHost(vm.sentValue)); // the resolved value of a (host) promise enters guest land
		vm.sentValue = undefined;
	}
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(K.YieldExpression, yieldExpression);
	on(K.AwaitExpression, awaitExpression);
}
