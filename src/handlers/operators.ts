/**
 * Operators: binary/logical/conditional expressions and the operator semantics tables.
 */
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import type { NodeFrame } from "../frame.ts";
import type { VM } from "../vm.ts";
import { lookupPrivate, privateHas } from "./classes.ts";
import { assignmentExpression, compoundAssignment } from "./references.ts";
import { evaluating, on } from "./registry.ts";

const K = ts.SyntaxKind;

export const LOGICAL = new Set<number>([K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken]);

export const ASSIGN = new Set<number>([
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

	// `#x in obj` — a brand check (the left side is a private name, not an expression).
	if (op === K.InKeyword && ts.isPrivateIdentifier(node.left)) return privateIn(vm, frame);
	if (op === K.EqualsToken) return assignmentExpression(vm, frame, node);
	if (ASSIGN.has(op)) return compoundAssignment(vm, frame, node, op);
	if (LOGICAL.has(op)) return logicalExpression(vm, frame, node, op);
	plainBinary(vm, frame);
});

export const privateIn = evaluating<ts.BinaryExpression>(
	(node) => [node.right],
	(vm, frame, node, [obj]) => vm.push(privateHas(obj, lookupPrivate(frame.scope, (node.left as ts.PrivateIdentifier).text))),
);

/** Plain binary: both operands, then the operator. */
export const plainBinary = evaluating<ts.BinaryExpression>(
	(node) => [node.left, node.right],
	(vm, _frame, node, [left, right]) => vm.push(applyBinary(node.operatorToken.kind, left as never, right as never)),
);

export function logicalExpression(vm: VM, frame: NodeFrame, node: ts.BinaryExpression, op: number): void {
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

export function applyBinary(op: number, left: never, right: never): unknown {
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
			unimplemented(`binary operator ${ts.SyntaxKind[op]}`);
	}
}

export function applyCompound(op: number, left: never, right: never): unknown {
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
			unimplemented(`compound operator ${ts.SyntaxKind[op]}`);
	}
}
