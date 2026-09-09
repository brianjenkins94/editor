/**
 * Reference Records: `this`/`super` bindings, `evaluateReference` / getValue / putValue / thisOf, member reads, `++`/`--`, `delete`, `=` and `op=` (assignThrough).
 */
import type { NodeFrame } from "../frame.ts";
import type { Scope } from "../scope.ts";
import type { Machine, NodeHandler } from "../vm.ts";
import ts from "typescript";
import { TsvalInternalError, unimplemented } from "../errors.ts";
import { lookupPrivate, privateGet, privateSet } from "./classes.ts";
import { nameAnonymous } from "./functions.ts";
import { applyCompound } from "./operators.ts";
import { assignProgram, pushPattern } from "./patterns.ts";
import { getProperty, keyText, setProperty, stepBy, toNumeric, toPropertyKey } from "./realm.ts";
import { evaluating, on } from "./registry.ts";

const K = ts.SyntaxKind;

/** `this` in a derived constructor is uninitialized until `super()` returns (a ReferenceError). */
export const THIS_TDZ: unique symbol = Symbol("tsval.this-uninitialized");

export function thisValue(scope: Scope): unknown {
	const value = scope.getThis();

	if (value === THIS_TDZ) { throw new ReferenceError("Must call super constructor in derived class before accessing 'this' or returning from derived constructor"); }

	return value;
}

function thisKeyword(vm: Machine, frame: NodeFrame): void {
	vm.frames.pop();
	vm.push(thisValue(frame.scope));
}

// --- super references ------------------------------------------------------------------------------
// `super.x` / `super[k]` read from [[HomeObject]].[[Prototype]] with the current `this` as receiver
// (so inherited getters see the instance); `super.x = v` sets with that receiver (an inherited setter
// runs, otherwise the property lands on `this`).

export function superBase(scope: Scope): object {
	const home = scope.getHomeObject();

	if (home === null || home === undefined) { throw new SyntaxError("'super' keyword unexpected here"); }
	const base = Object.getPrototypeOf(home);

	if (base === null || base === undefined) { throw new TypeError("Cannot read properties of null (super)"); }

	return base;
}

export function superGet(scope: Scope, key: PropertyKey): unknown {
	const receiver = thisValue(scope); // the `this` binding is resolved first (spec order)

	return Reflect.get(superBase(scope), key, receiver);
}

export function superSet(scope: Scope, key: PropertyKey, value: unknown): void {
	const receiver = thisValue(scope);

	if (!Reflect.set(superBase(scope), key, value, receiver)) { throw new TypeError(`Cannot assign to read only property '${keyText(key)}'`); }
}

export function isSuperRef(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
	return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.kind === K.SuperKeyword;
}

/** Through parentheses and the erased type wrappers (`(x as T) = v`, `x! = v`, `x satisfies T`). */
export function unwrapParens(e: ts.Expression): ts.Expression {
	while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isExpressionWithTypeArguments(e)) { e = e.expression; }

	return e;
}

// --- optional chains --------------------------------------------------------------------------------
// When a `?.` link finds a nullish base, the *entire chain* is undefined and the remaining links —
// including their index expressions and call arguments — are not evaluated. Links propagate a
// marker; the outermost link of the chain turns it into `undefined`. (A parenthesized sub-chain
// `(a?.b).c` is its own chain: `.c` on undefined throws, as it should.)
export const CHAIN_BREAK: unique symbol = Symbol("tsval.optional-chain-short-circuit");

export function chainShort(node: ts.Node): unknown {
	const { parent } = node;
	const continues = parent !== undefined && ts.isOptionalChain(parent) && (parent as { "expression"?: ts.Node }).expression === node;

	return continues ? CHAIN_BREAK : undefined;
}

// --- references -------------------------------------------------------------------------------------
// The spec's Reference Record (§6.2.5) as plain data on the frame that evaluated it. Every construct
// that names a *place* — a member read, a call's callee (for `this`), an assignment target, `++`/`--`,
// `delete`, a tagged template's tag — resolves it through `evaluateReference` (the base expression,
// then a computed key, then the record) and reads/writes through getValue/putValue. An optional chain
// that short-circuits during evaluation yields `short`; a non-reference expression yields `value`.

export type Ref =
	| { "kind": "id"; "name": string }
	/** `key` is the RAW key value until first use: ToPropertyKey happens once, at GetValue/PutValue,
	 *  after a nullish base has thrown (so `null[k] = rhs()` evaluates `rhs` first, then throws). */
	| { "kind": "member"; "obj": unknown; "key": unknown }
	| { "kind": "private"; "obj": unknown; "name": string }
	/** `key` raw until first use, like a member reference (ToPropertyKey after the RHS of `super[k] = v`). */
	| { "kind": "super"; "key": unknown }
	| { "kind": "value"; "value": unknown }
	| { "kind": "short" };

