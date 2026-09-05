/**
 * Calls: call and `new` expressions (argument evaluation with spread), tagged templates.
 */
import ts from "typescript";
import type { NodeFrame } from "../frame.ts";
import { isGuestFunction } from "../values.ts";
import type { VM } from "../vm.ts";
import { isGuestClass, superCall } from "./classes.ts";
import { cookedTemplateText, describe, normalizeTemplateLineTerminators } from "./realm.ts";
import { AFTER_REF, CHAIN_BREAK, chainShort, evaluateReference, getValue, thisOf } from "./references.ts";
import { on } from "./registry.ts";

const K = ts.SyntaxKind;

// Tagged templates: `tag\`a${x}b\`` → tag(strings, x) where `strings` is the cooked-strings array with
// a frozen `.raw`, cached per callsite (the spec's template object registry).
export const templateObjects = new WeakMap<ts.Node, readonly string[]>();

export function templateObject(vm: VM, node: ts.TaggedTemplateExpression): readonly string[] {
	let strings = templateObjects.get(node);
	if (strings === undefined) {
		const cooked = new vm.realm.Array() as string[];
		const raw = new vm.realm.Array() as string[];
		const add = (lit: ts.TemplateLiteralLikeNode): void => {
			cooked.push(cookedTemplateText(lit) as string); // (undefined for an illegal escape — allowed in a TAGGED template)
			raw.push(normalizeTemplateLineTerminators(lit.rawText ?? lit.text));
		};
		if (ts.isNoSubstitutionTemplateLiteral(node.template)) add(node.template);
		else {
			add(node.template.head);
			for (const span of node.template.templateSpans) add(span.literal);
		}
		Object.defineProperty(cooked, "raw", { value: Object.freeze(raw), enumerable: false }); // GetTemplateObject: non-enumerable
		strings = Object.freeze(cooked);
		templateObjects.set(node, strings);
	}
	return strings;
}

function taggedTemplateExpression(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.TaggedTemplateExpression;
	const tag = node.tag;
	const spans = ts.isTemplateExpression(node.template) ? node.template.templateSpans : [];
	if (frame.phase < AFTER_REF) {
		const ref = evaluateReference(vm, frame, tag);
		if (ref === undefined) return;
		frame.thisArg = thisOf(frame.scope, ref);
		vm.push(ref.kind === "short" ? undefined : getValue(vm, frame.scope, ref));
		for (let i = spans.length - 1; i >= 0; i--) vm.pushNode(spans[i].expression, frame.scope);
		frame.phase = AFTER_REF + 1;
	} else if (frame.phase === AFTER_REF + 1) {
		const substitutions = vm.values.splice(vm.values.length - spans.length);
		const calleeVal = vm.pop();
		const args = [templateObject(vm, node), ...substitutions];
		if (isGuestFunction(calleeVal)) {
			vm.pushCall(calleeVal.__tsval, args, frame.thisArg);
			frame.phase = AFTER_REF + 2;
			return;
		}
		vm.frames.pop();
		if (typeof calleeVal !== "function") throw new TypeError(`${describe(tag)} is not a function`);
		vm.push(vm.invokeHost(calleeVal as (...a: unknown[]) => unknown, frame.thisArg, args, node as unknown as ts.CallExpression, false));
	} else {
		vm.frames.pop();
	}
}

