import ts from "typescript";
import { Scope } from "./scope.ts";
import type { Frame, Handler, VM } from "./vm.ts";
import type { GuestFunction, GuestFunctionMeta } from "./values.ts";
import { isGuestFunction } from "./values.ts";

const K = ts.SyntaxKind;

/** Per-SyntaxKind frame handlers. */
export const nodeHandlers: Record<number, Handler> = {};
/** Synthetic-frame handlers (frames with a `kind` tag rather than a 1:1 node). */
export const syntheticHandlers: Record<string, Handler> = {};

function on(kind: number, handler: Handler): void {
	nodeHandlers[kind] = handler;
}

// ============================================================================
// Hoisting
// ============================================================================

/**
 * Shallow hoist pass for a block/function/source scope: install `function` declarations (fully, with
 * value) and put `let`/`const` names into the TDZ. `var` names hoist to the function scope.
 *
 * NOTE (S1): `var` hoisting only scans the immediate statement list. Vars buried in nested blocks/
 * loops still need a recursive collector — added with loops in S2. Tracked in PROGRESS.md.
 */
function hoist(vm: VM, scope: Scope, statements: readonly ts.Statement[]): void {
	for (const statement of statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name) {
			scope.declareFunction(statement.name.text, createGuestFunction(vm, statement, scope));
		} else if (ts.isVariableStatement(statement)) {
			const flags = statement.declarationList.flags;
			const isLet = (flags & ts.NodeFlags.Let) !== 0;
			const isConst = (flags & ts.NodeFlags.Const) !== 0;
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					if (isConst) scope.declareLexical(decl.name.text, "const");
					else if (isLet) scope.declareLexical(decl.name.text, "let");
					else scope.declareVar(decl.name.text);
				}
				// destructuring binding names: S2
			}
		}
	}
}

// ============================================================================
// Guest functions
// ============================================================================

export function createGuestFunction(
	vm: VM,
	node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
	closure: Scope,
): GuestFunction {
	const meta: GuestFunctionMeta = {
		node,
		closure,
		name: node.name && ts.isIdentifier(node.name) ? node.name.text : "",
		isArrow: node.kind === K.ArrowFunction,
	};
	const fn = function (this: unknown, ...args: unknown[]): unknown {
		// Host-invoked path (array callbacks, shims): run a nested loop to completion.
		return vm.callGuestFromHost(meta, this, args);
	} as GuestFunction;
	fn.__tsval = meta;
	Object.defineProperty(fn, "length", { value: node.parameters.length, configurable: true });
	if (meta.name) Object.defineProperty(fn, "name", { value: meta.name, configurable: true });
	return fn;
}

// ============================================================================
// Program / statements
// ============================================================================

