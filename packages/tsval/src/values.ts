import type ts from "typescript";
import type { Scope } from "./scope.ts";

/**
 * A guest function (declared inside the interpreted program).
 *
 * It is represented as a real JS function so it can be stored, passed around, and — eventually —
 * invoked by host code (array callbacks, host-supplied functions). The `__tsval` brand carries the AST + closure scope
 * the VM needs to run it on its own explicit stack instead of the host stack (ASSIGNMENT §3, "Calls").
 *
 * CallExpression checks for the brand: branded → push a call frame (explicit stack, steppable, no
 * host-stack overflow); unbranded → it's a host function, call it directly.
 */
/** Any node with `parameters` + a body that the VM can invoke as a function. */
export type GuestFunctionNode =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

export interface GuestFunctionMeta {
	"node": GuestFunctionNode;
	"closure": Scope;
	"name": string;
	/** Arrow functions capture `this` lexically; they have no own `this`/`arguments`. */
	"isArrow": boolean;
	/** `function*` / `async function*` — invocation returns a generator (runs lazily). */
	"isGenerator": boolean;
	/** `async` — invocation returns a Promise, driven by `await` suspensions. */
	"isAsync": boolean;
	/** [[HomeObject]] — the object the method lives on, used to resolve `super.x` (class methods). */
	"homeObject"?: object;
	/** The function object itself (a generator's `.prototype` is read from it at each invocation). */
	"self"?: GuestFunction;
}

export interface GuestFunction {
	(...args: unknown[]): unknown;
	"__tsval": GuestFunctionMeta;
}

/** An OWN brand: a host Proxy that answers every key (an auto-stub) must not pass as guest code. */
export function isGuestFunction(value: unknown): value is GuestFunction {
	return typeof value === "function" && Object.hasOwn(value, "__tsval") && (value as Partial<GuestFunction>).__tsval != null;
}
