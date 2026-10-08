/**
 * Guest functions: creation (wrappers per realm, `.prototype`/`length`/`name` shapes), the synthetic `call` frame, parameter binding, NamedEvaluation helpers.
 */
import type { AsyncFrame, CallFrame } from "../frame.ts";
import type { GuestFunction, GuestFunctionMeta, GuestFunctionNode } from "../values.ts";
import type { Machine, NodeHandler } from "../vm.ts";
import ts from "typescript";
import { Scope } from "../scope.ts";
import { isGuestFunction } from "../values.ts";
import { isGuestClass } from "./classes.ts";
import { bindingNames, hoist } from "./hoist.ts";
import { parameterProgram, pushPattern } from "./patterns.ts";
import { createArgumentsObject } from "./realm.ts";
import { on, syntheticHandlers } from "./registry.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions used here are read off it once.
const { getCombinedModifierFlags, isArrowFunction, isBlock, isClassExpression, isConstructorDeclaration, isFunctionExpression, isGetAccessorDeclaration, isIdentifier, isMethodDeclaration, isParenthesizedExpression, isPrivateIdentifier, isSetAccessorDeclaration } = ts;

const Kind = ts.SyntaxKind;
const { ModifierFlags } = ts;

export function createGuestFunction(vm: Machine, node: GuestFunctionNode, closure: Scope, homeObject?: object): GuestFunction {
	const modifierFlags = getCombinedModifierFlags(node);
	const meta: GuestFunctionMeta = {
		"node": node,
		"closure": closure,
		"name": node.name !== null && node.name !== undefined && (isIdentifier(node.name) || isPrivateIdentifier(node.name)) ? node.name.text : "",
		"isArrow": node.kind === Kind.ArrowFunction,
		"isGenerator": (node).asteriskToken !== null && (node).asteriskToken !== undefined,
		"isAsync": (modifierFlags & ModifierFlags.Async) !== 0,
		"homeObject": homeObject
	};
	// The host-invoked wrapper (array callbacks, host-supplied functions, host-mediated `new`) runs a nested loop to
	// completion. Its *shape* mirrors the guest function's: an arrow (no `this`, no `prototype`, not
	// constructible), a concise method (has `this`, no `prototype`, not constructible), or a plain
	// function (constructible; `new.target` forwarded so the body can observe construction).
	const isMethodLike = isMethodDeclaration(node) || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node) || isConstructorDeclaration(node);
	const fn = makeWrapper(vm, meta, isMethodLike);

	fn.__tsval = meta;
	// Realm fidelity: the function object belongs to the guest realm's Function.prototype (or the
	// %GeneratorFunction.prototype% / %AsyncFunction.prototype% family), and a constructible
	// function's `.prototype` is a guest-realm object. A generator function's `.prototype` is the
	// prototype of the generator objects it creates (and is not a constructor).
	const { realm } = vm;

	let functionProto;

	if (meta.isGenerator) {
		functionProto = meta.isAsync ? realm.AsyncGeneratorFunctionPrototype : realm.GeneratorFunctionPrototype;
	} else if (meta.isAsync) {
		functionProto = realm.AsyncFunctionPrototype;
	} else {
		functionProto = realm.Function.prototype;
	}

	Object.setPrototypeOf(fn, functionProto);
	if (meta.isGenerator) {
		Object.defineProperty(fn, "prototype", { "value": Object.create(meta.isAsync ? realm.AsyncGeneratorPrototype : realm.GeneratorPrototype), "writable": true, "enumerable": false, "configurable": false });
	} else if (!meta.isArrow && !isMethodLike && !meta.isAsync) {
		const proto = new realm.Object();

		Object.defineProperty(proto, "constructor", { "value": fn, "writable": true, "configurable": true });
		Object.defineProperty(fn, "prototype", { "value": proto, "writable": true });
	}

	meta.self = fn;
	Object.defineProperty(fn, "length", { "value": functionLength(node.parameters), "configurable": true });
	Object.defineProperty(fn, "name", { "value": meta.name, "configurable": true });
	// A named function *expression* binds its own name inside itself, immutably (assigning to it is a
	// TypeError in strict code).
	if (isFunctionExpression(node) && node.name !== undefined) {
		const inner = new Scope(closure, false);

		inner.declareLexical(node.name.text, "const");
		inner.initialize(node.name.text, fn);
		meta.closure = inner;
	}

	return fn;
}

// Fixed wrapper templates (NOT guest code) for creating a function object *inside another realm*: a
// function's realm decides fallbacks like `new F()` with a non-object `F.prototype`, and whether
// `F instanceof Function` holds for the guest's `Function`.
// Strict, like the in-realm wrappers (an ESM module): a host caller's `undefined` receiver must
// reach the guest as `undefined`, not the realm's global object.
export const FOREIGN_WRAPPERS = {
	"arrow": "\"use strict\"; return (...args) => vm.callGuestFromHost(meta, undefined, args);",
	"method": "\"use strict\"; return { m(...args) { return vm.callGuestFromHost(meta, this, args); } }.m;",
	"plain": "\"use strict\"; return function (...args) { return vm.callGuestFromHost(meta, this, args, new.target); };"
};

