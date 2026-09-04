import type ts from "typescript";
import type { Scope } from "./scope.ts";

/**
 * A guest function (declared inside the interpreted program).
 *
 * It is represented as a real JS function so it can be stored, passed around, and — eventually —
 * invoked by host code (array callbacks, shims). The `__tsval` brand carries the AST + closure scope
 * the VM needs to run it on its own explicit stack instead of the host stack (ASSIGNMENT §3, "Calls").
 *
 * CallExpression checks for the brand: branded → push a call frame (explicit stack, steppable, no
 * host-stack overflow); unbranded → it's a host function, call it directly.
 */
export interface GuestFunctionMeta {
	node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
	closure: Scope;
	name: string;
	/** Arrow functions capture `this` lexically; they have no own `this`/`arguments`. */
	isArrow: boolean;
}

export interface GuestFunction {
	(...args: unknown[]): unknown;
	__tsval: GuestFunctionMeta;
}

export function isGuestFunction(value: unknown): value is GuestFunction {
	return typeof value === "function" && (value as Partial<GuestFunction>).__tsval != null;
}
