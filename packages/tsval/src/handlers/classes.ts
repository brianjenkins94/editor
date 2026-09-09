/**
 * Classes: private names, class definition (two-phase: heritage and computed keys on the stack), fields, `super()`, the synthetic `construct`/`initfields` frames.
 */
import type { ConstructFrame, InitFieldsFrame, NodeFrame } from "../frame.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { Scope } from "../scope.ts";
import { collectCallArguments, pushCallArguments } from "./calls.ts";
import { bindParameters, createGuestFunction, functionLength, nameAnonymous, setFunctionName } from "./functions.ts";
import { hoist } from "./hoist.ts";
import { propertyName } from "./literals.ts";
import { createArgumentsObject, defineData, isObjectLike, toPropertyKey } from "./realm.ts";
import { THIS_TDZ, thisValue } from "./references.ts";
import { on, syntheticHandlers } from "./registry.ts";

const K = ts.SyntaxKind;

export interface ClassMeta {
	"node": ts.ClassLikeDeclaration;
	"closure": Scope;
	"superClass": unknown;
	"proto": object;
	"ctorNode"?: ts.ConstructorDeclaration;
	/** public (`name`) or private (`privateName`) instance fields, in source order. */
	"instanceFields": { "name"?: PropertyKey; "privateName"?: PrivateName; "initializer"?: ts.Expression }[];
	/** private methods/accessors installed on each instance before its fields initialize. */
	"instancePrivateMethods": PrivateName[];
}

//
// A private name is created fresh per class *evaluation* (a unique symbol) and resolved lexically —
// nearest enclosing class that declares it. Private elements live in a side table keyed by object
// (never as properties: they're invisible to reflection), and every access is a brand check: an
// object the class didn't initialize throws a TypeError.

export interface PrivateName {
	"key": symbol;
	/** `#x`, as written (for messages and `Function.name`). */
	"description": string;
	"kind": "field" | "method" | "accessor";
	"isStatic": boolean;
	"method"?: unknown;
	"get"?: unknown;
	"set"?: unknown;
}

export interface PrivateEntry {
	"pn": PrivateName;
	"value"?: unknown;
}

export const privateElements = new WeakMap<object, Map<symbol, PrivateEntry>>();

export function lookupPrivate(scope: Scope, name: string): PrivateName {
	for (let s: Scope | undefined = scope; s; s = s.parent) {
		const pn = s.privateNames?.get(name);

		if (pn !== undefined) { return pn as PrivateName; }
	}

	return unimplemented(`unbound private name ${name} (a parse-time error in valid code)`);
}

export function privateEntry(obj: unknown, pn: PrivateName, verb: string): PrivateEntry {
	if (!isObjectLike(obj)) { throw new TypeError(`Cannot ${verb} private member ${pn.description} from a non-object`); }
	const entry = privateElements.get(obj)?.get(pn.key);

	if (entry === undefined) { throw new TypeError(`Cannot ${verb} private member ${pn.description} from an object whose class did not declare it`); }

	return entry;
}

export function privateGet(obj: unknown, pn: PrivateName): unknown {
	const entry = privateEntry(obj, pn, "read");

	if (pn.kind === "field") { return entry.value; }
	if (pn.kind === "method") { return pn.method; }
	if (typeof pn.get !== "function") { throw new TypeError(`'${pn.description}' was defined without a getter`); }

	return (pn.get as (this: unknown) => unknown).call(obj);
}

export function privateSet(obj: unknown, pn: PrivateName, value: unknown): void {
	const entry = privateEntry(obj, pn, "write");

	if (pn.kind === "field") {
		entry.value = value;

		return;
	}

	if (pn.kind === "method") { throw new TypeError(`Private method '${pn.description}' is not writable`); }
	if (typeof pn.set !== "function") { throw new TypeError(`'${pn.description}' was defined without a setter`); }
	(pn.set as (this: unknown, v: unknown) => void).call(obj, value);
}