export function makeWrapper(vm: Machine, meta: GuestFunctionMeta, methodLike: boolean): GuestFunction {
	// Generator and async functions are not constructors either (`new gen()` is a TypeError).
	const isMethodLike = methodLike || meta.isGenerator || meta.isAsync;

	if (vm.realm.Function !== Function) {
		let template;

		if (meta.isArrow) {
			template = FOREIGN_WRAPPERS.arrow;
		} else if (isMethodLike) {
			template = FOREIGN_WRAPPERS.method;
		} else {
			template = FOREIGN_WRAPPERS.plain;
		}

		return (vm.realm.Function("vm", "meta", template) as (vm: Machine, meta: GuestFunctionMeta) => GuestFunction)(vm, meta);
	}

	if (meta.isArrow) {
		return ((...args: unknown[]) => vm.callGuestFromHost(meta, undefined, args)) as GuestFunction;
	}

	if (isMethodLike) {
		return {
			"m": function(this: unknown, ...args: unknown[]) {
				return vm.callGuestFromHost(meta, this, args);
			}
		}.m as GuestFunction;
	}

	return function(this: unknown, ...args: unknown[]): unknown {
		return vm.callGuestFromHost(meta, this, args, new.target);
	} as GuestFunction;
}

export const makeFunction: NodeHandler = (vm, frame) => {
	const node = frame.node as ts.FunctionExpression | ts.ArrowFunction;

	vm.frames.pop();
	vm.push(createGuestFunction(vm, node, frame.scope));
};

// Synthetic call frame: run a guest function on the explicit stack.
function callFrame(vm: Machine, frame: CallFrame): void {
	const { meta } = frame;
	const { node } = meta;

	if (frame.phase === 0) {
		const fnScope = new Scope(meta.closure, /* isolated */ true);

		if (!meta.isArrow) {
			fnScope.hasThis = true;
			fnScope.thisVal = frame.thisArg;
			if (meta.homeObject !== undefined) {
				fnScope.homeObject = meta.homeObject;
			}

			if (frame.newTarget !== undefined) {
				fnScope.newTarget = frame.newTarget;
			}

			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", createArgumentsObject(vm, frame.args));
		}

		fnScope.functionMeta = meta;
		frame.scope = fnScope;
		// With non-simple parameters (defaults, patterns, rest) the body gets its own var environment:
		// a closure in a default sees the *parameter*, not a same-named `var` declared in the body.
		const plan = parameterPlan(node);
		const bodyScope = plan.simple ? fnScope : new Scope(fnScope, true);

		if (isBlock(node.body!)) {
			hoist(vm, bodyScope, node.body.statements);
			// Reuse the body scope for the body block (body vars live there directly).
			const bodyFrame = vm.pushNode(node.body, bodyScope);

			bodyFrame.reuseScope = true;
			frame.phase = 1;
		} else {
			// Arrow with an expression body: value is the return value.
			vm.pushNode(node.body!, bodyScope);
			frame.phase = 2;
		}

		bindParameters(vm, fnScope, node, frame.args, plan); // (the parameter frame runs before the body)
	} else if (frame.phase === 1) {
		// Body completed with no explicit return.
		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(undefined);
	} else {
		// Arrow expression-body value is on the stack; it is the return value.
		const value = vm.pop();

		vm.observe?.(node, "return", value); // the arrow itself: its body may be a site of its own (`() => a ?? b`)

		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(value);
	}
}

/** A TypeScript `this:` pseudo-parameter — types the receiver, binds nothing, takes no argument. */
export function isThisParameter(param: ts.ParameterDeclaration): boolean {
	return isIdentifier(param.name) && param.name.text === "this";
}

/** JS `Function.length`: params before the first default/rest, excluding a `this:` pseudo-param. */
export function functionLength(params: readonly ts.ParameterDeclaration[]): number {
	let count = 0;

	for (const param of params) {
		if (!isThisParameter(param)) {
			if (param.initializer !== undefined || param.dotDotDotToken !== undefined) {
				break;
			}

			count += 1;
		}
	}

	return count;
}

/**
 * FunctionDeclarationInstantiation's parameter part. Every parameter name starts in the TDZ (a
 * default referring to itself or a later parameter — `function f(a = b, b) {}` — is a
 * ReferenceError); the parameter program then binds them in order, as a pattern frame pushed ABOVE
 * the body's (call AFTER pushing the body). Defaults are ordinary guest expressions on the stack.
 */
