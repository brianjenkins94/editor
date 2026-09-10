/**
 * Lexical scope for the VM.
 *
 * Written fresh (rather than vendoring sval's `Scope`, which isn't present in this tree and is
 * ESTree-oriented). Semantics mirror JS: `var` hoists to the nearest function scope; `let`/`const`
 * are block-scoped with a Temporal Dead Zone; `const` reassignment throws. Bindings are plain data
 * so scope graphs stay cloneable for snapshot/fork (ASSIGNMENT §3, S4).
 *
 * Each VM frame carries a reference to its scope, so "popping" a scope is automatic: when a block's
 * frames drain, nothing references its scope any more. This structurally eliminates DumbLang's
 * scope-restoration bug (ASSIGNMENT §6).
 */

import { TsvalInternalError } from "./errors.ts";
// (type-only: erased, so no runtime cycle with the handlers)
import type { ClassMeta, Construction } from "./handlers/classes.ts";
import type { GuestFunctionMeta } from "./values.ts";

export type BindingKind = "var" | "let" | "const" | "param" | "function";

export interface Binding {
	"value": unknown;
	"kind": BindingKind;
	/** false while in the Temporal Dead Zone (declared but not yet initialized). */
	"initialized": boolean;
}

export class Scope {
	public readonly parent: Scope | undefined;
	/** function scope (var target, `arguments`/`this` holder) vs. block scope. */
	public readonly isolated: boolean;
	public readonly bindings = new Map<string, Binding>();
	/** Only the root scope carries injected/host globals. */
	public globalObject: Record<string, unknown> | undefined;
	/** Only the root scope: fall back to the host's real `globalThis` for unresolved names. */
	public realGlobals = false;
	/** `this` binding for this scope (function scopes and the module root; not arrow functions). */
	public thisVal: unknown = undefined;
	public hasThis = false;
	/** [[HomeObject]] of the current method (for `super.x`); set on a method's function scope. */
	public homeObject?: object;
	/** metadata of the class whose constructor this scope belongs to (for `super(...)`). */
	public classMeta?: ClassMeta;
	/** `new.target` for the current function scope. */
	public newTarget?: unknown;
	/** the guest function this (function) scope belongs to — its flags tell `yield*`/`for await`
	 *  whether they're inside an async generator. */
	public functionMeta?: GuestFunctionMeta;
	/** the private names (`#x`) declared by the class whose body this scope is; resolved lexically,
	 *  nearest class first (so an inner class's `#x` shadows an outer one's). */
	public privateNames?: Map<string, object>;
	/** The construction in progress for the nearest constructor scope (see handlers/classes.ts). */
	public construction?: Construction;

	public constructor(parent?: Scope, isolated = false) {
		this.parent = parent;
		this.isolated = isolated;
	}

	/** The nearest enclosing function (isolated) scope — the target for `var` hoisting. */
	public functionScope(): Scope {
		if (this.isolated || !this.parent) {
			return this;
		}

		let current: Scope = this.parent;

		while (!current.isolated && current.parent) {
			current = current.parent;
		}

		return current;
	}

	public root(): Scope {
		if (!this.parent) {
			return this;
		}

		let current: Scope = this.parent;

		while (current.parent) {
			current = current.parent;
		}

		return current;
	}

	/** Resolve `this`: nearest enclosing scope that owns a `this` binding (arrows are transparent). */
	public getThis(): unknown {
		if (this.hasThis) {
			return this.thisVal;
		}

		let current: Scope | undefined = this.parent;

		while (current) {
			if (current.hasThis) {
				return current.thisVal;
			}

			current = current.parent;
		}

		return undefined;
	}

	public getHomeObject(): object | undefined {
		return this.findUp("homeObject");
	}

	public getClassMeta(): ClassMeta | undefined {
		return this.findUp("classMeta");
	}

	public getConstruction(): Construction | undefined {
		return this.findUp("construction");
	}

	public getNewTarget(): unknown {
		return this.findUp("newTarget");
	}

	/** Declare a `var`: hoisted to the function scope, defined but initialized to `undefined`. */
	public declareVar(name: string): void {
		const fs = this.functionScope();

		if (!fs.bindings.has(name)) {
			fs.bindings.set(name, { "value": undefined, "kind": "var", "initialized": true });
		}
	}