export function privateHas(obj: unknown, pn: PrivateName): boolean {
	if (!isObjectLike(obj)) { throw new TypeError("Cannot use 'in' operator to search for a private field in a non-object"); }

	return privateElements.get(obj)?.has(pn.key) === true;
}

/** PrivateFieldAdd / PrivateMethodOrAccessorAdd: brand the object with this private name. */
export function privateAdd(obj: object, pn: PrivateName, value?: unknown): void {
	let map = privateElements.get(obj);

	if (map === undefined) { privateElements.set(obj, (map = new Map())); }
	if (map.has(pn.key)) { throw new TypeError(`Cannot initialize ${pn.description} twice on the same object`); }
	map.set(pn.key, { "pn": pn, "value": value });
}

/** Fork support: a cloned object keeps its private state (values cloned, names shared). */
export function clonePrivateElements(from: object, to: object, cloneValue: (v: unknown) => unknown): void {
	const map = privateElements.get(from);

	if (map === undefined) { return; }
	const copy = new Map<symbol, PrivateEntry>();

	for (const [key, entry] of map) { copy.set(key, { "pn": entry.pn, "value": cloneValue(entry.value) }); }
	privateElements.set(to, copy);
}

export interface GuestClass {
	new (...args: unknown[]): unknown;
	"prototype": object;
}

/** IsConstructor, without calling anything: `Reflect.construct` validates its newTarget up front. */
export function isConstructor(value: unknown): boolean {
	if (typeof value !== "function") { return false; }
	try {
		// The target's construct trap answers without touching `value.prototype` (a getter there is
		// observable — `class C extends Base` must read it exactly once).
		Reflect.construct(CONSTRUCT_PROBE, [], value as new () => unknown);

		return true;
	} catch {
		return false;
	}
}

const CONSTRUCT_PROBE = new Proxy(function() {}, { "construct": () => ({}) });

/** A construction in progress: the instance as it stands (a parent constructor's `return`, or a host
 *  parent, may replace it) and the class being constructed — GetSuperConstructor is DYNAMIC
 *  (`Object.setPrototypeOf(C, …)` after definition changes what `super()` calls). Shared by the
 *  construct frame and the constructor's scope, so `super()` finds it from an arrow, from a callback
 *  invoked by the host, or after the constructor has returned (then: the parent runs, and binding
 *  `this` again is the ReferenceError). */
export interface Construction {
	"instance": object;
	"ctor": GuestClass;
}

/** The brand for guest classes — a side table, never a property (own-property lists are observable). */
export const CLASS_META = new WeakMap<object, ClassMeta>();

export function isGuestClass(value: unknown): value is GuestClass {
	return typeof value === "function" && CLASS_META.has(value);
}

export function classMetaOf(ctor: GuestClass): ClassMeta {
	return CLASS_META.get(ctor)!;
}

export function hasStatic(member: ts.ClassElement): boolean {
	const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;

	return (modifiers ?? []).some((m) => m.kind === K.StaticKeyword);
}

export function memberKey(vm: Machine, name: ts.PropertyName | undefined, scope: Scope): PropertyKey {
	if (name === undefined) { return ""; }
	if (ts.isComputedPropertyName(name)) { return toPropertyKey(vm.evalNodeSync(name.expression, scope)); }

	return propertyName(name);
}

/** Private names are created up front (fresh per class evaluation, BEFORE the heritage and computed
 *  keys evaluate — they may mention them) so every member, including initializers and methods that
 *  run later, resolves them lexically through the class scope. Idempotent per scope. */