export function bindParameters(vm: Machine, scope: Scope, node: ts.SignatureDeclaration, args: unknown[], plan = parameterPlan(node)): void {
	const { params } = plan;

	for (let index = 0; index < params.length; index++) {
		const { param, names, told, rest } = params[index];

		// What was passed for it, or what a rest parameter collects — not for one with a default or a pattern: what a
		// preview's instrumented code can see of those isn't the same (RUNTIME-EVIDENCE.md, P8), and evidence from
		// either runtime must mean one thing.
		if (told !== undefined && (vm.observe !== undefined || vm.trace !== undefined)) {
			vm.observe?.(param, "parameter", rest ? args.slice(index) : args[index]);
			vm.traced("bind", param, told, rest ? args.slice(index) : args[index]);
		}

		for (const name of names) {
			scope.declareLexical(name, "let");
		}
	}

	if (params.length > 0) {
		pushPattern(vm, scope, parameterProgram(node), undefined, args);
	}
}

/** A signature's parameters as a call binds them, worked out once per signature (a call made in a loop shouldn't redo
 *  it): each one but a `this:` pseudo-parameter, with the names it binds, its name when it's told to `observe`/`trace`
 *  (an identifier without a default), and whether it's a rest parameter; and whether they're all simple (identifiers,
 *  without a default or a rest — then the body shares their scope). */
interface ParameterPlan {
	"params": { "param": ts.ParameterDeclaration; "names": string[]; "told": string | undefined; "rest": boolean }[];
	"simple": boolean;
}

const parameterPlans = new WeakMap<ts.SignatureDeclaration, ParameterPlan>();

function parameterPlan(node: ts.SignatureDeclaration): ParameterPlan {
	let plan = parameterPlans.get(node);

	if (plan === undefined) {
		plan = {
			"params": node.parameters.filter((param) => !isThisParameter(param)).map((param) => ({ "param": param, "names": bindingNames(param.name), "told": param.initializer === undefined && isIdentifier(param.name) ? param.name.text : undefined, "rest": param.dotDotDotToken !== undefined })),
			"simple": !node.parameters.some((param) => param.initializer !== undefined || param.dotDotDotToken !== undefined || !isIdentifier(param.name))
		};
		parameterPlans.set(node, plan);
	}

	return plan;
}

// --- NamedEvaluation: an anonymous function/class takes the name it's bound or assigned to --------

/** `function () {}`, `() => {}`, `class {}` — possibly parenthesized (the cover grammar). */
export function isAnonymousFunctionDefinition(node: ts.Node): boolean {
	while (isParenthesizedExpression(node)) {
		node = node.expression;
	}

	return (isFunctionExpression(node) && node.name === undefined) || isArrowFunction(node) || (isClassExpression(node) && node.name === undefined);
}

/** SetFunctionName's text for a property key: a symbol's description in brackets, an optional `get`/`set` prefix. */
export function functionNameText(key: PropertyKey, prefix = ""): string {
	let base;

	if (typeof key === "symbol") {
		base = key.description === undefined ? "" : `[${key.description}]`;
	} else {
		base = String(key);
	}

	return prefix === "" ? base : `${prefix} ${base}`;
}

/** SetFunctionName for a method/accessor defined under `key`. */
export function setFunctionName(fn: GuestFunction, key: PropertyKey, prefix = ""): void {
	const text = functionNameText(key, prefix);

	Object.defineProperty(fn, "name", { "value": text, "configurable": true });
	fn.__tsval.name = text;
}

/** Give `value` the name `name` iff it came from an anonymous function definition `from` and has none. */
export function nameAnonymous(value: unknown, name: PropertyKey, from: ts.Node | undefined): unknown {
	if (from === undefined || !isAnonymousFunctionDefinition(from)) {
		return value;
	}

	if (!(isGuestFunction(value) || isGuestClass(value))) {
		return value;
	}

	if ((value as { "name"?: string }).name !== "") {
		return value;
	}

	const text = functionNameText(name);

	Object.defineProperty(value, "name", { "value": text, "configurable": true });
	if (isGuestFunction(value)) {
		value.__tsval.name = text;
	}

	return value;
}

/** NamedEvaluation for a binding target: only a plain identifier names the value. */
export function namedIf(value: unknown, target: ts.BindingName | ts.Expression, from: ts.Node | undefined): unknown {
	return isIdentifier(target) ? nameAnonymous(value, target.text, from) : value;
}

/** Stepped async: the async function's body (or a host-called callback) completed with the value on top — resolve its
 *  promise, and hand the promise to the caller if it hasn't had it (the body never suspended). */
function asyncFrame(vm: Machine, frame: AsyncFrame): void {
	const value = vm.values.length > frame.valuesBase ? vm.pop() : undefined;

	vm.frames.pop();
	vm.values.length = frame.valuesBase;
	frame.resolve(value);

	if (frame.delivered !== true) {
		frame.delivered = true;
		vm.push(frame.promise);
	}
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(Kind.FunctionExpression, makeFunction);
	on(Kind.ArrowFunction, makeFunction);
	syntheticHandlers.call = callFrame;
	syntheticHandlers.async = asyncFrame;
}
