/**
 * Operators: binary/logical/conditional expressions and the operator semantics tables.
 */
import type { NodeFrame } from "../frame.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { lookupPrivate, privateHas } from "./classes.ts";
import { assignmentExpression, compoundAssignment } from "./references.ts";
import { evaluating, on } from "./registry.ts";

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

/** Plain binary: both operands, then the operator. */
export const plainBinary = evaluating<ts.BinaryExpression>(
	(node) => [node.left, node.right],
	(vm, _frame, node, [left, right]) => { vm.push(applyBinary(node.operatorToken.kind, left as never, right as never)); }
);

function binaryExpression(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.BinaryExpression;
	const op = node.operatorToken.kind;

	// `#x in obj` — a brand check (the left side is a private name, not an expression).
	if (op === Kind.InKeyword && ts.isPrivateIdentifier(node.left)) {
		privateIn(vm, frame);

		return;
	}

	if (op === Kind.EqualsToken) {
		assignmentExpression(vm, frame, node);

		return;
	}

	if (ASSIGN.has(op)) {
		compoundAssignment(vm, frame, node, op);

		return;
	}

	if (LOGICAL.has(op)) {
		logicalExpression(vm, frame, node, op);

		return;
	}

	plainBinary(vm, frame);
}

export function logicalExpression(vm: Machine, frame: NodeFrame, node: ts.BinaryExpression, op: ts.SyntaxKind): void {
	if (frame.phase === 0) {
		vm.pushNode(node.left, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const left = vm.pop();
		let takeRight;

		if (op === Kind.AmpersandAmpersandToken) {
			takeRight = Boolean(left);
		} else if (op === Kind.BarBarToken) {
			takeRight = !left;
		} else {
			takeRight = left === null || left === undefined;
		}

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

function conditionalExpression(vm: Machine, frame: NodeFrame): void {
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
