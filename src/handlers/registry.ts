/**
 * The handler registry: the per-SyntaxKind and synthetic-frame tables, `on()`, the declarative `evaluating` shape, and the shared trivial handlers. Imports nothing from the other handler modules, so it is always evaluated first (they register into it at load).
 */
import ts from "typescript";
import type { NodeFrame } from "../frame.ts";
import type { NodeHandler, SyntheticHandlers, VM } from "../vm.ts";

/** Per-SyntaxKind frame handlers. */
export const nodeHandlers: Record<number, NodeHandler> = {};

/** Synthetic-frame handlers (frames with a `kind` tag rather than a 1:1 node). */
export const syntheticHandlers = {} as SyntheticHandlers;

export function on(kind: number, handler: NodeHandler): void {
	nodeHandlers[kind] = handler;
}

/**
 * The common handler shape — "evaluate these children, in order, then combine": phase 0 pushes the
 * child frames (reversed, so the first evaluates first) and records the operand depth; phase 1
 * collects their values (one per child, in order) and hands them to `combine`, which pushes the
 * result or raises a signal. The numeric-phase form is reserved for handlers whose control flow
 * depends on intermediate values (branches, loops, try, calls, references, suspension points).
 */
export function evaluating<N extends ts.Node>(children: (node: N) => readonly ts.Node[], combine: (vm: VM, frame: NodeFrame, node: N, values: unknown[]) => void): NodeHandler {
	return (vm, frame) => {
		const node = frame.node as N;
		if (frame.phase === 0) {
			frame.base = vm.values.length; // depth *now* — earlier siblings are already on the stack
			const nodes = children(node);
			for (let i = nodes.length - 1; i >= 0; i--) vm.pushNode(nodes[i], frame.scope);
			frame.phase = 1;
			return;
		}
		const values = vm.values.splice(frame.base as number);
		vm.frames.pop();
		combine(vm, frame, node, values);
	};
}

// Type-only / erased declarations — no runtime effect (the checker uses them; the VM skips them).
export function noop(vm: VM): void {
	vm.frames.pop();
}

export function pushText(vm: VM, frame: NodeFrame): void {
	vm.frames.pop();
	vm.push((frame.node as ts.LiteralLikeNode).text);
}

// Type-only wrappers: evaluate the inner expression, ignore the type.
export function passThroughExpr(vm: VM, frame: NodeFrame): void {
	const node = frame.node as ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop(); // inner value already on the stack
	}
}
