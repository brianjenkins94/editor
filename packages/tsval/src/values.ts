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
	return typeof value === "function" && Object.hasOwn(value, "__tsval") && (value as Partial<GuestFunction>).__tsval !== null && (value as Partial<GuestFunction>).__tsval !== undefined;
}

/**
 * What a value is at runtime, as runtime evidence tags it: `undefined`, `null`, `boolean`, `number`, `string`,
 * `bigint`, `symbol`, `function`, `array`, an object's class name (`Map`, `Player`), or `object` for a plain one (or one
 * whose class has no name). Reads only property descriptors, never properties, so no getter — the guest's or a host's —
 * runs; the one exception is a Proxy, whose `getPrototypeOf` trap still does.
 */
export function typeTag(value: unknown): string {
	if (value === null) {
		return "null";
	}

	const type = typeof value;

	if (type !== "object") {
		return type;
	}

	try {
		if (Array.isArray(value)) {
			return "array";
		}

		const prototype = Object.getPrototypeOf(value) as object | null;

		if (prototype === null) {
			return "object";
		}

		// A prototype's class doesn't change: read its name once (instrumented code tags every value it observes).
		let tag = tagsByPrototype.get(prototype);

		if (tag === undefined) {
			const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value as unknown;
			const name = typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name")?.value as unknown : undefined;

			tag = typeof name === "string" && name !== "" && name !== "Object" ? name : "object";
			tagsByPrototype.set(prototype, tag);
		}

		return tag;
	} catch {
		return "object"; // a revoked Proxy
	}
}

/** Each prototype's tag, once read. */
const tagsByPrototype = new WeakMap<object, string>();