export function declarePrivateNames(node: ts.ClassLikeDeclaration, scope: Scope): Map<string, object> {
	if (scope.privateNames !== undefined) { return scope.privateNames; }
	const privateNames = new Map<string, object>();

	scope.privateNames = privateNames;
	for (const member of node.members) {
		const { name } = member as { "name"?: ts.Node };

		if (name === undefined || !ts.isPrivateIdentifier(name)) { continue; }
		if (privateNames.has(name.text)) { continue; } // a get/set pair shares one name
		const kind: PrivateName["kind"] = ts.isPropertyDeclaration(member) ? "field" : ts.isMethodDeclaration(member) ? "method" : "accessor";

		privateNames.set(name.text, { "key": Symbol(name.text), "description": name.text, "kind": kind, "isStatic": hasStatic(member) } satisfies PrivateName);
	}

	return privateNames;
}

/** What the stepped class handler evaluated up front: the class scope, the `extends` value and the
 *  raw computed key values (source order). Without it (host-initiated builds) they are evaluated here. */
export interface PreEvaluatedClass {
	"scope": Scope;
	"superClass": unknown;
	"keys": unknown[];
	/** the name an anonymous class expression takes (NamedEvaluation), if any. */
	"name"?: string;
}

export function createGuestClass(vm: Machine, node: ts.ClassLikeDeclaration, outerScope: Scope, pre?: PreEvaluatedClass): GuestClass {
	assertSupportedClassSurface(node);
	// The class body sees an inner, immutable binding of its own name (so static initializers,
	// `static {}` blocks and methods can refer to it — also for a *named class expression*, whose name
	// is visible only inside). It is in the TDZ while the `extends` expression evaluates and is
	// initialized once the constructor exists.
	const scope = pre?.scope ?? new Scope(outerScope, false);

	if (pre === undefined && node.name) { scope.declareLexical(node.name.text, "const"); }
	const heritage = node.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);
	const superClass = pre !== undefined ? pre.superClass : heritage ? vm.evalNodeSync(heritage.types[0].expression, scope) : undefined;

	if (heritage && superClass !== null && typeof superClass !== "function") { throw new TypeError(`Class extends value ${String(superClass)} is not a constructor or null`); }
	let parentProto: unknown;

	if (typeof superClass === "function") {
		// IsConstructor first (an arrow / async / generator / bound-arrow parent is a TypeError before its
		// `prototype` is ever read), then the prototype must be an object (a function counts) or null.
		if (!isConstructor(superClass)) { throw new TypeError("Class extends value is not a constructor or null"); }
		parentProto = (superClass as { "prototype"?: unknown }).prototype; // read ONCE (a getter is observable)
		if (parentProto !== null && typeof parentProto !== "object" && typeof parentProto !== "function") { throw new TypeError(`Class extends value does not have valid prototype property ${String(parentProto)}`); }
	}

	const proto = superClass === null ? Object.create(null) : superClass !== undefined ? Object.create(parentProto as object | null) : new vm.realm.Object();
	const meta: ClassMeta = { "node": node, "closure": scope, "superClass": superClass, "proto": proto, "instanceFields": [], "instancePrivateMethods": [] };
	const privateNames = declarePrivateNames(node, scope);
	const privateOf = (member: ts.ClassElement): PrivateName | undefined => {
		const { name } = member as { "name"?: ts.Node };

		return name !== undefined && ts.isPrivateIdentifier(name) ? (privateNames.get(name.text) as PrivateName) : undefined;
	};

	// Every (public) member key is evaluated exactly once, in source order, before any member is
	// defined and while the class name is still in its TDZ (ClassDefinitionEvaluation evaluates the
	// element keys first; a computed instance-field key is NOT re-evaluated per instance). A *static*
	// ConstructorDeclaration is TypeScript's parse of `static constructor() {}` — a static method.
	const memberKeys = new Map<ts.ClassElement, PropertyKey>();
	const isStaticCtorMethod = (member: ts.ClassElement): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && hasStatic(member);
	let computedIndex = 0; // walks `pre.keys` (the same source order as computedKeyNodes)

	for (const member of node.members) {
		if (privateOf(member) !== undefined || isSignatureOnly(member)) { continue; }
		if (isStaticCtorMethod(member)) { memberKeys.set(member, "constructor"); } else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isPropertyDeclaration(member)) {
			let key: PropertyKey;

			if (pre !== undefined && ts.isComputedPropertyName(member.name)) {
				key = toPropertyKey(pre.keys[computedIndex]);
				computedIndex += 1;
			} else {
				key = memberKey(vm, member.name, scope);
			}

			memberKeys.set(member, key);
		}
	}

	const keyOf = (member: ts.ClassElement): PropertyKey => memberKeys.get(member)!;

	const Ctor = function(this: unknown, ...args: unknown[]): unknown {
		// Host-initiated construction (rare); guest `new` uses the explicit construct frame.
		if (new.target === undefined) { throw new TypeError(`Class constructor ${node.name?.text ?? ""} cannot be invoked without 'new'`); }

		return vm.constructGuestSync(Ctor, args, new.target);
	} as unknown as GuestClass;

	CLASS_META.set(Ctor, meta);
	Object.defineProperty(Ctor, "prototype", { "value": proto, "writable": false, "enumerable": false, "configurable": false }); // a class's prototype is immutable
	Object.defineProperty(proto, "constructor", { "value": Ctor, "enumerable": false, "writable": true, "configurable": true });
	Object.setPrototypeOf(Ctor, typeof superClass === "function" ? superClass : vm.realm.Function.prototype);
	// Always set: an anonymous class expression is `""`, and V8 would otherwise infer the host
	// variable's name ("Ctor") — observable via `.name`.
	// NamedEvaluation: an anonymous class expression bound to a name has that name ALREADY while its
	// static initializers run (`var C = class { static x = C.name }`).
	Object.defineProperty(Ctor, "name", { "value": node.name?.text ?? pre?.name ?? "", "configurable": true });
	// A class's `length` is its constructor's expected argument count (0 without an explicit one).
	const ctorDecl = node.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined && !hasStatic(m));

	Object.defineProperty(Ctor, "length", { "value": ctorDecl === undefined ? 0 : functionLength(ctorDecl.parameters), "configurable": true });
	if (node.name) { scope.initialize(node.name.text, Ctor); } // leaves the TDZ

	// Pass 1 — methods and accessors (public and private, instance and static), and the constructor.
	// Spec order: all methods exist before any static field initializer or static block runs.
	const staticPrivateInstalled = new Set<symbol>();

	for (const member of node.members) {
		const target = hasStatic(member) ? (Ctor as unknown as object) : proto;
		const pn = privateOf(member);

		if (isSignatureOnly(member) || ts.isIndexSignatureDeclaration(member)) { continue; } // type-only
		if (isStaticCtorMethod(member) || ts.isMethodDeclaration(member)) {
			const fn = createGuestFunction(vm, member, scope, target);

			if (pn !== undefined) {
				pn.method = fn;
				if (pn.isStatic) { privateAdd(Ctor, pn); } else { meta.instancePrivateMethods.push(pn); }
			} else {
				const key = keyOf(member);

				setFunctionName(fn, key);
				Object.defineProperty(target, key, { "value": fn, "enumerable": false, "writable": true, "configurable": true });
			}
		} else if (ts.isConstructorDeclaration(member)) {
			if (member.body) { meta.ctorNode = member; }
		} else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			const fn = createGuestFunction(vm, member, scope, target);

			if (pn !== undefined) {
				if (ts.isGetAccessorDeclaration(member)) { pn.get = fn; } else { pn.set = fn; }

				if (pn.isStatic) {
					if (!staticPrivateInstalled.has(pn.key)) { privateAdd(Ctor, pn); }
				} else if (!meta.instancePrivateMethods.includes(pn)) { meta.instancePrivateMethods.push(pn); }

				staticPrivateInstalled.add(pn.key);
			} else {
				const key = keyOf(member);

				setFunctionName(fn, key, ts.isGetAccessorDeclaration(member) ? "get" : "set");
				const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(target, key) ?? {}), "enumerable": false, "configurable": true };

				delete desc.value;
				delete desc.writable;
				if (ts.isGetAccessorDeclaration(member)) { desc.get = fn as () => unknown; } else { desc.set = fn as (v: unknown) => void; }

				Object.defineProperty(target, key, desc);
			}
		} else if (!ts.isPropertyDeclaration(member) && !ts.isClassStaticBlockDeclaration(member) && !ts.isSemicolonClassElement(member)) {
			unimplemented(`class member ${ts.SyntaxKind[member.kind]}`);
		}
	}

	// Pass 2 — fields and static blocks, in source order (static ones run now; instance ones are
	// recorded to run per construction).
	for (const member of node.members) {
		if (ts.isPropertyDeclaration(member)) {
			const pn = privateOf(member);

			if (hasStatic(member)) {
				const key: PropertyKey = pn?.description ?? keyOf(member);

				if (pn === undefined && key === "prototype") { throw new TypeError("Classes may not have a static property named 'prototype'"); }
				const value = member.initializer ? nameAnonymous(vm.evalNodeSync(member.initializer, fieldScope(meta, Ctor, Ctor)), key, member.initializer) : undefined;

				if (pn !== undefined) { privateAdd(Ctor, pn, value); } else { defineData(Ctor, key, value); }
			} else if (pn !== undefined) {
				meta.instanceFields.push({ "privateName": pn, "initializer": member.initializer });
			} else {
				meta.instanceFields.push({ "name": keyOf(member), "initializer": member.initializer });
			}
		} else if (ts.isClassStaticBlockDeclaration(member)) {
			// `static { … }` runs at definition time, in source order with static fields, `this` = the class.
			vm.evalNodeSync(member.body, fieldScope(meta, Ctor, Ctor));
		}
	}

	return Ctor;
}