function callExpression(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.CallExpression;
	// A parenthesized member callee `(a.b)()` is still a Reference: `this` is preserved.
	let callee: ts.Expression = node.expression;
	while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
	if (callee.kind === K.SuperKeyword) return superCall(vm, frame, node);
	if (callee.kind === K.ImportKeyword) {
		// dynamic import(specifier) → Promise of the module namespace.
		if (frame.phase === 0) {
			vm.pushNode(node.arguments[0], frame.scope);
			frame.phase = 1;
		} else {
			const specifier = vm.pop();
			vm.frames.pop();
			vm.push(Promise.resolve(vm.importModule(String(specifier))));
		}
		return;
	}
	if (frame.phase < AFTER_REF) {
		// The callee as a reference: a member callee's base is the receiver; `super.m()` gets `this`.
		const ref = evaluateReference(vm, frame, callee);
		if (ref === undefined) return;
		if (ref.kind === "short") return void (vm.frames.pop(), vm.push(chainShort(node)));
		frame.thisArg = thisOf(frame.scope, ref);
		const calleeValue = getValue(vm, frame.scope, ref, false); // vetted by invokeHost instead
		// `f?.()` on a nullish callee (or a broken chain) short-circuits before the arguments run.
		if (calleeValue === CHAIN_BREAK || (calleeValue == null && node.questionDotToken)) return void (vm.frames.pop(), vm.push(chainShort(node)));
		vm.push(calleeValue);
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = AFTER_REF + 1;
	} else if (frame.phase === AFTER_REF + 1) {
		const args = collectCallArguments(vm, frame);
		const calleeVal = vm.pop();

		if (isGuestFunction(calleeVal)) {
			const meta = calleeVal.__tsval;
			// Generator / async calls produce a generator object / Promise instead of running the body
			// on the main stack (they run as suspendable fibers).
			if (meta.isGenerator && meta.isAsync) {
				vm.frames.pop();
				return vm.push(vm.createAsyncGenerator(meta, frame.thisArg, args));
			}
			if (meta.isGenerator) {
				vm.frames.pop();
				return vm.push(vm.createGenerator(meta, frame.thisArg, args));
			}
			if (meta.isAsync) {
				vm.frames.pop();
				return vm.push(vm.callAsync(meta, frame.thisArg, args));
			}
			vm.pushCall(meta, args, frame.thisArg);
			frame.phase = AFTER_REF + 2; // resume after the call returns its value
			return;
		}
		vm.frames.pop();
		if (typeof calleeVal !== "function") {
			if (node.questionDotToken && calleeVal == null) return vm.push(undefined);
			throw new TypeError(`${describe(node.expression)} is not a function`);
		}
		// Through the host guard (vets the callable, sanitizes the result) with the callsite exposed so a
		// capability shim can introspect the static type of its argument (type-directed canary, S6).
		vm.push(vm.invokeHost(calleeVal as (...a: unknown[]) => unknown, frame.thisArg, args, node, false));
	} else {
		// the guest call has left its return value on the stack.
		vm.frames.pop();
	}
}

// Evaluate call/new arguments left-to-right (pushed in reverse). A spread argument's operand is
// evaluated like any other; `spreadMask` records which operands to flatten when collecting.
export function pushCallArguments(vm: VM, frame: NodeFrame, args: readonly ts.Expression[]): void {
	const spreadMask: boolean[] = [];
	for (let i = args.length - 1; i >= 0; i--) {
		const arg = args[i];
		if (ts.isSpreadElement(arg)) {
			vm.pushNode(arg.expression, frame.scope);
			spreadMask[i] = true;
		} else {
			vm.pushNode(arg, frame.scope);
			spreadMask[i] = false;
		}
	}
	frame.argCount = args.length;
	frame.spreadMask = spreadMask;
}

export function collectCallArguments(vm: VM, frame: NodeFrame): unknown[] {
	const argCount = frame.argCount as number;
	const raw = vm.values.splice(vm.values.length - argCount);
	const spreadMask = frame.spreadMask as boolean[];
	const args: unknown[] = [];
	for (let i = 0; i < argCount; i++) {
		if (spreadMask[i]) args.push(...(raw[i] as Iterable<unknown>));
		else args.push(raw[i]);
	}
	return args;
}

// NewExpression: construct with evaluated args.
function newExpression(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.NewExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		pushCallArguments(vm, frame, node.arguments ?? []);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const args = collectCallArguments(vm, frame);
		const ctor = vm.pop();
		if (typeof ctor !== "function") throw new TypeError(`${describe(node.expression)} is not a constructor`);
		if (isGuestClass(ctor)) {
			// Construct a guest class on the explicit stack (steppable; super() supported).
			vm.pushFrame({ kind: "construct", node: null, phase: 0, scope: vm.rootScope, valuesBase: vm.values.length, ctor, args, isNew: true, newTarget: ctor });
			frame.phase = 3;
			return;
		}
		vm.frames.pop();
		vm.push(vm.invokeHost(ctor as (...a: unknown[]) => unknown, undefined, args, node, true));
	} else {
		vm.frames.pop(); // phase 3: guest construction left the instance on the stack
	}
}


/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(K.TaggedTemplateExpression, taggedTemplateExpression);
	on(K.CallExpression, callExpression);
	on(K.NewExpression, newExpression);
}
