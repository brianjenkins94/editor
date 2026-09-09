/**
 * Destructuring: binding/assignment patterns, parameter lists and catch parameters compile to plain-data ops run by the synthetic `pattern` frame.
 */
import type { PatternFrame } from "../frame.ts";
import type { BindingKind, Scope } from "../scope.ts";
import type { Machine } from "../vm.ts";
import type { Ref } from "./references.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { isThisParameter, nameAnonymous } from "./functions.ts";
import { closeIteration, getIterator, iterationStep } from "./iteration.ts";
import { propertyName } from "./literals.ts";
import { copyRestProperties, defineData, getProperty, realmArray, toPropertyKey } from "./realm.ts";
import { isSuperRef, putValue, unwrapParens } from "./references.ts";
import { syntheticHandlers } from "./registry.ts";

const K = ts.SyntaxKind;

/**
 * Bind a declaration target (identifier or binding pattern) to an already-computed value, declaring
 * into `scope`. The leaf sub-expressions of a pattern — default values and computed keys — are
 * evaluated synchronously (`vm.evalNodeSync`); the destructuring itself is pure.
 */
export function bindIdentifier(scope: Scope, name: string, value: unknown, kind: BindingKind): void {
	if (kind === "var") {
		scope.declareVar(name);
		scope.set(name, value);
	} else {
		scope.declareLexical(name, kind);
		scope.initialize(name, value);
	}
}

// A pattern is compiled once into a flat list of plain-data ops, run by a synthetic `pattern` frame
// whose state — pc, a temp stack, open iterator records, open source objects — lives in frame
// fields, so a fork or a snapshot mid-pattern is an ordinary frame clone. Defaults, computed keys and
// member targets are pushed as ordinary node frames, so `const [a = yield] = it` or `[o[await k]] =
// v` suspend like anything else. The compiled program is a class instance (shared by forks, never
// mutated). Parameter lists compile to the same ops (`arg` / `rest-args` read the argument vector).

export type PatOp =
	| { "op": "eval"; "node": ts.Expression } // push a node frame; its value lands on temps on resume
	| { "op": "arg"; "index": number } // a parameter's argument → temps.push (undefined when absent)
	| { "op": "rest-args"; "from": number } // the remaining arguments as a guest array → temps.push
	| { "op": "iter-open" } // temps.pop() → GetIterator → iters.push
	| { "op": "iter-step" } // IteratorStep+IteratorValue → temps.push (undefined once done)
	| { "op": "iter-skip" } // an elision
	| { "op": "iter-rest" } // drain → temps.push(array)
	| { "op": "iter-close" } // IteratorClose (normal completion) → iters.pop
	| { "op": "obj-open" } // temps.pop() → RequireObjectCoercible → objs.push
	| { "op": "to-key" } // temps.pop() → ToPropertyKey → keys.push
	| { "op": "obj-get"; "key"?: PropertyKey } // GetV(source, key ?? keys.pop()) → temps.push; remembers the key for rest
	| { "op": "obj-rest" } // CopyDataProperties minus the used keys → temps.push
	| { "op": "obj-close" }
	| { "op": "jump-if-defined"; "offset": number } // default: keep a defined value and skip its initializer ops
	| { "op": "name"; "name": string; "from": ts.Node } // NamedEvaluation of a default onto an identifier target
	| { "op": "bind"; "name": string; "kind": BindingKind } // temps.pop() → declare/initialize
	| { "op": "assign-id"; "name": string } // temps.pop() → PutValue
	| { "op": "member-ref"; "hasKey": boolean; "text": string; "privateName"?: string } // (key), base → reference record
	| { "op": "member-store" } // value, reference → PutValue
	| { "op": "swap" }; // exchange the two top temps (a member target bound to a value already obtained)

export class PatternProgram {
	readonly ops: readonly PatOp[];
	constructor(ops: readonly PatOp[]) {
		this.ops = ops; // (an explicit field: Node's strip-only TS has no parameter properties)
	}
}

export const patternPrograms = new WeakMap<ts.Node, Map<string, PatternProgram>>();

export function cachedProgram(node: ts.Node, variant: string, compile: (ops: PatOp[]) => void): PatternProgram {
	let byVariant = patternPrograms.get(node);

	if (byVariant === undefined) { patternPrograms.set(node, (byVariant = new Map())); }
	let program = byVariant.get(variant);

	if (program === undefined) {
		const ops: PatOp[] = [];

		compile(ops);
		byVariant.set(variant, (program = new PatternProgram(ops)));
	}

	return program;
}

export const bindingProgram = (target: ts.BindingName, kind: BindingKind): PatternProgram => cachedProgram(target, `bind:${kind}`, (ops) => { compileBinding(target, kind, ops); });

export const assignProgram = (target: ts.Expression): PatternProgram => cachedProgram(target, "assign", (ops) => { compileAssign(target, ops); });