/**
 * Supported-surface policy: strict-mode ECMAScript + erasable TypeScript. Decorators are refused
 * loudly rather than half-modeled: legacy `experimentalDecorators` are non-standard, and standard
 * (TC39) decorators share the syntax with different semantics — silently running one as the other
 * would be worse than an error. Parameter properties are non-erasable TS (Node's own type-stripping
 * rejects them) and would otherwise be silently ignored, which is wrong.
 */
export function assertSupportedClassSurface(node: ts.ClassLikeDeclaration): void {
	const refuse = (what: string): never => unimplemented(`${what} (out of scope: not standard / not erasable TypeScript)`);

	if ((ts.getDecorators(node) ?? []).length > 0) { refuse("class decorators"); }
	for (const member of node.members) {
		if (ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) { refuse("member decorators"); }
		if (ts.isPropertyDeclaration(member) && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Accessor) !== 0) { refuse("auto-accessor fields (`accessor x`)"); }
		if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) {
			for (const param of member.parameters) {
				if ((ts.getDecorators(param) ?? []).length > 0) { refuse("parameter decorators"); }
				if (ts.isConstructorDeclaration(member) && ts.isParameterPropertyDeclaration(param, member)) { refuse("parameter properties"); }
			}
		}
	}
}

// A scope for evaluating a field/static initializer, with `this` and [[HomeObject]] bound.
export function fieldScope(meta: ClassMeta, thisVal: unknown, homeObject: object): Scope {
	const s = new Scope(meta.closure, true);

	s.hasThis = true;
	s.thisVal = thisVal;
	s.homeObject = homeObject;
	s.classMeta = meta;

	return s;
}