/** The phase a handler continues at once its reference is resolved (lower phases belong to evaluateReference). */
export const AFTER_REF = 10;

export function nullBase(obj: unknown, key: string, forWrite: boolean): TypeError {
	return new TypeError(forWrite ? `Cannot set properties of ${obj} (setting '${key}')` : `Cannot read properties of ${obj} (reading '${key}')`);
}

/**
 * Evaluate `target` as a reference, over as many steps as its sub-expressions need. Returns the
 * record once resolved (cached on the frame; `frame.phase` is then AFTER_REF), undefined while a
 * sub-expression frame is pending. Spec order: for `super[k]` the `this` binding is checked before
 * the key and the key is converted eagerly; for `o[k]` nothing is checked or converted here — a
 * nullish base throws at GetValue/PutValue, then ToPropertyKey runs (once).
 */
export function evaluateReference(vm: Machine, frame: NodeFrame, target: ts.Expression, forWrite = false): Ref | undefined {
	if (frame.ref !== undefined) { return frame.ref; }
	const done = (ref: Ref): Ref => {
		frame.ref = ref;
		frame.phase = AFTER_REF;

		return ref;
	};

	target = unwrapParens(target);
	if (ts.isIdentifier(target)) { return done({ "kind": "id", "name": target.text }); }
	if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
		if (frame.phase === 0) {
			vm.pushNode(target, frame.scope);
			frame.phase = 1;

			return undefined;
		}

		return done({ "kind": "value", "value": vm.pop() });
	}

	const member = target;
	const isSuper = member.expression.kind === K.SuperKeyword;

	if (frame.phase === 0) {
		if (isSuper) {
			thisValue(frame.scope);
			if (ts.isPropertyAccessExpression(member)) { return done({ "kind": "super", "key": member.name.text }); }
			vm.pushNode(member.argumentExpression, frame.scope);
			frame.phase = 2;

			return undefined;
		}

		vm.pushNode(member.expression, frame.scope);
		frame.phase = 1;

		return undefined;
	}

	if (frame.phase === 1) {
		const obj = vm.values[vm.values.length - 1];

		if (obj === CHAIN_BREAK || ((obj === null || obj === undefined) && member.questionDotToken)) {
			vm.pop();

			return done({ "kind": "short" });
		}

		if (!ts.isPropertyAccessExpression(member)) {
			vm.pushNode(member.argumentExpression, frame.scope);
			frame.phase = 2;

			return undefined;
		}

		vm.pop();
		if (ts.isPrivateIdentifier(member.name)) { return done({ "kind": "private", "obj": obj, "name": member.name.text }); }

		return done({ "kind": "member", "obj": obj, "key": member.name.text });
	}

	const rawKey = vm.pop();

	if (isSuper) { return done({ "kind": "super", "key": rawKey }); }

	return done({ "kind": "member", "obj": vm.pop(), "key": rawKey });
}

/** A super reference's key at use: ToPropertyKey once, memoized on the record. */
function superKeyOf(ref: Extract<Ref, { "kind": "super" }>): PropertyKey {
	if (typeof ref.key !== "string" && typeof ref.key !== "symbol") { ref.key = toPropertyKey(ref.key); }

	return ref.key as PropertyKey;
}

/** A member reference's base and key at use: the nullish check, then ToPropertyKey (memoized on the record). */
export function memberOf(ref: Extract<Ref, { "kind": "member" | "private" }>, forWrite: boolean): { "obj": object; "key": PropertyKey } {
	if (ref.obj === null || ref.obj === undefined) { throw nullBase(ref.obj, ref.kind === "private" ? ref.name : keyText(ref.key), forWrite); }
	if (ref.kind === "private") { return { "obj": ref.obj, "key": ref.name }; }
	if (typeof ref.key !== "string" && typeof ref.key !== "symbol") { ref.key = toPropertyKey(ref.key); }

	return { "obj": ref.obj, "key": ref.key as PropertyKey };
}

/** GetValue. A member read is a host→guest crossing (`[].constructor.constructor` is the real
 *  `Function`), routed through the guard unless the caller vets the value itself (a callee). */
export function getValue(vm: Machine, scope: Scope, ref: Ref, crossing = true): unknown {
	switch (ref.kind) {
		case "id":
			return scope.get(ref.name);
		case "member": {
			const { obj, key } = memberOf(ref, false);
			const value = getProperty(vm, obj, key);

			return crossing ? vm.fromHost(value) : value;
		}

		case "private":
			return privateGet(memberOf(ref, false).obj, lookupPrivate(scope, ref.name));
		case "super": {
			const value = superGet(scope, superKeyOf(ref));

			return crossing ? vm.fromHost(value) : value;
		}

		case "value":
			return ref.value;
		case "short":
			throw new TsvalInternalError("GetValue on a short-circuited optional chain");
		// no default
	}
}

