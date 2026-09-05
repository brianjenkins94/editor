/**
 * The host↔guest boundary: property reads/writes on primitives box in the GUEST realm, CreateDataProperty, guest-realm arrays and `arguments`, ToPrimitive/ToPropertyKey/ToNumeric, error-message helpers that never invoke user code.
 */
import ts from "typescript";
import { Scope } from "../scope.ts";
import type { VM } from "../vm.ts";
import { propertyName } from "./literals.ts";
import { on } from "./registry.ts";

/** GetValue on a member reference. A primitive base is boxed in the GUEST realm (its
 *  `String.prototype`, not the host's — `"".constructor === String` must hold for the guest's
 *  `String`), with the primitive itself as the receiver for getters. Same-realm: a plain read. */
export function getProperty(vm: VM, obj: unknown, key: PropertyKey): unknown {
	if (vm.realm.Object !== Object && typeof obj !== "object" && typeof obj !== "function") return Reflect.get(vm.realm.Object(obj) as object, key, obj);
	return (obj as Record<PropertyKey, unknown>)[key];
}

/** PutValue on a member reference (strict): a primitive base finds a guest-realm setter or throws. */
export function setProperty(vm: VM, obj: unknown, key: PropertyKey, value: unknown): void {
	if (vm.realm.Object !== Object && typeof obj !== "object" && typeof obj !== "function") {
		if (!Reflect.set(vm.realm.Object(obj) as object, key, value, obj)) throw new TypeError(`Cannot create property '${keyText(key)}' on ${typeof obj} '${String(obj)}'`);
		return;
	}
	(obj as Record<PropertyKey, unknown>)[key] = value;
}

/** CreateDataProperty — an object literal *defines* properties; assignment would run inherited
 *  setters (notably `__proto__`, which a computed `["__proto__"]` key must not trigger). */
export function defineData(obj: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Describe a property key for an error message without invoking user code (`toString` may throw). */
export function keyText(key: unknown): string {
	if (typeof key === "symbol") return key.description ?? "Symbol()";
	if (typeof key === "string" || typeof key === "number" || typeof key === "boolean" || key == null) return String(key);
	return "<computed key>";
}

export function isObjectLike(v: unknown): v is object {
	return (typeof v === "object" && v !== null) || typeof v === "function";
}

/** A strict-mode `arguments` object: an array-like with the arguments as own indexed properties, a
 *  non-enumerable `length` and `@@iterator`, and a `callee` accessor that throws (strict). Unmapped —
 *  sloppy-mode parameter aliasing is out of scope. */
export function createArgumentsObject(vm: VM, args: unknown[]): object {
	const obj = new vm.realm.Object() as Record<PropertyKey, unknown>;
	for (let i = 0; i < args.length; i++) defineData(obj, i, args[i]); // CreateDataProperty (no inherited setters)
	Object.defineProperty(obj, "length", { value: args.length, writable: true, enumerable: false, configurable: true });
	Object.defineProperty(obj, Symbol.iterator, { value: vm.realm.Array.prototype.values, writable: true, enumerable: false, configurable: true });
	const thrower = (): never => {
		throw new TypeError("'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them");
	};
	Object.defineProperty(obj, "callee", { get: thrower, set: thrower, enumerable: false, configurable: false });
	return obj;
}

/** A guest-realm array holding `list`'s elements, copied by index — never through the iteration
 *  protocol, which guest code may have overridden (`Array.prototype[Symbol.iterator] = …`). */
export function realmArray(vm: VM, list: ArrayLike<unknown>): unknown[] {
	const out = new vm.realm.Array(list.length) as unknown[];
	for (let i = 0; i < list.length; i++) defineData(out, i, list[i]);
	return out;
}

/** CopyDataProperties for an object rest: own enumerable string and symbol keys not already bound. */
export function copyRestProperties(vm: VM, target: object, source: unknown, excluded: Set<PropertyKey>): void {
	const src = Object(source) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(src)) {
		if (excluded.has(key)) continue;
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) defineData(target, key, vm.fromHost(src[key]));
	}
}

/** ToPropertyKey: a symbol stays a symbol; anything else is its string form (`{[["a"]]: 1}` → "a"). */
/** ToPrimitive: `@@toPrimitive` (must return a primitive), else OrdinaryToPrimitive by hint. */
export function toPrimitive(v: unknown, hint: "string" | "number" | "default"): unknown {
	if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
	const exotic = (v as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive];
	if (exotic != null) {
		if (typeof exotic !== "function") throw new TypeError("Symbol.toPrimitive is not a function");
		const result = (exotic as (h: string) => unknown).call(v, hint);
		if (result === null || (typeof result !== "object" && typeof result !== "function")) return result;
		throw new TypeError("Cannot convert object to primitive value");
	}
	for (const name of hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"]) {
		const method = (v as Record<string, unknown>)[name];
		if (typeof method !== "function") continue;
		const result = (method as () => unknown).call(v);
		if (result === null || (typeof result !== "object" && typeof result !== "function")) return result;
	}
	throw new TypeError("Cannot convert object to primitive value");
}

/** ToNumeric: a BigInt stays a BigInt, everything else becomes a Number. */
export function toNumeric(v: unknown): number | bigint {
	const primitive = toPrimitive(v, "number");
	return typeof primitive === "bigint" ? primitive : Number(primitive);
}

/** `++`/`--` on a Number or a BigInt. */
export const stepBy = (old: number | bigint, delta: number): number | bigint => (typeof old === "bigint" ? old + BigInt(delta) : old + delta);

/** ToPropertyKey: ToPrimitive(hint string), then a symbol stays a symbol, anything else ToString. */
export const toPropertyKey = (v: unknown): PropertyKey => {
	const primitive = toPrimitive(v, "string");
	return typeof primitive === "symbol" ? primitive : String(primitive);
};

export function bindingKey(vm: VM, scope: Scope, name: ts.PropertyName): PropertyKey {
	if (ts.isComputedPropertyName(name)) return toPropertyKey(vm.evalNodeSync(name.expression, scope));
	return propertyName(name);
}

export function describe(node: ts.Node): string {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return `${describe(node.expression)}.${node.name.text}`;
	return ts.SyntaxKind[node.kind];
}