on(K.SourceFile, (vm, frame) => {
	const node = frame.node as ts.SourceFile;
	if (frame.phase === 0) {
		hoist(vm, frame.scope, node.statements);
		pushStatementsReverse(vm, node.statements, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

on(K.Block, (vm, frame) => {
	const node = frame.node as ts.Block;
	if (frame.phase === 0) {
		// A function-body Block runs directly in the function scope (params + body share it); a plain
		// Block gets a fresh child scope. `frame.reuseScope` is set by the call handler.
		const blockScope = frame.reuseScope ? frame.scope : new Scope(frame.scope, false);
		if (!frame.reuseScope) hoist(vm, blockScope, node.statements);
		pushStatementsReverse(vm, node.statements, blockScope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

function pushStatementsReverse(vm: VM, statements: readonly ts.Statement[], scope: Scope): void {
	for (let i = statements.length - 1; i >= 0; i--) {
		vm.pushNode(statements[i], scope);
	}
}

on(K.EmptyStatement, (vm) => {
	vm.frames.pop();
});

on(K.VariableStatement, (vm, frame) => {
	const node = frame.node as ts.VariableStatement;
	execDeclarationList(vm, frame, node.declarationList);
});

// Shared driver for a VariableDeclarationList: evaluate each initializer in order, bind the name.
function execDeclarationList(vm: VM, frame: Frame, list: ts.VariableDeclarationList): void {
	const decls = list.declarations;
	const flags = list.flags;
	const isLexical = (flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;

	// phase encodes "which declaration are we on": phase 2*i => start decl i; phase 2*i+1 => bind decl i.
	const i = frame.phase >> 1;
	if (i >= decls.length) {
		vm.frames.pop();
		return;
	}
	const decl = decls[i];
	const name = ts.isIdentifier(decl.name) ? decl.name.text : undefined;
	if (name === undefined) throw new Error(`unimplemented: destructuring binding in VariableDeclaration`);

	if ((frame.phase & 1) === 0) {
		if (decl.initializer) {
			vm.pushNode(decl.initializer, frame.scope);
			frame.phase++; // -> bind
		} else {
			// no initializer: `let x;` stays undefined but leaves the TDZ; `var x;` already undefined.
			if (isLexical) frame.scope.initialize(name, undefined);
			frame.phase += 2; // -> next decl
		}
	} else {
		const value = vm.pop();
		if (isLexical) frame.scope.initialize(name, value);
		else frame.scope.set(name, value);
		frame.phase++; // -> next decl (now even)
	}
}

on(K.ExpressionStatement, (vm, frame) => {
	const node = frame.node as ts.ExpressionStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.completion = vm.pop(); // REPL/eval completion value
		vm.frames.pop();
	}
});

on(K.IfStatement, (vm, frame) => {
	const node = frame.node as ts.IfStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const cond = vm.pop();
		if (cond) vm.pushNode(node.thenStatement, frame.scope);
		else if (node.elseStatement) vm.pushNode(node.elseStatement, frame.scope);
		frame.phase = 2;
	} else {
		vm.frames.pop();
	}
});

on(K.ReturnStatement, (vm, frame) => {
	const node = frame.node as ts.ReturnStatement;
	if (frame.phase === 0 && node.expression) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const value = node.expression ? vm.pop() : undefined;
		vm.frames.pop();
		vm.raise({ type: "return", value });
	}
});

on(K.ThrowStatement, (vm, frame) => {
	const node = frame.node as ts.ThrowStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const value = vm.pop();
		vm.frames.pop();
		vm.raise({ type: "throw", value });
	}
});

// A hoisted function declaration is a no-op at execution time (created during hoist).
on(K.FunctionDeclaration, (vm) => {
	vm.frames.pop();
});

// ============================================================================
// Literals & simple expressions
// ============================================================================

on(K.NumericLiteral, (vm, frame) => {
	const node = frame.node as ts.NumericLiteral;
	vm.frames.pop();
	vm.push(Number(node.text.replace(/_/g, "")));
});

on(K.BigIntLiteral, (vm, frame) => {
	const node = frame.node as ts.BigIntLiteral;
	vm.frames.pop();
	vm.push(BigInt(node.text.replace(/_/g, "").replace(/n$/, "")));
});

const pushText: Handler = (vm, frame) => {
	vm.frames.pop();
	vm.push((frame.node as ts.LiteralLikeNode).text);
};
on(K.StringLiteral, pushText);
on(K.NoSubstitutionTemplateLiteral, pushText);

on(K.TrueKeyword, (vm) => {
	vm.frames.pop();
	vm.push(true);
});
on(K.FalseKeyword, (vm) => {
	vm.frames.pop();
	vm.push(false);
});
on(K.NullKeyword, (vm) => {
	vm.frames.pop();
	vm.push(null);
});

on(K.RegularExpressionLiteral, (vm, frame) => {
	const node = frame.node as ts.RegularExpressionLiteral;
	vm.frames.pop();
	const lastSlash = node.text.lastIndexOf("/");
	vm.push(new RegExp(node.text.slice(1, lastSlash), node.text.slice(lastSlash + 1)));
});

on(K.Identifier, (vm, frame) => {
	const node = frame.node as ts.Identifier;
	vm.frames.pop();
	vm.push(frame.scope.get(node.text));
});

on(K.ThisKeyword, (vm, frame) => {
	vm.frames.pop();
	vm.push(frame.scope.getThis());
});

// Type-only wrappers: evaluate the inner expression, ignore the type.
const passThroughExpr: Handler = (vm, frame) => {
	const node = frame.node as ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop(); // inner value already on the stack
	}
};
on(K.ParenthesizedExpression, passThroughExpr);
on(K.AsExpression, passThroughExpr);
on(K.TypeAssertionExpression, passThroughExpr);
on(K.NonNullExpression, passThroughExpr);
on(K.SatisfiesExpression, passThroughExpr);

// ============================================================================
// Templates, arrays, objects
// ============================================================================

on(K.TemplateExpression, (vm, frame) => {
	const node = frame.node as ts.TemplateExpression;
	if (frame.phase === 0) {
		for (let i = node.templateSpans.length - 1; i >= 0; i--) {
			vm.pushNode(node.templateSpans[i].expression, frame.scope);
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.valuesBase);
		let out = node.head.text;
		for (let i = 0; i < node.templateSpans.length; i++) {
			out += String(values[i]) + node.templateSpans[i].literal.text;
		}
		vm.frames.pop();
		vm.push(out);
	}
});

on(K.ArrayLiteralExpression, (vm, frame) => {
	const node = frame.node as ts.ArrayLiteralExpression;
	if (frame.phase === 0) {
		for (let i = node.elements.length - 1; i >= 0; i--) {
			const el = node.elements[i];
			if (ts.isSpreadElement(el)) throw new Error(`unimplemented: spread element in ArrayLiteral`);
			vm.pushNode(el, frame.scope);
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.valuesBase);
		vm.frames.pop();
		vm.push(values);
	}
});

on(K.ObjectLiteralExpression, (vm, frame) => {
	const node = frame.node as ts.ObjectLiteralExpression;
	if (frame.phase === 0) {
		// Evaluate property value expressions in reverse; shorthand resolves to an identifier read.
		for (let i = node.properties.length - 1; i >= 0; i--) {
			const prop = node.properties[i];
			if (ts.isPropertyAssignment(prop)) {
				vm.pushNode(prop.initializer, frame.scope);
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				vm.pushNode(prop.name, frame.scope);
			} else {
				throw new Error(`unimplemented: ${ts.SyntaxKind[prop.kind]} in ObjectLiteral`);
			}
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.valuesBase);
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < node.properties.length; i++) {
			const prop = node.properties[i] as ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
			const key = propertyName(prop.name);
			obj[key] = values[i];
		}
		vm.frames.pop();
		vm.push(obj);
	}
});

function propertyName(name: ts.PropertyName | ts.Identifier): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	throw new Error(`unimplemented: computed/other property name (${ts.SyntaxKind[name.kind]})`);
}

// ============================================================================
// Member access
// ============================================================================

on(K.PropertyAccessExpression, (vm, frame) => {
	const node = frame.node as ts.PropertyAccessExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) {
			if (node.questionDotToken) return vm.push(undefined);
			throw new TypeError(`Cannot read properties of ${obj} (reading '${node.name.text}')`);
		}
		vm.push((obj as Record<string, unknown>)[node.name.text]);
	}
});

