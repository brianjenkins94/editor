/**
 * Operators: binary/logical/conditional expressions and the operator semantics tables.
 */
import type { NodeFrame } from "../frame.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { lookupPrivate, privateHas } from "./classes.ts";
import type { Scope } from "../scope.ts";
import { stepBy, toNumeric } from "./realm.ts";
import { assignmentExpression, compoundAssignment } from "./references.ts";
import { evaluating, on } from "./registry.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions used here are read off it once.
const { isBinaryExpression, isIdentifier, isParenthesizedExpression, isPrefixUnaryExpression, isPrivateIdentifier } = ts;

const Kind = ts.SyntaxKind;

export const LOGICAL = new Set<number>([Kind.AmpersandAmpersandToken, Kind.BarBarToken, Kind.QuestionQuestionToken]);

export const ASSIGN = new Set<number>([
	Kind.EqualsToken,
	Kind.PlusEqualsToken,
	Kind.MinusEqualsToken,
	Kind.AsteriskEqualsToken,
	Kind.SlashEqualsToken,
	Kind.PercentEqualsToken,
	Kind.AsteriskAsteriskEqualsToken,
	Kind.AmpersandEqualsToken,
	Kind.BarEqualsToken,
	Kind.CaretEqualsToken,
	Kind.LessThanLessThanEqualsToken,
	Kind.GreaterThanGreaterThanEqualsToken,
	Kind.GreaterThanGreaterThanGreaterThanEqualsToken,
	Kind.AmpersandAmpersandEqualsToken,
	Kind.BarBarEqualsToken,
	Kind.QuestionQuestionEqualsToken
]);

export const privateIn = evaluating<ts.BinaryExpression>(
	(node) => [node.right],
	(vm, frame, node, [obj]) => { vm.push(privateHas(obj, lookupPrivate(frame.scope, (node.left as ts.PrivateIdentifier).text))); }
);

/** Plain binary: both operands, then the operator. (`evaluating`'s shape, written out: the two operands are popped off
 *  the stack rather than spliced into an array — the most common expression there is.) */
export function plainBinary(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.BinaryExpression;

	if (frame.phase === 0) {
		frame.base = vm.values.length; // (as `evaluating` records it)
		frame.phase = 1;

		// (both leaves — `d * d`, `n % d` — their values are on the stack already: on in this step)
		if (!vm.pushOperands([node.left, node.right], frame.scope)) {
			return;
		}
	}

	const right = vm.values.pop();
	const left = vm.values.pop();

	vm.frames.pop();
	vm.push(applyBinary(node.operatorToken.kind, left as never, right as never));
}

/** Which of binaryExpression's forms an operator token takes, by kind (0: a plain binary). */
const BINARY_FORM = new Uint8Array(Kind.Count);
const ASSIGNMENT_FORM = 1;
const COMPOUND_FORM = 2;
const LOGICAL_FORM = 3;
const IN_FORM = 4;

for (const op of ASSIGN) {
	BINARY_FORM[op] = COMPOUND_FORM;
}

for (const op of LOGICAL) {
	BINARY_FORM[op] = LOGICAL_FORM;
}

BINARY_FORM[Kind.EqualsToken] = ASSIGNMENT_FORM;
BINARY_FORM[Kind.InKeyword] = IN_FORM;

function binaryExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.BinaryExpression;
	const op = node.operatorToken.kind;

	switch (BINARY_FORM[op]) {
		case ASSIGNMENT_FORM:
			assignmentExpression(vm, frame, node);

			return;
		case COMPOUND_FORM:
			compoundAssignment(vm, frame, node, op);

			return;
		case LOGICAL_FORM:
			logicalExpression(vm, frame, node, op);

			return;
		case IN_FORM:
			// `#x in obj` — a brand check (the left side is a private name, not an expression).
			if (isPrivateIdentifier(node.left)) {
				privateIn(vm, frame);

				return;
			}

			break;
		default:
			break;
	}

	plainBinary(vm, frame);
}