	/** Declare a hoisted `function` binding. Strict-mode semantics: hoisted to the top of the scope it
	 *  appears in — a declaration inside a block is block-scoped, not lifted to the function (that
	 *  lifting is sloppy-mode web-compat behavior, out of scope). */
	public declareFunction(name: string, value: unknown): void {
		this.bindings.set(name, { "value": value, "kind": "function", "initialized": true });
	}

	/** Declare a block-scoped `let`/`const`/`param`; enters the TDZ until `initialize`. */
	public declareLexical(name: string, kind: BindingKind): void {
		this.bindings.set(name, { "value": undefined, "kind": kind, "initialized": kind === "param" });
	}

	/** Provide the value for a previously-declared binding, leaving the TDZ. */
	public initialize(name: string, value: unknown): void {
		const binding = this.bindings.get(name);

		if (!binding) {
			throw new TsvalInternalError(`invariant: initialize of undeclared '${name}'`);
		}

		binding.value = value;
		binding.initialized = true;
	}

	public has(name: string): boolean {
		if (this.lookup(name)) {
			return true;
		}

		const root = this.root();

		if (root.globalObject !== null && root.globalObject !== undefined && name in root.globalObject) {
			return true;
		}

		return root.realGlobals && name in globalThis;
	}

	public get(name: string): unknown {
		const binding = this.lookup(name);

		if (binding) {
			if (!binding.initialized) {
				throw new ReferenceError(`Cannot access '${name}' before initialization`);
			}

			return binding.value;
		}

		const root = this.root();
		const globals = root.globalObject;

		if (globals !== null && globals !== undefined && name in globals) {
			return globals[name];
		}

		if (root.realGlobals && name in globalThis) {
			return (globalThis as Record<string, unknown>)[name];
		}

		throw new ReferenceError(`${name} is not defined`);
	}

	/**
	 * Assignment to an existing binding or an existing global. Strict-mode semantics: assigning to an
	 * undeclared name is a ReferenceError (sloppy mode's implicit-global creation is out of scope), and
	 * the non-writable globals `undefined`/`NaN`/`Infinity` throw a TypeError.
	 */
	public set(name: string, value: unknown): void {
		const binding = this.lookup(name);

		if (binding) {
			if (binding.kind === "const" && binding.initialized) {
				throw new TypeError(`Assignment to constant variable.`);
			}

			if (!binding.initialized) {
				throw new ReferenceError(`Cannot access '${name}' before initialization`);
			}

			binding.value = value;

			return;
		}

		if (name === "undefined" || name === "NaN" || name === "Infinity") {
			throw new TypeError(`Cannot assign to read only property '${name}'`);
		}

		const root = this.root();
		const globals = root.globalObject;

		if (globals !== null && globals !== undefined && name in globals) {
			globals[name] = value;

			return;
		}

		if (root.realGlobals && name in globalThis) {
			// An existing host global (e.g. a `var` the host defined): keep the write in the sandbox.
			(globals ?? (root.globalObject = {}))[name] = value;

			return;
		}

		throw new ReferenceError(`${name} is not defined`);
	}

	/** Walk to the nearest scope that carries the given class/method field (arrows are transparent). */
	private findUp<K extends "homeObject" | "classMeta" | "newTarget" | "construction">(key: K): Scope[K] {
		if (this[key] !== undefined) {
			return this[key];
		}

		if (this.hasThis) {
			return this[key];
		} // stop at the owning function scope

		let current: Scope | undefined = this.parent;

		while (current) {
			if (current[key] !== undefined) {
				return current[key];
			}

			if (current.hasThis) {
				return current[key];
			} // stop at the owning function scope

			current = current.parent;
		}

		return undefined;
	}

	private lookup(name: string): Binding | undefined {
		const own = this.bindings.get(name);

		if (own) {
			return own;
		}

		let current: Scope | undefined = this.parent;

		while (current) {
			const binding = current.bindings.get(name);

			if (binding) {
				return binding;
			}

			current = current.parent;
		}

		return undefined;
	}
}