on(K.ElementAccessExpression, (vm, frame) => {
	const node = frame.node as ts.ElementAccessExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.argumentExpression, frame.scope);
		frame.phase = 2;
	} else {
		const index = vm.pop();
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) {
			if (node.questionDotToken) return vm.push(undefined);
			throw new TypeError(`Cannot read properties of ${obj} (reading '${String(index)}')`);
		}
		vm.push((obj as Record<PropertyKey, unknown>)[index as PropertyKey]);
	}
});

// ============================================================================
// Unary
// ============================================================================

on(K.PrefixUnaryExpression, (vm, frame) => {
	const node = frame.node as ts.PrefixUnaryExpression;
	// ++/-- need an lvalue, handled without a normal operand eval.
	if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) {
		return updateExpression(vm, frame, node.operand, node.operator, /* prefix */ true);
	}
	if (frame.phase === 0) {
		vm.pushNode(node.operand, frame.scope);
		frame.phase = 1;
		return;
	}
	const v = vm.pop() as never;
	vm.frames.pop();
	switch (node.operator) {
		case K.PlusToken:
			return vm.push(+v);
		case K.MinusToken:
			return vm.push(-v);
		case K.TildeToken:
			return vm.push(~v);
		case K.ExclamationToken:
			return vm.push(!v);
		default:
			throw new Error(`unimplemented: prefix operator ${ts.SyntaxKind[node.operator]}`);
	}
});

on(K.PostfixUnaryExpression, (vm, frame) => {
	const node = frame.node as ts.PostfixUnaryExpression;
	return updateExpression(vm, frame, node.operand, node.operator, /* prefix */ false);
});

// ++/-- on a simple identifier lvalue (member lvalues: S2).
function updateExpression(vm: VM, frame: Frame, operand: ts.Expression, operator: ts.SyntaxKind, prefix: boolean): void {
	if (!ts.isIdentifier(operand)) throw new Error(`unimplemented: ++/-- on non-identifier`);
	vm.frames.pop();
	const name = operand.text;
	const old = Number(frame.scope.get(name));
	const next = operator === K.PlusPlusToken ? old + 1 : old - 1;
	frame.scope.set(name, next);
	vm.push(prefix ? next : old);
}