export function initInstanceFields(vm: Machine, meta: ClassMeta, instance: object): void {
	// Private methods/accessors brand the instance first (so field initializers may call them).
	for (const pn of meta.instancePrivateMethods) { privateAdd(instance, pn); }
	for (const field of meta.instanceFields) {
		const key: PropertyKey = field.privateName?.description ?? (field.name!);
		const value = field.initializer ? nameAnonymous(vm.evalNodeSync(field.initializer, fieldScope(meta, instance, meta.proto)), key, field.initializer) : undefined;

		if (field.privateName !== undefined) { privateAdd(instance, field.privateName, value); } else { defineData(instance, key, value); } // DefineField: CreateDataProperty, never an inherited setter
	}
}

/**
 * Run the parent's construction for a derived class. A guest parent runs as a `construct` frame on
 * the explicit stack (nothing returned). A **host** parent (`extends Error`, `extends Array`) must
 * create* `this` itself, with the derived class as `new.target` so the prototype is right — the
 * spec's "`this` is uninitialized until `super()` returns" model — so the created object is returned
 * and the caller rebinds `this` to it.
 */
export function pushParentConstruct(vm: Machine, superClass: unknown, args: unknown[], instance: object, newTarget: unknown): object | undefined {
	if (isGuestClass(superClass)) {
		// `forSuper`: the frame leaves its final instance on the value stack — a parent constructor may
		// `return` a different object (a Proxy, say), and that is what `super()` yields as `this`.
		vm.pushFrame({ "kind": "construct", "node": null, "phase": 0, "scope": vm.rootScope, "valuesBase": vm.values.length, "ctor": superClass, "args": args, "instance": instance, "isNew": false, "forSuper": true, "newTarget": newTarget });

		return undefined;
	}

	if (typeof superClass === "function") { return Reflect.construct(superClass as new (...a: unknown[]) => object, args, newTarget as new (...a: unknown[]) => unknown); }
	throw new TypeError("Class extends value is not a constructor or null");
}