/** A parameter list: each parameter reads its argument (or the rest), applies its default, binds. */
export function parameterProgram(node: ts.SignatureDeclaration): PatternProgram {
	return cachedProgram(node, "params", (ops) => {
		const params = node.parameters.filter((p) => !isThisParameter(p));

		for (let i = 0; i < params.length; i++) {
			const param = params[i];

			if (param.dotDotDotToken) {
				ops.push({ "op": "rest-args", "from": i });
				compileBinding(param.name, "param", ops);
				break;
			}

			ops.push({ "op": "arg", "index": i });
			compileDefault(param.initializer, param.name, ops);
			compileBinding(param.name, "param", ops);
		}
	});
}

/** Start binding through `program` in `scope`: the frame runs above the caller's. `value` seeds the
 *  temp stack (the destructured value); a parameter program reads `args` instead. */
export function pushPattern(vm: Machine, scope: Scope, program: PatternProgram, value: unknown, args?: unknown[]): void {
	vm.pushFrame({ "kind": "pattern", "node": null, "phase": 0, "scope": scope, "valuesBase": vm.values.length, "program": program, "pc": 0, "temps": args === undefined ? [value] : [], "iters": [], "objs": [], "keys": [], "args": args });
}

// --- compilation (each compiled pattern consumes temps.top) ---

export function compileDefault(init: ts.Expression | undefined, nameTarget: ts.Node, ops: PatOp[]): void {
	if (init === undefined) { return; }
	const naming: PatOp[] = ts.isIdentifier(nameTarget) ? [{ "op": "name", "name": nameTarget.text, "from": init }] : [];

	ops.push({ "op": "jump-if-defined", "offset": 1 + naming.length }, { "op": "eval", "node": init }, ...naming);
}

export function compileKey(name: ts.PropertyName, ops: PatOp[]): void {
	if (ts.isComputedPropertyName(name)) { ops.push({ "op": "eval", "node": name.expression }, { "op": "to-key" }, { "op": "obj-get" }); } else { ops.push({ "op": "obj-get", "key": propertyName(name) }); }
}

export function compileBinding(target: ts.BindingName, kind: BindingKind, ops: PatOp[]): void {
	if (ts.isIdentifier(target)) { return void ops.push({ "op": "bind", "name": target.text, "kind": kind }); }
	if (ts.isArrayBindingPattern(target)) {
		ops.push({ "op": "iter-open" });
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) {
				ops.push({ "op": "iter-skip" });
			} else if (element.dotDotDotToken) {
				ops.push({ "op": "iter-rest" });
				compileBinding(element.name, kind, ops);
			} else {
				ops.push({ "op": "iter-step" });
				compileDefault(element.initializer, element.name, ops);
				compileBinding(element.name, kind, ops);
			}
		}

		ops.push({ "op": "iter-close" });

		return;
	}

	ops.push({ "op": "obj-open" });
	for (const element of target.elements) {
		if (element.dotDotDotToken) {
			ops.push({ "op": "obj-rest" });
			compileBinding(element.name, kind, ops);
			continue;
		}

		compileKey(element.propertyName ?? (element.name as ts.Identifier), ops);
		compileDefault(element.initializer, element.name, ops);
		compileBinding(element.name, kind, ops);
	}

	ops.push({ "op": "obj-close" });
}

/** One assignment-pattern element: the target *reference* is evaluated before the value is obtained
 *  (`emitSource`), then the default, then PutValue — the spec's order. */
export function compileAssignElement(elementTarget: ts.Expression, init: ts.Expression | undefined, emitSource: () => void, ops: PatOp[]): void {
	const target = unwrapParens(elementTarget);

	if (isSuperRef(target)) { unimplemented("a super reference as a destructuring target"); }
	const isMember = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target);

	if (isMember) {
		ops.push({ "op": "eval", "node": target.expression });
		if (ts.isElementAccessExpression(target)) { ops.push({ "op": "eval", "node": target.argumentExpression }, { "op": "member-ref", "hasKey": true, "text": "" }); } else { ops.push({ "op": "member-ref", "hasKey": false, "text": target.name.text, "privateName": ts.isPrivateIdentifier(target.name) ? target.name.text : undefined }); }
	}

	emitSource();
	compileDefault(init, target, ops);
	if (isMember) { ops.push({ "op": "member-store" }); } else { compileAssign(target, ops); }
}