on(K.TypeOfExpression, (vm, frame) => {
	const node = frame.node as ts.TypeOfExpression;
	if (frame.phase === 0) {
		// `typeof undeclaredVar` must not throw; guard identifier reads.
		if (ts.isIdentifier(node.expression) && !frame.scope.has(node.expression.text)) {
			vm.frames.pop();
			return vm.push("undefined");
		}
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const v = vm.pop();
		vm.frames.pop();
		vm.push(typeof v);
	}
});

on(K.VoidExpression, (vm, frame) => {
	const node = frame.node as ts.VoidExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.pop();
		vm.frames.pop();
		vm.push(undefined);
	}
});

// ============================================================================
// Binary & conditional
// ============================================================================

const LOGICAL = new Set<number>([K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken]);
const ASSIGN = new Set<number>([
	K.EqualsToken,
	K.PlusEqualsToken,
	K.MinusEqualsToken,
	K.AsteriskEqualsToken,
	K.SlashEqualsToken,
	K.PercentEqualsToken,
	K.AsteriskAsteriskEqualsToken,
	K.AmpersandEqualsToken,
	K.BarEqualsToken,
	K.CaretEqualsToken,
	K.LessThanLessThanEqualsToken,
	K.GreaterThanGreaterThanEqualsToken,
	K.GreaterThanGreaterThanGreaterThanEqualsToken,
	K.AmpersandAmpersandEqualsToken,
	K.BarBarEqualsToken,
	K.QuestionQuestionEqualsToken,
]);

on(K.BinaryExpression, (vm, frame) => {
	const node = frame.node as ts.BinaryExpression;
	const op = node.operatorToken.kind;

	if (op === K.EqualsToken) return assignmentExpression(vm, frame, node);
	if (ASSIGN.has(op)) return compoundAssignment(vm, frame, node, op);
	if (LOGICAL.has(op)) return logicalExpression(vm, frame, node, op);

	// Plain binary: evaluate both operands, then combine.
	if (frame.phase === 0) {
		vm.pushNode(node.left, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 2;
	} else {
		const right = vm.pop() as never;
		const left = vm.pop() as never;
		vm.frames.pop();
		vm.push(applyBinary(op, left, right));
	}
});

function logicalExpression(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
	if (frame.phase === 0) {
		vm.pushNode(node.left, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const left = vm.pop();
		const takeRight = op === K.AmpersandAmpersandToken ? Boolean(left) : op === K.BarBarToken ? !left : left == null;
		if (takeRight) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 2;
		} else {
			vm.frames.pop();
			vm.push(left);
		}
	} else {
		const right = vm.pop();
		vm.frames.pop();
		vm.push(right);
	}
}

function assignmentExpression(vm: VM, frame: Frame, node: ts.BinaryExpression): void {
	// Simple identifier / member lvalues (destructuring assignment targets: S2).
	if (ts.isIdentifier(node.left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const value = vm.pop();
			frame.scope.set((node.left as ts.Identifier).text, value);
			vm.frames.pop();
			vm.push(value);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
		return memberAssignment(vm, frame, node);
	}
	throw new Error(`unimplemented: assignment target ${ts.SyntaxKind[node.left.kind]}`);
}

function memberAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression): void {
	const target = node.left as ts.PropertyAccessExpression | ts.ElementAccessExpression;
	const isElement = ts.isElementAccessExpression(target);
	if (frame.phase === 0) {
		vm.pushNode(target.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 && isElement) {
		vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 1 || frame.phase === 2) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 3;
	} else {
		const value = vm.pop();
		const key = isElement ? (vm.pop() as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.pop() as Record<PropertyKey, unknown>;
		frame.scope; // (obj mutated in place)
		obj[key] = value;
		vm.frames.pop();
		vm.push(value);
	}
}

function compoundAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
	// Identifier lvalue only for S1 (member compound assignment: S2).
	if (!ts.isIdentifier(node.left)) throw new Error(`unimplemented: compound assignment to ${ts.SyntaxKind[node.left.kind]}`);
	const name = node.left.text;
	if (frame.phase === 0) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 1;
	} else {
		const right = vm.pop() as never;
		const current = frame.scope.get(name) as never;
		const result = applyCompound(op, current, right);
		frame.scope.set(name, result);
		vm.frames.pop();
		vm.push(result);
	}
}