/** GetSuperConstructor: the class's CURRENT [[Prototype]], which must be a constructor. */
export function superConstructorOf(construction: Construction): unknown {
	const parent = Object.getPrototypeOf(construction.ctor) as unknown;

	if (!isConstructor(parent)) { throw new TypeError("Super constructor is not a constructor"); }

	return parent;
}

/** After a parent created/initialized `this`: the constructor's `this` and the construction record point at it. */
export function rebindThis(scope: Scope, construction: Construction, replacement: object): void {
	for (let s: Scope | undefined = scope; s; s = s.parent) {
		if (s.hasThis) {
			s.thisVal = replacement;
			break;
		}
	}

	construction.instance = replacement;
}

// `super(...)` inside a derived constructor: construct the parent on the current instance, then
// initialize this class's own instance fields (spec order), then the call yields undefined.
export function superCall(vm: Machine, frame: NodeFrame, node: ts.CallExpression): void {
	if (frame.phase === 0) {
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const args = collectCallArguments(vm, frame);
		const meta = frame.scope.getClassMeta();
		const construction = frame.scope.getConstruction();

		if (meta === undefined || construction === undefined) { throw new SyntaxError("'super' keyword unexpected here"); }
		const parent = superConstructorOf(construction);
		const newTarget = frame.scope.getNewTarget();

		// Spec order: the parent constructs FIRST; binding `this` a second time is the ReferenceError
		// (so a double `super()` — or one from an arrow after the constructor returned — runs the
		// parent again and then throws; fields initialize once).
		if (frame.scope.getThis() !== THIS_TDZ) {
			if (isGuestClass(parent)) {
				pushParentConstruct(vm, parent, args, Object.create(parent.prototype), newTarget);
				frame.phase = 3; // → discard the parent's instance, then the ReferenceError

				return;
			}

			pushParentConstruct(vm, parent, args, construction.instance, newTarget);
			assertThisUnbound(frame.scope);
		}

		if (isGuestClass(parent)) {
			// initfields runs after the parent construct frame completes (it's pushed first, below it);
			// it also binds `this` — the parent's construction is what initializes it.
			vm.pushFrame({ "kind": "initfields", "node": null, "phase": 0, "scope": meta.closure, "valuesBase": vm.values.length, "meta": meta, "instance": construction.instance, "construction": construction, "thisScope": frame.scope, "fromStack": true });
			pushParentConstruct(vm, parent, args, construction.instance, newTarget);
		} else {
			const created = pushParentConstruct(vm, parent, args, construction.instance, newTarget)!;

			rebindThis(frame.scope, construction, created);
			vm.pushFrame({ "kind": "initfields", "node": null, "phase": 0, "scope": meta.closure, "valuesBase": vm.values.length, "meta": meta, "instance": created, "construction": construction });
		}

		frame.phase = 2;
	} else if (frame.phase === 3) {
		vm.pop(); // the re-run parent's instance
		vm.frames.pop();
		assertThisUnbound(frame.scope);
	} else {
		vm.frames.pop();
		vm.push(thisValue(frame.scope)); // `super()` evaluates to the now-bound `this`
	}
}