export function compileAssign(elementTarget: ts.Expression, ops: PatOp[]): void {
	const target = unwrapParens(elementTarget);

	if (ts.isIdentifier(target)) { return void ops.push({ "op": "assign-id", "name": target.text }); }
	// A bare member target (`for (o.x of xs)`): the value is on the temps first (spec: the next value,
	// THEN the reference), so the reference is evaluated above it and swapped under before the store.
	if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
		compileAssignElement(target, undefined, () => ops.push({ "op": "swap" }), ops);

		return;
	}

	if (ts.isArrayLiteralExpression(target)) {
		ops.push({ "op": "iter-open" });
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) { ops.push({ "op": "iter-skip" }); } else if (ts.isSpreadElement(element)) { compileAssignElement(element.expression, undefined, () => ops.push({ "op": "iter-rest" }), ops); } else {
				const withDefault = ts.isBinaryExpression(element) && element.operatorToken.kind === K.EqualsToken;

				compileAssignElement(withDefault ? element.left : element, withDefault ? element.right : undefined, () => ops.push({ "op": "iter-step" }), ops);
			}
		}

		ops.push({ "op": "iter-close" });

		return;
	}

	if (ts.isObjectLiteralExpression(target)) {
		ops.push({ "op": "obj-open" });
		for (const prop of target.properties) {
			if (ts.isSpreadAssignment(prop)) {
				compileAssignElement(prop.expression, undefined, () => ops.push({ "op": "obj-rest" }), ops);
			} else if (ts.isPropertyAssignment(prop)) {
				// Key (with ToPropertyKey) first, then the target reference, then GetV.
				let source: PatOp;

				if (ts.isComputedPropertyName(prop.name)) {
					ops.push({ "op": "eval", "node": prop.name.expression }, { "op": "to-key" });
					source = { "op": "obj-get" };
				} else { source = { "op": "obj-get", "key": propertyName(prop.name) }; }

				const withDefault = ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === K.EqualsToken;

				compileAssignElement(withDefault ? prop.initializer.left : prop.initializer, withDefault ? prop.initializer.right : undefined, () => ops.push(source), ops);
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				ops.push({ "op": "obj-get", "key": prop.name.text });
				compileDefault(prop.objectAssignmentInitializer, prop.name, ops);
				ops.push({ "op": "assign-id", "name": prop.name.text });
			} else { unimplemented(`assignment pattern property ${ts.SyntaxKind[prop.kind]}`); }
		}

		ops.push({ "op": "obj-close" });

		return;
	}

	unimplemented(`assignment pattern target ${ts.SyntaxKind[target.kind]}`);
}

// --- execution ---

function patternFrame(vm: Machine, frame: PatternFrame): void {
	const { program } = frame;
	const { temps } = frame;
	const { iters } = frame;
	const { objs } = frame;
	const { keys } = frame;
	const { scope } = frame;

	if (frame.awaiting === true) {
		frame.awaiting = false;
		temps.push(vm.pop());
	}

	for (;;) {
		const { pc } = frame;

		if (pc >= program.ops.length) { return void vm.frames.pop(); }
		const op = program.ops[pc];

		frame.pc = pc + 1;
		switch (op.op) {
			case "eval":
				frame.awaiting = true;
				vm.pushNode(op.node, scope);

				return;
			case "arg":
				temps.push((frame.args!)[op.index]);
				break;
			case "rest-args":
				temps.push(realmArray(vm, Array.prototype.slice.call(frame.args!, op.from)));
				break;
			case "iter-open":
				iters.push({ "record": getIterator(vm, temps.pop()), "done": false });
				break;
			case "iter-step":
				temps.push(iterationStep(iters[iters.length - 1]));
				break;
			case "iter-skip":
				iterationStep(iters[iters.length - 1]);
				break;
			case "iter-rest": {
				const it = iters[iters.length - 1];
				const rest = new vm.realm.Array() as unknown[];

				for (;;) {
					const v = iterationStep(it);

					if (it.done) { break; }
					defineData(rest, rest.length, v);
				}

				temps.push(rest);
				break;
			}

			case "iter-close":
				closeIteration(iters.pop()!, false);
				break;
			case "obj-open": {
				const value = temps.pop();

				if (value == null) { throw new TypeError(`Cannot destructure '${String(value)}' as it is ${String(value)}.`); }
				objs.push({ "value": value, "used": [] });
				break;
			}

			case "to-key":
				keys.push(toPropertyKey(temps.pop()));
				break;
			case "obj-get": {
				const source = objs[objs.length - 1];
				const key = op.key ?? (keys.pop()!);

				source.used.push(key);
				temps.push(vm.fromHost(getProperty(vm, source.value, key)));
				break;
			}

			case "obj-rest": {
				const source = objs[objs.length - 1];
				const rest = new vm.realm.Object();

				copyRestProperties(vm, rest, source.value, new Set(source.used));
				temps.push(rest);
				break;
			}

			case "obj-close":
				objs.pop();
				break;
			case "jump-if-defined":
				if (temps[temps.length - 1] !== undefined) { frame.pc += op.offset; } else { temps.pop(); }

				break;
			case "name":
				temps.push(nameAnonymous(temps.pop(), op.name, op.from));
				break;
			case "bind":
				bindIdentifier(scope, op.name, temps.pop(), op.kind);
				break;
			case "assign-id":
				putValue(vm, scope, { "kind": "id", "name": op.name }, temps.pop());
				break;
			case "member-ref": {
				const key: unknown = op.hasKey ? temps.pop() : op.text;
				const obj = temps.pop();

				temps.push(op.privateName !== undefined ? ({ "kind": "private", "obj": obj, "name": op.privateName } satisfies Ref) : ({ "kind": "member", "obj": obj, "key": key } satisfies Ref));
				break;
			}

			case "member-store": {
				const value = temps.pop();

				putValue(vm, scope, temps.pop() as Ref, value);
				break;
			}

			case "swap": {
				const top = temps.pop();
				const below = temps.pop();

				temps.push(top, below);
				break;
			}
		}
	}
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	syntheticHandlers.pattern = patternFrame;
}