on(K.ConditionalExpression, (vm, frame) => {
	const node = frame.node as ts.ConditionalExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.condition, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const cond = vm.pop();
		vm.pushNode(cond ? node.whenTrue : node.whenFalse, frame.scope);
		frame.phase = 2;
	} else {
		vm.frames.pop(); // branch value already on the stack
	}
});

// ============================================================================
// Function expressions
// ============================================================================

const makeFunction: Handler = (vm, frame) => {
	const node = frame.node as ts.FunctionExpression | ts.ArrowFunction;
	vm.frames.pop();
	vm.push(createGuestFunction(vm, node, frame.scope));
};
on(K.FunctionExpression, makeFunction);
on(K.ArrowFunction, makeFunction);

// ============================================================================
// Calls
// ============================================================================

on(K.CallExpression, (vm, frame) => {
	const node = frame.node as ts.CallExpression;
	const callee = node.expression;
	const isMember = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee);

	if (frame.phase === 0) {
		// Evaluate the callee (its object first, for method calls, to capture `this`).
		vm.pushNode(isMember ? (callee as ts.PropertyAccessExpression).expression : callee, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (isMember) {
			const obj = vm.pop();
			frame.thisArg = obj;
			if (obj == null && node.questionDotToken) {
				vm.frames.pop();
				return vm.push(undefined);
			}
			const key = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
			// ElementAccess callee needs its index evaluated; defer to S2 unless it's a property access.
			if (key === undefined) throw new Error(`unimplemented: computed method call target`);
			vm.push((obj as Record<string, unknown>)[key]);
		} else {
			frame.thisArg = undefined;
		}
		// Evaluate arguments left-to-right (pushed in reverse), keeping callee value beneath them.
		for (let i = node.arguments.length - 1; i >= 0; i--) {
			const arg = node.arguments[i];
			if (ts.isSpreadElement(arg)) throw new Error(`unimplemented: spread argument`);
			vm.pushNode(arg, frame.scope);
		}
		frame.argCount = node.arguments.length;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const argCount = frame.argCount as number;
		const args = vm.values.splice(vm.values.length - argCount);
		const calleeVal = vm.pop();

		if (isGuestFunction(calleeVal)) {
			vm.pushCall(calleeVal.__tsval, args, frame.thisArg);
			frame.phase = 3; // resume after the call returns its value
			return;
		}
		vm.frames.pop();
		if (typeof calleeVal !== "function") {
			if (node.questionDotToken && calleeVal == null) return vm.push(undefined);
			throw new TypeError(`${describe(node.expression)} is not a function`);
		}
		vm.push((calleeVal as (...a: unknown[]) => unknown).apply(frame.thisArg, args));
	} else {
		// phase 3: guest call has left its return value on the stack.
		vm.frames.pop();
	}
});

// NewExpression: construct with evaluated args.
on(K.NewExpression, (vm, frame) => {
	const node = frame.node as ts.NewExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const args = node.arguments ?? [];
		for (let i = args.length - 1; i >= 0; i--) {
			if (ts.isSpreadElement(args[i])) throw new Error(`unimplemented: spread argument in new`);
			vm.pushNode(args[i], frame.scope);
		}
		frame.argCount = args.length;
		frame.phase = 2;
	} else {
		const argCount = frame.argCount as number;
		const args = vm.values.splice(vm.values.length - argCount);
		const ctor = vm.pop();
		vm.frames.pop();
		if (typeof ctor !== "function") throw new TypeError(`${describe(node.expression)} is not a constructor`);
		// Guest classes: S2. Host constructors work directly.
		vm.push(Reflect.construct(ctor as new (...a: unknown[]) => unknown, args));
	}
});

// Synthetic call frame: run a guest function on the explicit stack.
syntheticHandlers.call = (vm, frame) => {
	const meta = frame.meta as GuestFunctionMeta;
	const node = meta.node;
	if (frame.phase === 0) {
		const fnScope = new Scope(meta.closure, /* isolated */ true);
		if (!meta.isArrow) {
			fnScope.hasThis = true;
			fnScope.thisVal = frame.thisArg;
			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", frame.args as unknown[]);
		}
		bindParameters(fnScope, node.parameters, frame.args as unknown[]);
		frame.scope = fnScope;

		if (ts.isBlock(node.body!)) {
			hoist(vm, fnScope, node.body.statements);
			// Reuse the function scope for the body block (params + body vars share it).
			const bodyFrame = vm.pushNode(node.body, fnScope);
			bodyFrame.reuseScope = true;
			frame.phase = 1;
		} else {
			// Arrow with an expression body: value is the return value.
			vm.pushNode(node.body!, fnScope);
			frame.phase = 2;
		}
	} else if (frame.phase === 1) {
		// Body completed with no explicit return.
		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(undefined);
	} else {
		// Arrow expression-body value is on the stack; it is the return value.
		const value = vm.pop();
		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(value);
	}
};