export function logicalExpression(vm: Machine, frame: NodeFrame, node: ts.BinaryExpression, op: ts.SyntaxKind): void {
	if (frame.phase === 0) {
		frame.phase = 1;

		if (!vm.pushOperand(node.left, frame.scope)) {
			return;
		}
	}

	if (frame.phase === 1) {
		const left = vm.pop();
		let takeRight;

		if (op === Kind.AmpersandAmpersandToken) {
			takeRight = Boolean(left);
		} else if (op === Kind.BarBarToken) {
			takeRight = !left;
		} else {
			takeRight = left === null || left === undefined;
		}

		if (vm.observe !== undefined) {
			if (op === Kind.QuestionQuestionToken) {
				vm.observe(node, "nullish", left);
			} else {
				vm.observe(node, "branch", takeRight ? 0 : 1);
			}
		}

		if (takeRight) {
			if (vm.pushOperand(node.right, frame.scope)) {
				vm.frames.pop(); // (its value, on the stack already, is the expression's)
			} else {
				frame.phase = 2;
			}
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

function conditionalExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ConditionalExpression;

	if (frame.phase === 0) {
		frame.phase = 1;

		if (!vm.pushOperand(node.condition, frame.scope)) {
			return;
		}
	}

	if (frame.phase === 1) {
		const cond = vm.pop();

		vm.observe?.(node, "branch", cond ? 0 : 1);

		if (vm.pushOperand(cond ? node.whenTrue : node.whenFalse, frame.scope)) {
			vm.frames.pop(); // (its value, on the stack already, is the expression's)
		} else {
			frame.phase = 2;
		}
	} else {
		vm.frames.pop(); // branch value already on the stack
	}
}

export function applyBinary(op: ts.SyntaxKind, left: never, right: never): unknown {
	switch (op) {
		case Kind.PlusToken:
			return (left as number) + (right as number);
		case Kind.MinusToken:
			return left - right;
		case Kind.AsteriskToken:
			return left * right;
		case Kind.SlashToken:
			return left / right;
		case Kind.PercentToken:
			return left % right;
		case Kind.AsteriskAsteriskToken:
			return left ** right;
		case Kind.AmpersandToken:
			return left & right;
		case Kind.BarToken:
			return left | right;
		case Kind.CaretToken:
			return left ^ right;
		case Kind.LessThanLessThanToken:
			return left << right;
		case Kind.GreaterThanGreaterThanToken:
			return left >> right;
		case Kind.GreaterThanGreaterThanGreaterThanToken:
			return left >>> right;
		case Kind.EqualsEqualsToken:
			// eslint-disable-next-line eqeqeq
			return left == right;
		case Kind.ExclamationEqualsToken:
			// eslint-disable-next-line eqeqeq
			return left != right;
		case Kind.EqualsEqualsEqualsToken:
			return left === right;
		case Kind.ExclamationEqualsEqualsToken:
			return left !== right;
		case Kind.LessThanToken:
			return left < right;
		case Kind.LessThanEqualsToken:
			return left <= right;
		case Kind.GreaterThanToken:
			return left > right;
		case Kind.GreaterThanEqualsToken:
			return left >= right;
		case Kind.InstanceOfKeyword:
			return (left as object) instanceof (right as CallableFunction);
		case Kind.InKeyword:
			return (left as PropertyKey) in (right as object);
		case Kind.CommaToken:
			return right;
		default:
			unimplemented(`binary operator ${ts.SyntaxKind[op]}`);
	}
}

export function applyCompound(op: ts.SyntaxKind, left: never, right: never): unknown {
	switch (op) {
		case Kind.PlusEqualsToken:
			return (left as number) + (right as number);
		case Kind.MinusEqualsToken:
			return left - right;
		case Kind.AsteriskEqualsToken:
			return left * right;
		case Kind.SlashEqualsToken:
			return left / right;
		case Kind.PercentEqualsToken:
			return left % right;
		case Kind.AsteriskAsteriskEqualsToken:
			return left ** right;
		case Kind.AmpersandEqualsToken:
			return left & right;
		case Kind.BarEqualsToken:
			return left | right;
		case Kind.CaretEqualsToken:
			return left ^ right;
		case Kind.LessThanLessThanEqualsToken:
			return left << right;
		case Kind.GreaterThanGreaterThanEqualsToken:
			return left >> right;
		case Kind.GreaterThanGreaterThanGreaterThanEqualsToken:
			return left >>> right;
		case Kind.AmpersandAmpersandEqualsToken:
			return left && right;
		case Kind.BarBarEqualsToken:
			return left || right;
		case Kind.QuestionQuestionEqualsToken:
			return left ?? right;
		default:
			unimplemented(`compound operator ${ts.SyntaxKind[op]}`);
	}
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(Kind.BinaryExpression, binaryExpression);
	on(Kind.ConditionalExpression, conditionalExpression);
}

// --- simple operands: evaluated whole in their parent's step (Machine.pushOperands) ----------------

/** The leaves, as a table by kind: the expressions whose evaluation only reads (a binding, the text) — no frame needed. */
const LEAVES = new Uint8Array(Kind.Count);

for (const kind of [Kind.Identifier, Kind.NumericLiteral, Kind.StringLiteral, Kind.NoSubstitutionTemplateLiteral, Kind.TrueKeyword, Kind.FalseKeyword, Kind.NullKeyword]) {
	LEAVES[kind] = 1;
}

/** The kinds a simple operand is built of above its leaves (isSimpleTree), as a table by kind. */
const BRANCHES = new Uint8Array(Kind.Count);

for (const kind of [Kind.ParenthesizedExpression, Kind.BinaryExpression, Kind.PrefixUnaryExpression, Kind.PostfixUnaryExpression]) {
	BRANCHES[kind] = 1;
}

/** The prefix operators that only convert their operand's value. */
const PLAIN_PREFIX = new Set<ts.SyntaxKind>([Kind.PlusToken, Kind.MinusToken, Kind.TildeToken, Kind.ExclamationToken]);

/** Each candidate's verdict (isSimpleTree), as found: the AST doesn't change. */
const simpleTrees = new WeakMap<ts.Node, boolean>();

/**
 * A simple operand: leaves under plain operators — `d * d <= n`, `-(a + 1)`, `n % d === 0` — and an assignment to a name
 * of one (`count += 1`, `x = y * 2`, `i++`); nothing that branches (`&&`, `?:`: their sides are observed as branches),
 * calls, or assigns through a member. Its parent evaluates it whole in its own step, left to right, as its frames would
 * have: a plain operator's conversions (`valueOf`) ran inside one step already.
 */
export function isSimpleTree(node: ts.Node): boolean {
	if (LEAVES[node.kind] === 1) {
		return true;
	}

	if (BRANCHES[node.kind] !== 1) {
		return false;
	}

	let simple = simpleTrees.get(node);

	if (simple === undefined) {
		simple = isSimpleBranch(node);
		simpleTrees.set(node, simple);
	}

	return simple;
}

function isSimpleBranch(node: ts.Node): boolean {
	if (isParenthesizedExpression(node)) {
		return isSimpleTree(node.expression);
	}

	if (isBinaryExpression(node)) {
		const op = node.operatorToken.kind;

		// (an assignment: to a bare name — `(x) = …` and members keep their frames — and not `&&=`/`||=`/`??=`, which branch)
		if (BINARY_FORM[op] === ASSIGNMENT_FORM || BINARY_FORM[op] === COMPOUND_FORM) {
			return isIdentifier(node.left) && !LOGICAL_ASSIGN.has(op) && isSimpleTree(node.right);
		}

		return BINARY_FORM[op] === 0 && isSimpleTree(node.left) && isSimpleTree(node.right);
	}

	if (isPrefixUnaryExpression(node)) {
		return PLAIN_PREFIX.has(node.operator) ? isSimpleTree(node.operand) : isIdentifier(node.operand); // (or `++x`/`--x`)
	}

	return isIdentifier((node as ts.PostfixUnaryExpression).operand); // `x++`/`x--`
}

const LOGICAL_ASSIGN = new Set<ts.SyntaxKind>([Kind.AmpersandAmpersandEqualsToken, Kind.BarBarEqualsToken, Kind.QuestionQuestionEqualsToken]);

/**
 * A simple operand's value (isSimpleTree), evaluated in `scope`: its leaves left to right, each operator on its operands'
 * values, each assignment stored and traced — what its frames would have done, in the same order (an assignment reads its
 * name, for `+=`, before its right side; assignThrough's order).
 */
export function simpleValue(vm: Machine, node: ts.Node, scope: Scope): unknown {
	switch (node.kind) {
		case Kind.ParenthesizedExpression:
			return simpleValue(vm, (node as ts.ParenthesizedExpression).expression, scope);
		case Kind.BinaryExpression: {
			const { left, operatorToken: { kind: op }, right } = node as ts.BinaryExpression;

			if (BINARY_FORM[op] === 0) {
				const leftValue = simpleValue(vm, left, scope);

				return applyBinary(op, leftValue as never, simpleValue(vm, right, scope) as never);
			}

			const { text } = left as ts.Identifier;
			const value = op === Kind.EqualsToken ? simpleValue(vm, right, scope) : applyCompound(op, scope.get(text) as never, simpleValue(vm, right, scope) as never);

			return assigned(vm, node, scope, text, value, value);
		}
		case Kind.PrefixUnaryExpression: {
			const { operator, operand } = node as ts.PrefixUnaryExpression;

			if (!PLAIN_PREFIX.has(operator)) {
				const next = stepBy(toNumeric(scope.get((operand as ts.Identifier).text)), operator === Kind.PlusPlusToken ? 1 : -1);

				return assigned(vm, node, scope, (operand as ts.Identifier).text, next, next);
			}

			const value = simpleValue(vm, operand, scope) as never;

			return operator === Kind.PlusToken ? +value : operator === Kind.MinusToken ? -value : operator === Kind.TildeToken ? ~value : !value;
		}
		case Kind.PostfixUnaryExpression: {
			const { operator, operand } = node as ts.PostfixUnaryExpression;
			const old = toNumeric(scope.get((operand as ts.Identifier).text));

			return assigned(vm, node, scope, (operand as ts.Identifier).text, stepBy(old, operator === Kind.PlusPlusToken ? 1 : -1), old);
		}
		default:
			return vm.leafValue(node, scope);
	}
}

/** An assignment of a simple operand, as assignThrough makes it: stored, traced, its result. */
function assigned(vm: Machine, node: ts.Node, scope: Scope, name: string, value: unknown, result: unknown): unknown {
	scope.set(name, value);

	if (vm.trace !== undefined) {
		vm.traced("bind", node, name, value);
	}

	return result;
}