export function assertThisUnbound(scope: Scope): void {
	if (scope.getThis() !== THIS_TDZ) { throw new ReferenceError("Super constructor may only be called once"); }
}

/** A method/accessor/constructor without a body is an overload signature: erased, its key never evaluated. */
export const isSignatureOnly = (member: ts.ClassElement): boolean => (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body === undefined;

/** The computed member keys of a class, in source order (the order they are evaluated in). */
export function computedKeyNodes(node: ts.ClassLikeDeclaration): ts.Expression[] {
	const out: ts.Expression[] = [];

	for (const member of node.members) {
		if (isSignatureOnly(member)) { continue; }
		const { name } = member as { "name"?: ts.PropertyName };

		if (name !== undefined && ts.isComputedPropertyName(name)) { out.push(name.expression); }
	}

	return out;
}

/**
 * ClassDefinitionEvaluation in two phases: the `extends` expression and every computed member key
 * are evaluated on the stepped stack — in the class scope, with the class name in its TDZ — so a
 * `yield`/`await` inside them suspends like anywhere else; then the class is built from those values.
 * Returns the constructor once built (undefined while the sub-expressions are still evaluating).
 */
export function classDefinition(vm: Machine, frame: NodeFrame, node: ts.ClassLikeDeclaration): GuestClass | undefined {
	const heritage = node.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);

	if (frame.phase === 0) {
		assertSupportedClassSurface(node);
		const scope = new Scope(frame.scope, false);

		if (node.name) { scope.declareLexical(node.name.text, "const"); }
		declarePrivateNames(node, scope);
		frame.classScope = scope;
		frame.base = vm.values.length;
		const keys = computedKeyNodes(node);

		for (let i = keys.length - 1; i >= 0; i--) { vm.pushNode(keys[i], scope); }
		if (heritage) { vm.pushNode(heritage.types[0].expression, scope); } // on top: evaluates first
		frame.phase = 1;

		return undefined;
	}

	const values = vm.values.splice(frame.base!);
	const superClass = heritage ? values.shift() : undefined;

	return createGuestClass(vm, node, frame.scope, { "scope": frame.classScope!, "superClass": superClass, "keys": values, "name": frame.nameHint });
}

function classDeclaration(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ClassDeclaration;
	const Ctor = classDefinition(vm, frame, node);

	if (Ctor === undefined) { return; }
	vm.frames.pop();
	if (node.name) {
		frame.scope.declareLexical(node.name.text, "let");
		frame.scope.initialize(node.name.text, Ctor);
	}
}

function classExpression(vm: Machine, frame: NodeFrame): void {
	const Ctor = classDefinition(vm, frame, frame.node as ts.ClassExpression);

	if (Ctor === undefined) { return; }
	vm.frames.pop();
	vm.push(Ctor);
}

