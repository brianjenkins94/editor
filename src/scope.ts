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

export type BindingKind = "var" | "let" | "const" | "param" | "function";

export interface Binding {
	value: unknown;
	kind: BindingKind;
	/** false while in the Temporal Dead Zone (declared but not yet initialized). */
	initialized: boolean;
}

export class Scope {
	readonly parent: Scope | undefined;
	/** function scope (var target, `arguments`/`this` holder) vs. block scope. */
	readonly isolated: boolean;
	readonly bindings = new Map<string, Binding>();
	/** Only the root scope carries injected/host globals. */
	globalObject: Record<string, unknown> | undefined;
	/** Only the root scope: fall back to the host's real `globalThis` for unresolved names. */
	realGlobals = false;
	/** `this` binding for this scope (function scopes and the module root; not arrow functions). */
	thisVal: unknown = undefined;
	hasThis = false;

	constructor(parent?: Scope, isolated = false) {
		this.parent = parent;
		this.isolated = isolated;
	}

	/** The nearest enclosing function (isolated) scope — the target for `var` hoisting. */
	functionScope(): Scope {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let s: Scope = this;
		while (!s.isolated && s.parent) s = s.parent;
		return s;
	}

	root(): Scope {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let s: Scope = this;
		while (s.parent) s = s.parent;
		return s;
	}

	/** Resolve `this`: nearest enclosing scope that owns a `this` binding (arrows are transparent). */
	getThis(): unknown {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let s: Scope | undefined = this;
		while (s) {
			if (s.hasThis) return s.thisVal;
			s = s.parent;
		}
		return undefined;
	}

	/** Declare a `var`: hoisted to the function scope, defined but initialized to `undefined`. */
	declareVar(name: string): void {
		const fs = this.functionScope();
		if (!fs.bindings.has(name)) {
			fs.bindings.set(name, { value: undefined, kind: "var", initialized: true });
		}
	}

	/** Declare a hoisted `function` binding in the function scope. */
	declareFunction(name: string, value: unknown): void {
		const fs = this.functionScope();
		fs.bindings.set(name, { value, kind: "function", initialized: true });
	}

	/** Declare a block-scoped `let`/`const`/`param`; enters the TDZ until `initialize`. */
	declareLexical(name: string, kind: BindingKind): void {
		this.bindings.set(name, { value: undefined, kind, initialized: kind === "param" });
	}

	/** Provide the value for a previously-declared binding, leaving the TDZ. */
	initialize(name: string, value: unknown): void {
		const b = this.bindings.get(name);
		if (!b) throw new TsvalInternalError(`invariant: initialize of undeclared '${name}'`);
		b.value = value;
		b.initialized = true;
	}

	private lookup(name: string): Binding | undefined {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let s: Scope | undefined = this;
		while (s) {
			const b = s.bindings.get(name);
			if (b) return b;
			s = s.parent;
		}
		return undefined;
	}

	has(name: string): boolean {
		if (this.lookup(name)) return true;
		const root = this.root();
		if (root.globalObject != null && name in root.globalObject) return true;
		return root.realGlobals && name in globalThis;
	}

	get(name: string): unknown {
		const b = this.lookup(name);
		if (b) {
			if (!b.initialized) throw new ReferenceError(`Cannot access '${name}' before initialization`);
			return b.value;
		}
		const root = this.root();
		const g = root.globalObject;
		if (g != null && name in g) return g[name];
		if (root.realGlobals && name in globalThis) return (globalThis as Record<string, unknown>)[name];
		throw new ReferenceError(`${name} is not defined`);
	}

	/** Assignment to an existing binding (or an implicit global). */
	set(name: string, value: unknown): void {
		const b = this.lookup(name);
		if (b) {
			if (b.kind === "const" && b.initialized) throw new TypeError(`Assignment to constant variable.`);
			if (!b.initialized) throw new ReferenceError(`Cannot access '${name}' before initialization`);
			b.value = value;
			return;
		}
		const g = this.root().globalObject;
		if (g != null) {
			g[name] = value;
			return;
		}
		throw new ReferenceError(`${name} is not defined`);
	}
}