/** PutValue (strict). */
export function putValue(vm: Machine, scope: Scope, ref: Ref, value: unknown): void {
	switch (ref.kind) {
		case "id":
		{ scope.set(ref.name, value);

			return; }

		case "member": {
			const { obj, key } = memberOf(ref, true);

			setProperty(vm, obj, key, value);

			return;
		}

		case "private":
		{ privateSet(memberOf(ref, true).obj, lookupPrivate(scope, ref.name), value);

			return; }

		case "super":
		{ superSet(scope, superKeyOf(ref), value);

			return; }

		default:
			throw new SyntaxError("Invalid left-hand side in assignment");
	}
}

/** The receiver a call through the reference gets. */
export function thisOf(scope: Scope, ref: Ref): unknown {
	if (ref.kind === "member" || ref.kind === "private") { return ref.obj; }
	if (ref.kind === "super") { return thisValue(scope); }

	return undefined;
}

/** One step of a read-modify-write (see assignThrough). */
export type RmwStep = { "kind": "need-rhs" } | { "kind": "done"; "result": unknown } | { "kind": "store"; "value": unknown; "result": unknown };

/**
 * Assignment through a reference — `=`, `op=`, `++`/`--` — in spec order: the reference, then (when
 * `readFirst`) GetValue before any RHS, the RHS only when `compute` asks for it (a logical assignment
 * may be decided already), PutValue, and the expression's result.
 */
export function assignThrough(vm: Machine, frame: NodeFrame, target: ts.Expression, readFirst: boolean, compute: (current: unknown, rhs: { "value": unknown } | undefined) => RmwStep, rhs?: ts.Expression): void {
	const ref = evaluateReference(vm, frame, target, true);

	if (ref === undefined) { return; }
	if (frame.phase === AFTER_REF) {
		if (readFirst) { frame.current = getValue(vm, frame.scope, ref); }
		const step = compute(frame.current, undefined);

		if (step.kind === "need-rhs") {
			vm.pushNode(rhs!, frame.scope);
			frame.phase = AFTER_REF + 1;

			return;
		}

		vm.frames.pop();
		if (step.kind === "store") { putValue(vm, frame.scope, ref, step.value); }
		vm.push(step.result);

		return;
	}

	const step = compute(frame.current, { "value": vm.pop() });

	vm.frames.pop();
	if (step.kind === "store") { putValue(vm, frame.scope, ref, step.value); }
	vm.push(step.kind === "need-rhs" ? undefined : step.result);
}

/** `o.p` / `o[k]` / `super.x` / `this.#x` reads (one handler for both member kinds). */
export const memberRead: NodeHandler = (vm, frame) => {
	const node = frame.node as ts.PropertyAccessExpression | ts.ElementAccessExpression;
	const ref = evaluateReference(vm, frame, node);

	if (ref === undefined) { return; }
	vm.frames.pop();
	vm.push(ref.kind === "short" ? chainShort(node) : getValue(vm, frame.scope, ref));
};

function prefixUnaryExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.PrefixUnaryExpression;

	// ++/-- need an lvalue, handled without a normal operand eval.
	if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) {
		updateExpression(vm, frame, node.operand, node.operator, /* prefix */ true);

		return;
	}

	unaryOperator(vm, frame);
}

export const unaryOperator = evaluating<ts.PrefixUnaryExpression>(
	(node) => [node.operand],
	(vm, _frame, node, [value]) => {
		const v = value as never;

		switch (node.operator) {
			case K.PlusToken:
			{ vm.push(+v);

				return; }

			case K.MinusToken:
			{ vm.push(-v);

				return; }

			case K.TildeToken:
			{ vm.push(~v);

				return; }

			case K.ExclamationToken:
			{ vm.push(!v);

				return; }

			default:
				unimplemented(`prefix operator ${ts.SyntaxKind[node.operator]}`);
		}
	}
);

function postfixUnaryExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.PostfixUnaryExpression;

	updateExpression(vm, frame, node.operand, node.operator, /* prefix */ false);
}

/** `++x` / `x--` on any reference (identifier, member, private, super). */
export function updateExpression(vm: Machine, frame: NodeFrame, operand: ts.Expression, operator: ts.SyntaxKind, prefix: boolean): void {
	const delta = operator === K.PlusPlusToken ? 1 : -1;

	assignThrough(vm, frame, operand, true, (current) => {
		const old = toNumeric(current);

		return { "kind": "store", "value": stepBy(old, delta), "result": prefix ? stepBy(old, delta) : old };
	});
}

function typeOfExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.TypeOfExpression;

	if (frame.phase === 0) {
		// `typeof undeclaredVar` (also parenthesized) must not throw; guard identifier reads.
		const inner = unwrapParens(node.expression);

		if (ts.isIdentifier(inner) && !frame.scope.has(inner.text)) {
			vm.frames.pop();

			vm.push("undefined");

			return;
		}

		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const v = vm.pop();

		vm.frames.pop();
		vm.push(typeof v);
	}
}

// `delete obj.p` / `delete obj[k]` (strict: a non-configurable property throws, via the host). Any
// other operand is evaluated for effect and yields true. `delete identifier` is a strict-mode
// SyntaxError (parser).
function deleteExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.DeleteExpression;
	const target = unwrapParens(node.expression);

	if (isSuperRef(target)) {
		// `delete super.x` is a ReferenceError (after evaluating a computed key, which we skip).
		vm.frames.pop();
		throw new ReferenceError("Unsupported reference to 'super'");
	}

	const ref = evaluateReference(vm, frame, target);

	if (ref === undefined) { return; }
	vm.frames.pop();
	if (ref.kind === "member") {
		const { obj, key } = memberOf(ref, false);

		vm.push(delete (obj as Record<PropertyKey, unknown>)[key]);

		return; // strict: a non-configurable property throws
	}

	if (ref.kind === "short" || ref.kind === "value") {
		vm.push(true);

		return;
	} // `delete a?.b` on nullish `a`; a non-reference operand

	unimplemented(`delete of a ${ref.kind} reference (a strict-mode SyntaxError)`);
}

export function assignmentExpression(vm: Machine, frame: NodeFrame, node: ts.BinaryExpression): void {
	// A parenthesized target `(x) = v` / `(o.p) = v` is still a Reference (but not an IdentifierRef:
	// no NamedEvaluation through parentheses).
	const left = unwrapParens(node.left);

	if (!ts.isArrayLiteralExpression(left) && !ts.isObjectLiteralExpression(left)) {
		const names = left === node.left && ts.isIdentifier(left); // NamedEvaluation: a bare identifier target only

		assignThrough(
			vm,
			frame,
			left,
			false,
			(_current, rhs) => {
				if (rhs === undefined) { return { "kind": "need-rhs" }; }
				const value = names ? nameAnonymous(rhs.value, (left).text, node.right) : rhs.value;

				return { "kind": "store", "value": value, "result": value };
			},
			node.right
		);

		return;
	}

	// Destructuring assignment: `[a, b] = x`, `({ x } = o)`. Evaluate the RHS, then bind through a
	// pattern frame.
	if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else if (frame.phase === 1) {
			// The pattern frame runs above; the expression's value (the RHS) is already in place.
			const value = vm.pop();

			vm.push(value);
			frame.phase = 2;
			pushPattern(vm, frame.scope, assignProgram(left), value);
		} else {
			vm.frames.pop();
		}
	}
}

/** For `&&=` / `||=` / `??=`: does the current value already decide the result (RHS not evaluated)? */
export function logicalShortCircuits(op: ts.SyntaxKind, current: unknown): boolean {
	if (op === K.AmpersandAmpersandEqualsToken) { return !current; }
	if (op === K.BarBarEqualsToken) { return Boolean(current); }
	if (op === K.QuestionQuestionEqualsToken) { return current !== null && current !== undefined; }

	return false;
}

// Spec order for `lhs op= rhs`: the LHS *reference* is evaluated, then GetValue (a TDZ or null-base
// error surfaces here, before the RHS runs), then the RHS — and a logical assignment doesn't run the
// RHS at all when the current value decides.
export function compoundAssignment(vm: Machine, frame: NodeFrame, node: ts.BinaryExpression, op: ts.SyntaxKind): void {
	const left = unwrapParens(node.left);
	const names = left === node.left && ts.isIdentifier(left); // (`x ??= () => {}` names the function `x`)

	assignThrough(
		vm,
		frame,
		left,
		true,
		(current, rhs) => {
			if (rhs === undefined) { return logicalShortCircuits(op, current) ? { "kind": "done", "result": current } : { "kind": "need-rhs" }; }
			const right = names ? nameAnonymous(rhs.value, (left).text, node.right) : rhs.value;
			const result = applyCompound(op, current as never, right as never);

			return { "kind": "store", "value": result, "result": result };
		},
		node.right
	);
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(K.ThisKeyword, thisKeyword);
	on(K.PropertyAccessExpression, memberRead);
	on(K.ElementAccessExpression, memberRead);
	on(K.PrefixUnaryExpression, prefixUnaryExpression);
	on(K.PostfixUnaryExpression, postfixUnaryExpression);
	on(K.TypeOfExpression, typeOfExpression);
	on(K.DeleteExpression, deleteExpression);
}