// Synthetic construct frame: build one class level's instance on the explicit stack.
function constructFrame(vm: Machine, frame: ConstructFrame): void {
	const { ctor } = frame;
	const meta = classMetaOf(ctor);

	if (frame.phase === 0) {
		const instance = frame.instance ?? Object.create(ctor.prototype);
		const construction: Construction = { "instance": instance, "ctor": ctor };

		frame.construction = construction;
		frame.derived = meta.superClass !== undefined; // (a constructor's `return` is judged in VM.unwind)
		if (meta.ctorNode) {
			const fnScope = new Scope(meta.closure, true);

			fnScope.hasThis = true;
			// Derived: `this` is uninitialized until `super()` returns (ReferenceError before that).
			fnScope.thisVal = meta.superClass !== undefined ? THIS_TDZ : instance;
			fnScope.construction = construction;
			frame.ctorScope = fnScope;
			fnScope.homeObject = meta.proto;
			fnScope.classMeta = meta;
			fnScope.newTarget = frame.newTarget ?? ctor;
			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", createArgumentsObject(vm, frame.args));
			// Base class: fields initialize before the parameters bind and the body runs ([[Construct]]:
			// InitializeInstanceElements precedes OrdinaryCallEvaluateBody). Derived: after super().
			if (meta.superClass === undefined) { initInstanceFields(vm, meta, instance); }
			hoist(vm, fnScope, (meta.ctorNode.body!).statements);
			const body = vm.pushNode(meta.ctorNode.body!, fnScope);

			body.reuseScope = true;
			bindParameters(vm, fnScope, meta.ctorNode, frame.args); // (above the body: runs first)
		} else if (meta.superClass !== undefined) {
			// Implicit derived constructor: super(...args), then this class's fields.
			const newTarget = frame.newTarget ?? ctor;
			const parent = superConstructorOf(construction);

			if (isGuestClass(parent)) {
				vm.pushFrame({ "kind": "initfields", "node": null, "phase": 0, "scope": meta.closure, "valuesBase": vm.values.length, "meta": meta, "instance": instance, "construction": construction, "fromStack": true });
				pushParentConstruct(vm, parent, frame.args, instance, newTarget);
			} else {
				const created = pushParentConstruct(vm, parent, frame.args, instance, newTarget)!;

				construction.instance = created;
				vm.pushFrame({ "kind": "initfields", "node": null, "phase": 0, "scope": meta.closure, "valuesBase": vm.values.length, "meta": meta, "instance": created, "construction": construction });
			}
		} else {
			initInstanceFields(vm, meta, instance);
		}

		frame.phase = 1;
	} else {
		// A derived constructor that never called super() leaves `this` uninitialized: ReferenceError.
		const { ctorScope } = frame;

		if (ctorScope !== undefined && frame.overridden !== true && ctorScope.thisVal === THIS_TDZ) { throw new ReferenceError("Must call super constructor in derived class before accessing 'this' or returning from derived constructor"); }
		vm.frames.pop();
		if (frame.isNew || frame.forSuper === true) { vm.push((frame.construction!).instance); }
	}
}

// After `super()` returns: adopt the parent's final instance (`fromStack`: left by its construct
// frame), bind `this` (leaving its TDZ), then run this class's field initializers on it.
function initfieldsFrame(vm: Machine, frame: InitFieldsFrame): void {
	let { instance } = frame;

	if (frame.fromStack === true) { instance = vm.pop() as object; }
	if (frame.thisScope !== undefined) {
		assertThisUnbound(frame.thisScope);
		rebindThis(frame.thisScope, frame.construction!, instance);
	} else if (frame.construction !== undefined) { frame.construction.instance = instance; }

	initInstanceFields(vm, frame.meta, instance);
	vm.frames.pop();
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(K.ClassDeclaration, classDeclaration);
	on(K.ClassExpression, classExpression);
	syntheticHandlers.construct = constructFrame;
	syntheticHandlers.initfields = initfieldsFrame;
}