function bindParameters(scope: Scope, params: readonly ts.ParameterDeclaration[], args: unknown[]): void {
	for (let i = 0; i < params.length; i++) {
		const param = params[i];
		if (param.dotDotDotToken) {
			if (!ts.isIdentifier(param.name)) throw new Error(`unimplemented: rest param destructuring`);
			scope.declareLexical(param.name.text, "param");
			scope.initialize(param.name.text, args.slice(i));
			return;
		}
		if (!ts.isIdentifier(param.name)) throw new Error(`unimplemented: destructuring parameter`);
		scope.declareLexical(param.name.text, "param");
		// Default parameter values (param.initializer) are evaluated eagerly here as a host-side
		// fallback for `undefined`; full stepped default-init is S2.
		let value = args[i];
		if (value === undefined && param.initializer) {
			throw new Error(`unimplemented: default parameter value`);
		}
		scope.initialize(param.name.text, value);
	}
}

// ============================================================================
// Operator semantics
// ============================================================================

function applyBinary(op: number, left: never, right: never): unknown {
	switch (op) {
		case K.PlusToken:
			return (left as number) + (right as number);
		case K.MinusToken:
			return left - right;
		case K.AsteriskToken:
			return left * right;
		case K.SlashToken:
			return left / right;
		case K.PercentToken:
			return left % right;
		case K.AsteriskAsteriskToken:
			return left ** right;
		case K.AmpersandToken:
			return left & right;
		case K.BarToken:
			return left | right;
		case K.CaretToken:
			return left ^ right;
		case K.LessThanLessThanToken:
			return left << right;
		case K.GreaterThanGreaterThanToken:
			return left >> right;
		case K.GreaterThanGreaterThanGreaterThanToken:
			return left >>> right;
		case K.EqualsEqualsToken:
			// eslint-disable-next-line eqeqeq
			return left == right;
		case K.ExclamationEqualsToken:
			// eslint-disable-next-line eqeqeq
			return left != right;
		case K.EqualsEqualsEqualsToken:
			return left === right;
		case K.ExclamationEqualsEqualsToken:
			return left !== right;
		case K.LessThanToken:
			return left < right;
		case K.LessThanEqualsToken:
			return left <= right;
		case K.GreaterThanToken:
			return left > right;
		case K.GreaterThanEqualsToken:
			return left >= right;
		case K.InstanceOfKeyword:
			return (left as object) instanceof (right as CallableFunction);
		case K.InKeyword:
			return (left as PropertyKey) in (right as object);
		case K.CommaToken:
			return right;
		default:
			throw new Error(`unimplemented: binary operator ${ts.SyntaxKind[op]}`);
	}
}

function applyCompound(op: number, left: never, right: never): unknown {
	switch (op) {
		case K.PlusEqualsToken:
			return (left as number) + (right as number);
		case K.MinusEqualsToken:
			return left - right;
		case K.AsteriskEqualsToken:
			return left * right;
		case K.SlashEqualsToken:
			return left / right;
		case K.PercentEqualsToken:
			return left % right;
		case K.AsteriskAsteriskEqualsToken:
			return left ** right;
		case K.AmpersandEqualsToken:
			return left & right;
		case K.BarEqualsToken:
			return left | right;
		case K.CaretEqualsToken:
			return left ^ right;
		case K.LessThanLessThanEqualsToken:
			return left << right;
		case K.GreaterThanGreaterThanEqualsToken:
			return left >> right;
		case K.GreaterThanGreaterThanGreaterThanEqualsToken:
			return left >>> right;
		case K.AmpersandAmpersandEqualsToken:
			return left && right;
		case K.BarBarEqualsToken:
			return left || right;
		case K.QuestionQuestionEqualsToken:
			return left ?? right;
		default:
			throw new Error(`unimplemented: compound operator ${ts.SyntaxKind[op]}`);
	}
}

function describe(node: ts.Node): string {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return `${describe(node.expression)}.${node.name.text}`;
	return ts.SyntaxKind[node.kind];
}
