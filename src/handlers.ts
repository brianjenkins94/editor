import ts from "typescript";
import { Scope, type BindingKind } from "./scope.ts";
import type { Frame, Handler, Signal, VM } from "./vm.ts";
import type { GuestFunction, GuestFunctionMeta, GuestFunctionNode } from "./values.ts";
import { isGuestFunction } from "./values.ts";
import { unimplemented } from "./errors.ts";

const K = ts.SyntaxKind;

/** Per-SyntaxKind frame handlers. */
export const nodeHandlers: Record<number, Handler> = {};
/** Synthetic-frame handlers (frames with a `kind` tag rather than a 1:1 node). */
export const syntheticHandlers: Record<string, Handler> = {};

function on(kind: number, handler: Handler): void {
	nodeHandlers[kind] = handler;
}

// ============================================================================
// Hoisting
// ============================================================================

/**
 * Shallow hoist pass for a block/function/source scope: install `function` declarations (fully, with
 * value) and put `let`/`const` names into the TDZ. `var` names hoist to the function scope.
 *
 * NOTE (S1): `var` hoisting only scans the immediate statement list. Vars buried in nested blocks/
 * loops still need a recursive collector — added with loops in S2. Tracked in PROGRESS.md.
 */
function hoist(vm: VM, scope: Scope, statements: readonly ts.Statement[]): void {
	for (const statement of statements) {
		if (isAmbient(statement)) {
			continue;
		} else if (ts.isImportDeclaration(statement)) {
			bindImport(vm, scope, statement);
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			scope.declareFunction(statement.name.text, createGuestFunction(vm, statement, scope));
		} else if (ts.isVariableStatement(statement)) {
			const flags = statement.declarationList.flags;
			const isLet = (flags & ts.NodeFlags.Let) !== 0;
			const isConst = (flags & ts.NodeFlags.Const) !== 0;
			if (isLet || isConst) {
				for (const decl of statement.declarationList.declarations) {
					for (const name of bindingNames(decl.name)) scope.declareLexical(name, isConst ? "const" : "let");
				}
			}
		}
	}
	// `var` is function-scoped no matter how deeply nested in blocks/loops/try/switch: collect
	// recursively (not into nested functions/classes, which are their own var scope). Idempotent, so
	// re-running at each block entry is harmless.
	for (const name of collectVarNames(statements)) scope.declareVar(name);
}

/** All identifiers bound by a (possibly destructuring) binding name. */
function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
	if (ts.isIdentifier(name)) out.push(name.text);
	else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
	return out;
}

/** Names of every `var` declared anywhere in `statements`, excluding nested function/class bodies. */
function collectVarNames(statements: readonly ts.Node[], out: string[] = []): string[] {
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) || ts.isClassLike(node)) return; // own var scope
		if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
			for (const decl of node.declarations) bindingNames(decl.name, out);
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of statements) visit(statement);
	return out;
}

// ============================================================================
// Guest functions
// ============================================================================

export function createGuestFunction(vm: VM, node: GuestFunctionNode, closure: Scope, homeObject?: object): GuestFunction {
	const modifierFlags = ts.getCombinedModifierFlags(node as ts.Declaration);
	const meta: GuestFunctionMeta = {
		node,
		closure,
		name: node.name != null && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : "",
		isArrow: node.kind === K.ArrowFunction,
		isGenerator: (node as ts.FunctionLikeDeclaration).asteriskToken != null,
		isAsync: (modifierFlags & ts.ModifierFlags.Async) !== 0,
		homeObject,
	};
	// The host-invoked wrapper (array callbacks, shims, host-mediated `new`) runs a nested loop to
	// completion. Its *shape* mirrors the guest function's: an arrow (no `this`, no `prototype`, not
	// constructible), a concise method (has `this`, no `prototype`, not constructible), or a plain
	// function (constructible; `new.target` forwarded so the body can observe construction).
	const isMethodLike = ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
	const fn = makeWrapper(vm, meta, isMethodLike);
	fn.__tsval = meta;
	// Realm fidelity: the function object belongs to the guest realm's Function.prototype (or the
	// %GeneratorFunction.prototype% / %AsyncFunction.prototype% family), and a constructible
	// function's `.prototype` is a guest-realm object. A generator function's `.prototype` is the
	// prototype of the generator objects it creates (and is not a constructor).
	const realm = vm.realm;
	Object.setPrototypeOf(fn, meta.isGenerator ? (meta.isAsync ? realm.AsyncGeneratorFunctionPrototype : realm.GeneratorFunctionPrototype) : meta.isAsync ? realm.AsyncFunctionPrototype : realm.Function.prototype);
	if (meta.isGenerator) {
		Object.defineProperty(fn, "prototype", { value: Object.create(meta.isAsync ? realm.AsyncGeneratorPrototype : realm.GeneratorPrototype), writable: true, enumerable: false, configurable: false });
	} else if (!meta.isArrow && !isMethodLike && !meta.isAsync) {
		const proto = new realm.Object();
		Object.defineProperty(proto, "constructor", { value: fn, writable: true, configurable: true });
		Object.defineProperty(fn, "prototype", { value: proto, writable: true });
	}
	meta.self = fn;
	Object.defineProperty(fn, "length", { value: functionLength(node.parameters), configurable: true });
	Object.defineProperty(fn, "name", { value: meta.name, configurable: true });
	// A named function *expression* binds its own name inside itself, immutably (assigning to it is a
	// TypeError in strict code).
	if (ts.isFunctionExpression(node) && node.name !== undefined) {
		const inner = new Scope(closure, false);
		inner.declareLexical(node.name.text, "const");
		inner.initialize(node.name.text, fn);
		meta.closure = inner;
	}
	return fn;
}

// Fixed wrapper templates (NOT guest code) for creating a function object *inside another realm*: a
// function's realm decides fallbacks like `new F()` with a non-object `F.prototype`, and whether
// `F instanceof Function` holds for the guest's `Function`.
// Strict, like the in-realm wrappers (an ESM module): a host caller's `undefined` receiver must
// reach the guest as `undefined`, not the realm's global object.
const FOREIGN_WRAPPERS = {
	arrow: '"use strict"; return (...args) => vm.callGuestFromHost(meta, undefined, args);',
	method: '"use strict"; return { m(...args) { return vm.callGuestFromHost(meta, this, args); } }.m;',
	plain: '"use strict"; return function (...args) { return vm.callGuestFromHost(meta, this, args, new.target); };',
};

function makeWrapper(vm: VM, meta: GuestFunctionMeta, methodLike: boolean): GuestFunction {
	// Generator and async functions are not constructors either (`new gen()` is a TypeError).
	const isMethodLike = methodLike || meta.isGenerator || meta.isAsync;
	if (vm.realm.Function !== Function) {
		const template = meta.isArrow ? FOREIGN_WRAPPERS.arrow : isMethodLike ? FOREIGN_WRAPPERS.method : FOREIGN_WRAPPERS.plain;
		return (vm.realm.Function("vm", "meta", template) as (vm: VM, meta: GuestFunctionMeta) => GuestFunction)(vm, meta);
	}
	if (meta.isArrow) return ((...args: unknown[]) => vm.callGuestFromHost(meta, undefined, args)) as GuestFunction;
	if (isMethodLike) {
		return {
			m(this: unknown, ...args: unknown[]) {
				return vm.callGuestFromHost(meta, this, args);
			},
		}.m as GuestFunction;
	}
	return function (this: unknown, ...args: unknown[]): unknown {
		return vm.callGuestFromHost(meta, this, args, new.target);
	} as GuestFunction;
}

// ============================================================================
// Program / statements
// ============================================================================

on(K.SourceFile, (vm, frame) => {
	const node = frame.node as ts.SourceFile;
	if (frame.phase === 0) {
		hoist(vm, frame.scope, node.statements);
		pushStatementsReverse(vm, node.statements, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

on(K.Block, (vm, frame) => {
	const node = frame.node as ts.Block;
	if (frame.phase === 0) {
		// A function-body Block runs directly in the function scope (params + body share it); a plain
		// Block gets a fresh child scope. `frame.reuseScope` is set by the call handler.
		const blockScope = frame.reuseScope ? frame.scope : new Scope(frame.scope, false);
		if (!frame.reuseScope) hoist(vm, blockScope, node.statements);
		pushStatementsReverse(vm, node.statements, blockScope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

function pushStatementsReverse(vm: VM, statements: readonly ts.Statement[], scope: Scope): void {
	for (let i = statements.length - 1; i >= 0; i--) {
		if (!isAmbient(statements[i])) vm.pushNode(statements[i], scope);
	}
}

on(K.EmptyStatement, (vm) => {
	vm.frames.pop();
});

on(K.VariableStatement, (vm, frame) => {
	const node = frame.node as ts.VariableStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.declarationList, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

// Shared driver for a VariableDeclarationList: declare each name (defensively — `hoist` may already
// have, e.g. for TDZ in a block, but a `for`-init has no hoist pass), evaluate initializers in order,
// then bind. Runs in `frame.scope` (the scope the list was pushed with).
on(K.VariableDeclarationList, (vm, frame) => {
	const list = frame.node as ts.VariableDeclarationList;
	const decls = list.declarations;
	const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
	const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
	const kind: BindingKind = isConst ? "const" : isLet ? "let" : "var";

	// phase encodes "which declaration are we on": phase 2*i => start decl i; phase 2*i+1 => bind decl i.
	const i = frame.phase >> 1;
	if (i >= decls.length) {
		vm.frames.pop();
		return;
	}
	const decl = decls[i];

	if ((frame.phase & 1) === 0) {
		if (decl.initializer) {
			vm.pushNode(decl.initializer, frame.scope);
			frame.phase++; // -> bind
		} else {
			// no initializer: `let x;` leaves the TDZ as undefined. `var x;` is a runtime no-op — it must
			// not overwrite a hoisted `function x` (or an earlier assignment) with undefined.
			if (kind !== "var") bindTarget(vm, frame.scope, decl.name, undefined, kind);
			frame.phase += 2; // -> next decl
		}
	} else {
		const value = namedIf(vm.pop(), decl.name, decl.initializer);
		// A pattern whose sub-expressions may suspend runs as a frame above this one.
		if (bindingNeedsStepping(decl.name)) pushPattern(vm, frame.scope, bindingProgram(decl.name, kind), value);
		else bindTarget(vm, frame.scope, decl.name, value, kind);
		frame.phase++; // -> next decl (now even)
	}
});

on(K.ExpressionStatement, (vm, frame) => {
	const node = frame.node as ts.ExpressionStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.completion = vm.pop(); // REPL/eval completion value
		vm.frames.pop();
	}
});

on(K.IfStatement, (vm, frame) => {
	const node = frame.node as ts.IfStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const cond = vm.pop();
		if (cond) vm.pushNode(node.thenStatement, frame.scope);
		else if (node.elseStatement) vm.pushNode(node.elseStatement, frame.scope);
		frame.phase = 2;
	} else {
		vm.frames.pop();
	}
});

on(K.ReturnStatement, (vm, frame) => {
	const node = frame.node as ts.ReturnStatement;
	if (frame.phase === 0 && node.expression) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const value = node.expression ? vm.pop() : undefined;
		vm.frames.pop();
		vm.raise({ type: "return", value });
	}
});

on(K.ThrowStatement, (vm, frame) => {
	const node = frame.node as ts.ThrowStatement;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const value = vm.pop();
		vm.frames.pop();
		vm.raise({ type: "throw", value });
	}
});

// A hoisted function declaration is a no-op at execution time (created during hoist).
on(K.FunctionDeclaration, (vm) => {
	vm.frames.pop();
});

// Type-only / erased declarations — no runtime effect (the checker uses them; the VM skips them).
const noop: Handler = (vm) => vm.frames.pop();
on(K.TypeAliasDeclaration, noop);
on(K.InterfaceDeclaration, noop);
on(K.ExportDeclaration, noop); // `export { ... }` — module output isn't modeled
on(K.ImportEqualsDeclaration, noop);

/** Ambient (`declare ...`) statements describe host shapes for the checker; they never execute. */
function isAmbient(node: ts.Node): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === K.DeclareKeyword);
}

// ============================================================================
// Modules (import / require / dynamic import) — the shim-injection seam (S5)
// ============================================================================

/**
 * Bind an ImportDeclaration's names from the resolved module namespace. ESM-hoisted: run during the
 * `hoist` pass so imports are live before the first statement. Type-only imports resolve to nothing
 * useful but never run at runtime; `import type` is elided by the parser's `importClause.isTypeOnly`.
 */
function bindImport(vm: VM, scope: Scope, node: ts.ImportDeclaration): void {
	const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
	const clause = node.importClause;
	if (clause === undefined) {
		vm.importModule(specifier); // side-effect import
		return;
	}
	if (clause.isTypeOnly) return;
	const ns = vm.importModule(specifier) as Record<string, unknown>;
	const bind = (name: string, value: unknown): void => {
		scope.declareLexical(name, "const");
		scope.initialize(name, value);
	};
	if (clause.name) bind(clause.name.text, vm.fromHost((ns as { default?: unknown }).default ?? ns)); // default import
	const bindings = clause.namedBindings;
	if (bindings && ts.isNamespaceImport(bindings)) {
		bind(bindings.name.text, ns);
	} else if (bindings && ts.isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			if (element.isTypeOnly) continue;
			bind(element.name.text, vm.fromHost(ns[(element.propertyName ?? element.name).text]));
		}
	}
}

// Imports are bound during hoisting; the statement itself is a no-op. `import =` / `export` (module
// output) aren't modeled — this interpreter runs a program, it doesn't emit one.
on(K.ImportDeclaration, (vm) => {
	vm.frames.pop();
});

on(K.BreakStatement, (vm, frame) => {
	const node = frame.node as ts.BreakStatement;
	vm.frames.pop();
	vm.raise({ type: "break", label: node.label?.text });
});

on(K.ContinueStatement, (vm, frame) => {
	const node = frame.node as ts.ContinueStatement;
	vm.frames.pop();
	vm.raise({ type: "continue", label: node.label?.text });
});

// ============================================================================
// Loops
// ============================================================================
//
// Loop frames set `frame.isLoop = true` (so `unwind` catches break/continue) and `frame.continuePhase`
// (the phase to resume at on `continue`). A labeled loop's `frame.label` is set by LabeledStatement
// before the loop's phase 0 runs.

on(K.WhileStatement, (vm, frame) => {
	const node = frame.node as ts.WhileStatement;
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 0;
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (!vm.pop()) return void vm.frames.pop();
		vm.pushNode(node.statement, frame.scope);
		frame.phase = 2;
	} else {
		frame.phase = 0; // next iteration: re-evaluate the condition
	}
});

on(K.DoStatement, (vm, frame) => {
	const node = frame.node as ts.DoStatement;
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 1; // `continue` in a do-while proceeds to the condition test
		vm.pushNode(node.statement, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 2;
	} else {
		if (vm.pop()) frame.phase = 0;
		else vm.frames.pop();
	}
});

on(K.ForStatement, (vm, frame) => {
	const node = frame.node as ts.ForStatement;
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 4; // `continue` runs the incrementor, then re-checks the condition
		const loopScope = new Scope(frame.scope, false);
		frame.iterScope = loopScope;
		// For per-iteration `let`/`const` binding (fresh binding each turn — correct closure capture).
		frame.lexicalNames =
			node.initializer != null && ts.isVariableDeclarationList(node.initializer) && (node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
				? node.initializer.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : null)).filter((n): n is string => n !== null)
				: null;
		// The copies keep the declaration's kind: `for (const x = 0; ; x++)` is a TypeError, not a loop.
		frame.lexicalKind = node.initializer != null && (node.initializer.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";

		if (node.initializer) {
			vm.pushNode(node.initializer, loopScope);
			frame.initIsExpr = !ts.isVariableDeclarationList(node.initializer);
			frame.phase = 1;
		} else {
			frame.phase = 2;
		}
	} else if (frame.phase === 1) {
		if (frame.initIsExpr) vm.pop();
		copyPerIteration(frame);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const scope = frame.iterScope as Scope;
		if (node.condition) {
			vm.pushNode(node.condition, scope);
			frame.phase = 3;
		} else {
			vm.pushNode(node.statement, scope);
			frame.phase = 4;
		}
	} else if (frame.phase === 3) {
		if (!vm.pop()) return void vm.frames.pop();
		vm.pushNode(node.statement, frame.iterScope as Scope);
		frame.phase = 4;
	} else if (frame.phase === 4) {
		// After the body: snapshot bindings into a fresh scope (so the body's closures keep their
		// values), THEN run the incrementor in that fresh scope. (spec CreatePerIterationEnvironment.)
		copyPerIteration(frame);
		if (node.incrementor) {
			vm.pushNode(node.incrementor, frame.iterScope as Scope);
			frame.phase = 5;
		} else {
			frame.phase = 2;
		}
	} else {
		vm.pop(); // discard incrementor value
		frame.phase = 2;
	}
});

// Snapshot the loop variables into a fresh scope so each iteration captures its own binding.
function copyPerIteration(frame: Frame): void {
	const names = frame.lexicalNames as string[] | null;
	if (names == null || names.length === 0) return;
	const prev = frame.iterScope as Scope;
	const next = new Scope(frame.scope, false);
	const kind = (frame.lexicalKind as "let" | "const" | undefined) ?? "let";
	for (const name of names) {
		next.declareLexical(name, kind);
		next.initialize(name, prev.get(name));
	}
	frame.iterScope = next;
}

on(K.ForOfStatement, (vm, frame) => {
	const node = frame.node as ts.ForOfStatement;
	if (node.awaitModifier) return forAwaitOf(vm, frame, node);
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const record = getIterator(vm, vm.pop());
		frame.iterRecord = record;
		frame.iterator = record.iterator; // for IteratorClose on abrupt exit (vm.closeLoopIterator)
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const value = loopStep(frame);
		if (value === LOOP_DONE) return void vm.frames.pop();
		bindForTarget(vm, frame, node.initializer, vm.fromHost(value));
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
});

const LOOP_DONE: unique symbol = Symbol("tsval.loop-done");

/** IteratorStep + IteratorValue for a loop frame. An iterator whose `next`/`done`/`value` throws is
 *  marked done first, so the loop's abrupt exit does NOT IteratorClose it (spec). */
function loopStep(frame: Frame): unknown {
	try {
		const result = iterNext(frame.iterRecord as IterRecord);
		if (result.done) {
			frame.iteratorDone = true;
			return LOOP_DONE;
		}
		return result.value;
	} catch (error) {
		frame.iteratorDone = true;
		throw error;
	}
}

// `for await (x of iterable)`: an async iterator's `.next()` results are awaited; a sync iterable's
// *values* are awaited (the spec's async-from-sync adaptation). Each await suspends the enclosing
// fiber, which is what makes the loop steppable/forkable like any other.
function forAwaitOf(vm: VM, frame: Frame, node: ts.ForOfStatement): void {
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const { record, sync } = getAsyncOrSyncIterator(vm, vm.pop());
		frame.iterRecord = record;
		frame.iterator = record.iterator;
		frame.syncIterator = sync;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		if (frame.syncIterator) {
			const value = loopStep(frame);
			if (value === LOOP_DONE) return void vm.frames.pop();
			suspend(vm, frame, "await", value, 3); // await the element itself
		} else {
			let step: unknown;
			try {
				step = iterNext(frame.iterRecord as IterRecord);
			} catch (error) {
				frame.iteratorDone = true;
				throw error;
			}
			suspend(vm, frame, "await", step, 4); // await the result object
		}
	} else if (frame.phase === 3) {
		bindForTarget(vm, frame, node.initializer, resumed(vm));
		frame.phase = 5;
	} else if (frame.phase === 4) {
		const result = resumed(vm);
		if (typeof result !== "object" || result === null) throw new TypeError("Iterator result is not an object");
		let value: unknown;
		try {
			if ((result as IteratorResult<unknown>).done) {
				frame.iteratorDone = true;
				return void vm.frames.pop();
			}
			value = (result as IteratorResult<unknown>).value;
		} catch (error) {
			frame.iteratorDone = true;
			throw error;
		}
		bindForTarget(vm, frame, node.initializer, vm.fromHost(value));
		frame.phase = 5;
	} else {
		frame.phase = 2;
	}
}

on(K.ForInStatement, (vm, frame) => {
	const node = frame.node as ts.ForInStatement;
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const obj = vm.pop();
		const keys: string[] = [];
		if (obj != null) for (const key in obj as object) keys.push(key);
		frame.keys = keys;
		frame.index = 0;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const keys = frame.keys as string[];
		const index = frame.index as number;
		if (index >= keys.length) return void vm.frames.pop();
		frame.index = index + 1;
		bindForTarget(vm, frame, node.initializer, keys[index]);
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
});

// Bind the current for-of/for-in element to the loop target in a fresh per-iteration scope, then
// push the body. Destructuring targets: S2 (later).
function bindForTarget(vm: VM, frame: Frame, initializer: ts.ForInitializer, value: unknown): void {
	const node = frame.node as ts.ForOfStatement | ts.ForInStatement;
	const bodyScope = new Scope(frame.scope, false);
	// A pattern that may suspend is bound by a frame pushed ABOVE the body (so it runs first).
	let stepped: { scope: Scope; program: PatternProgram } | undefined;
	if (ts.isVariableDeclarationList(initializer)) {
		const decl = initializer.declarations[0];
		const isConst = (initializer.flags & ts.NodeFlags.Const) !== 0;
		const isLet = (initializer.flags & ts.NodeFlags.Let) !== 0;
		const kind: BindingKind = isConst ? "const" : isLet ? "let" : "var";
		if (bindingNeedsStepping(decl.name)) stepped = { scope: bodyScope, program: bindingProgram(decl.name, kind) };
		else bindTarget(vm, bodyScope, decl.name, value, kind);
	} else if (assignNeedsStepping(initializer as ts.Expression)) {
		stepped = { scope: frame.scope, program: assignProgram(initializer as ts.Expression) };
	} else {
		// An assignment target: identifier, member, or a destructuring pattern (`for ([a, b] of …)`).
		assignPattern(vm, frame.scope, initializer as ts.Expression, value);
	}
	vm.pushNode(node.statement, bodyScope);
	if (stepped !== undefined) pushPattern(vm, stepped.scope, stepped.program, value);
}

// ============================================================================
// switch
// ============================================================================

on(K.SwitchStatement, (vm, frame) => {
	const node = frame.node as ts.SwitchStatement;
	const clauses = node.caseBlock.clauses;
	if (frame.phase === 0) {
		frame.isSwitch = true;
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		frame.disc = vm.pop();
		frame.caseIndex = 0;
		frame.defaultIndex = clauses.findIndex((c) => c.kind === K.DefaultClause);
		frame.switchScope = new Scope(frame.scope, false);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		// Scan forward for the next `case` test to evaluate (skip `default` while matching).
		let i = frame.caseIndex as number;
		while (i < clauses.length && clauses[i].kind === K.DefaultClause) i++;
		if (i >= clauses.length) {
			const def = frame.defaultIndex as number;
			frame.execIndex = def >= 0 ? def : clauses.length;
			frame.phase = 4;
			return;
		}
		frame.pendingCase = i;
		vm.pushNode((clauses[i] as ts.CaseClause).expression, frame.switchScope as Scope);
		frame.phase = 3;
	} else if (frame.phase === 3) {
		const testValue = vm.pop();
		if (testValue === frame.disc) {
			frame.execIndex = frame.pendingCase;
			frame.phase = 4;
		} else {
			frame.caseIndex = (frame.pendingCase as number) + 1;
			frame.phase = 2;
		}
	} else if (frame.phase === 4) {
		// Execute statements from the matched clause to the end (fall-through), sharing one block scope.
		const start = frame.execIndex as number;
		if (start >= clauses.length) return void vm.frames.pop();
		const statements: ts.Statement[] = [];
		for (let c = start; c < clauses.length; c++) for (const s of clauses[c].statements) statements.push(s);
		const switchScope = frame.switchScope as Scope;
		hoist(vm, switchScope, statements);
		for (let s = statements.length - 1; s >= 0; s--) vm.pushNode(statements[s], switchScope);
		frame.phase = 5;
	} else {
		vm.frames.pop();
	}
});

// ============================================================================
// Labeled statements
// ============================================================================

on(K.LabeledStatement, (vm, frame) => {
	const node = frame.node as ts.LabeledStatement;
	if (frame.phase === 0) {
		frame.isLabel = true; // catches `break <label>` for a labeled block
		frame.label = node.label.text;
		const child = vm.pushNode(node.statement, frame.scope);
		child.label = node.label.text; // a labeled loop/switch catches break/continue <label> itself
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
});

// ============================================================================
// try / catch / finally
// ============================================================================
//
// The phases here pair with `unwindTry` in vm.ts: unwind sets phase 3 (catch) or 5 (pending-finally)
// and pushes the appropriate block; these phases run after a block completes normally.

on(K.TryStatement, (vm, frame) => {
	const node = frame.node as ts.TryStatement;
	if (frame.phase === 0) {
		frame.state = "try";
		vm.pushNode(node.tryBlock, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		// try block completed normally
		if (node.finallyBlock) {
			frame.state = "finally";
			vm.pushNode(node.finallyBlock, frame.scope);
			frame.phase = 2;
		} else {
			vm.frames.pop();
		}
	} else if (frame.phase === 2) {
		vm.frames.pop(); // finally (after normal try) done
	} else if (frame.phase === 3) {
		// catch block completed normally
		if (node.finallyBlock) {
			frame.state = "finally";
			vm.pushNode(node.finallyBlock, frame.scope);
			frame.phase = 4;
		} else {
			vm.frames.pop();
		}
	} else if (frame.phase === 4) {
		vm.frames.pop(); // finally (after catch) done
	} else {
		// phase 5: pending-finally done → re-raise the signal that was escaping.
		vm.frames.pop();
		vm.raise(frame.pendingSignal as Signal);
	}
});

// ============================================================================
// Literals & simple expressions
// ============================================================================

on(K.NumericLiteral, (vm, frame) => {
	const node = frame.node as ts.NumericLiteral;
	vm.frames.pop();
	vm.push(Number(node.text.replace(/_/g, "")));
});

on(K.BigIntLiteral, (vm, frame) => {
	const node = frame.node as ts.BigIntLiteral;
	vm.frames.pop();
	vm.push(BigInt(node.text.replace(/_/g, "").replace(/n$/, "")));
});

const pushText: Handler = (vm, frame) => {
	vm.frames.pop();
	vm.push((frame.node as ts.LiteralLikeNode).text);
};
on(K.StringLiteral, pushText);
on(K.NoSubstitutionTemplateLiteral, pushText);

on(K.TrueKeyword, (vm) => {
	vm.frames.pop();
	vm.push(true);
});
on(K.FalseKeyword, (vm) => {
	vm.frames.pop();
	vm.push(false);
});
on(K.NullKeyword, (vm) => {
	vm.frames.pop();
	vm.push(null);
});

on(K.RegularExpressionLiteral, (vm, frame) => {
	const node = frame.node as ts.RegularExpressionLiteral;
	vm.frames.pop();
	const lastSlash = node.text.lastIndexOf("/");
	vm.push(new vm.realm.RegExp(node.text.slice(1, lastSlash), node.text.slice(lastSlash + 1)));
});

on(K.Identifier, (vm, frame) => {
	const node = frame.node as ts.Identifier;
	vm.frames.pop();
	// Globals are host values; guest bindings pass through the guard unchanged (identity by default).
	vm.push(vm.fromHost(frame.scope.get(node.text)));
});

/** `this` in a derived constructor is uninitialized until `super()` returns (a ReferenceError). */
const THIS_TDZ: unique symbol = Symbol("tsval.this-uninitialized");

function thisValue(scope: Scope): unknown {
	const value = scope.getThis();
	if (value === THIS_TDZ) throw new ReferenceError("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
	return value;
}

on(K.ThisKeyword, (vm, frame) => {
	vm.frames.pop();
	vm.push(thisValue(frame.scope));
});

// --- super references ------------------------------------------------------------------------------
// `super.x` / `super[k]` read from [[HomeObject]].[[Prototype]] with the current `this` as receiver
// (so inherited getters see the instance); `super.x = v` sets with that receiver (an inherited setter
// runs, otherwise the property lands on `this`).

function superBase(scope: Scope): object {
	const home = scope.getHomeObject();
	if (home == null) throw new SyntaxError("'super' keyword unexpected here");
	const base = Object.getPrototypeOf(home);
	if (base == null) throw new TypeError("Cannot read properties of null (super)");
	return base;
}

function superGet(scope: Scope, key: PropertyKey): unknown {
	const receiver = thisValue(scope); // the `this` binding is resolved first (spec order)
	return Reflect.get(superBase(scope), key, receiver);
}

function superSet(scope: Scope, key: PropertyKey, value: unknown): void {
	const receiver = thisValue(scope);
	if (!Reflect.set(superBase(scope), key, value, receiver)) throw new TypeError(`Cannot assign to read only property '${keyText(key)}'`);
}

const isSuperRef = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
	(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.kind === K.SuperKeyword;

/** One step of a read-modify-write on a super reference (see superReadModifyWrite). */
type RmwStep = { kind: "need-rhs" } | { kind: "done"; result: unknown } | { kind: "store"; value: unknown; result: unknown };

/**
 * `super.x = v` / `super[k] op= v` / `super.x++`: the `this` binding is checked before the key
 * expression; the current value is read (when `readFirst`) before any RHS; the RHS is evaluated
 * only when `compute` asks for it; the store goes through superSet (an inherited setter runs).
 */
function superReadModifyWrite(vm: VM, frame: Frame, target: ts.PropertyAccessExpression | ts.ElementAccessExpression, readFirst: boolean, compute: (current: unknown, rhs: { value: unknown } | undefined) => RmwStep, rhs?: ts.Expression): void {
	const isElem = ts.isElementAccessExpression(target);
	if (frame.phase === 0) {
		thisValue(frame.scope);
		if (isElem) {
			vm.pushNode(target.argumentExpression, frame.scope);
			frame.phase = 1;
			return;
		}
		frame.key = target.name.text;
		frame.phase = 2;
	} else if (frame.phase === 1) {
		frame.key = toPropertyKey(vm.pop());
		frame.phase = 2;
	}
	if (frame.phase === 2) {
		if (readFirst) frame.current = superGet(frame.scope, frame.key as PropertyKey);
		const step = compute(frame.current, undefined);
		if (step.kind === "need-rhs") {
			vm.pushNode(rhs as ts.Expression, frame.scope);
			frame.phase = 3;
			return;
		}
		vm.frames.pop();
		if (step.kind === "store") superSet(frame.scope, frame.key as PropertyKey, step.value);
		return vm.push(step.result);
	}
	const step = compute(frame.current, { value: vm.pop() });
	vm.frames.pop();
	if (step.kind === "store") superSet(frame.scope, frame.key as PropertyKey, step.value);
	vm.push(step.kind === "need-rhs" ? undefined : step.result);
}

const unwrapParens = (e: ts.Expression): ts.Expression => {
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e;
};

// `new.target` (undefined in a plain call, the constructor under `new`); `import.meta` is a module
// concept this program-runner doesn't model.
on(K.MetaProperty, (vm, frame) => {
	const node = frame.node as ts.MetaProperty;
	if (node.keywordToken !== K.NewKeyword || node.name.text !== "target") unimplemented(`${ts.SyntaxKind[node.keywordToken]}.${node.name.text}`);
	vm.frames.pop();
	vm.push(frame.scope.getNewTarget());
});

// Type-only wrappers: evaluate the inner expression, ignore the type.
const passThroughExpr: Handler = (vm, frame) => {
	const node = frame.node as ts.ParenthesizedExpression | ts.AsExpression | ts.TypeAssertion | ts.NonNullExpression | ts.SatisfiesExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop(); // inner value already on the stack
	}
};
on(K.ParenthesizedExpression, passThroughExpr);
on(K.AsExpression, passThroughExpr);
on(K.TypeAssertionExpression, passThroughExpr);
on(K.NonNullExpression, passThroughExpr);
on(K.SatisfiesExpression, passThroughExpr);

// ============================================================================
// Templates, arrays, objects
// ============================================================================

on(K.TemplateExpression, (vm, frame) => {
	const node = frame.node as ts.TemplateExpression;
	if (frame.phase === 0) {
		frame.base = vm.values.length; // depth *now* — earlier siblings are already on the stack
		for (let i = node.templateSpans.length - 1; i >= 0; i--) {
			vm.pushNode(node.templateSpans[i].expression, frame.scope);
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.base as number);
		let out = node.head.text;
		for (let i = 0; i < node.templateSpans.length; i++) {
			out += String(values[i]) + node.templateSpans[i].literal.text;
		}
		vm.frames.pop();
		vm.push(out);
	}
});

on(K.ArrayLiteralExpression, (vm, frame) => {
	const node = frame.node as ts.ArrayLiteralExpression;
	if (frame.phase === 0) {
		frame.base = vm.values.length;
		// Elisions (`[1, , 3]`) are OmittedExpressions: they produce no operand and leave a hole.
		for (let i = node.elements.length - 1; i >= 0; i--) {
			const el = node.elements[i];
			if (ts.isOmittedExpression(el)) continue;
			vm.pushNode(ts.isSpreadElement(el) ? el.expression : el, frame.scope);
		}
		frame.phase = 1;
	} else {
		const raw = vm.values.splice(frame.base as number);
		const out = new vm.realm.Array() as unknown[];
		let cursor = 0;
		let index = 0; // elements are *defined* (CreateDataProperty): an inherited setter on an index never runs
		for (const el of node.elements) {
			if (ts.isOmittedExpression(el)) index++;
			else if (ts.isSpreadElement(el)) for (const v of raw[cursor++] as Iterable<unknown>) defineData(out, index++, v);
			else defineData(out, index++, raw[cursor++]);
		}
		out.length = index;
		vm.frames.pop();
		vm.push(out);
	}
});

on(K.ObjectLiteralExpression, (vm, frame) => {
	const node = frame.node as ts.ObjectLiteralExpression;
	if (frame.phase === 0) {
		frame.base = vm.values.length;
		// Evaluate value-producing properties (in reverse). Methods/accessors produce no operand —
		// their functions are created in the build phase.
		// Source order per property: its computed key (if any), then its value. Pushed in reverse, the
		// key expression goes on top of its own value expression.
		for (let i = node.properties.length - 1; i >= 0; i--) {
			const prop = node.properties[i];
			if (ts.isPropertyAssignment(prop)) vm.pushNode(prop.initializer, frame.scope);
			else if (ts.isShorthandPropertyAssignment(prop)) vm.pushNode(prop.name, frame.scope);
			else if (ts.isSpreadAssignment(prop)) vm.pushNode(prop.expression, frame.scope);
			else if (!ts.isMethodDeclaration(prop) && !ts.isGetAccessorDeclaration(prop) && !ts.isSetAccessorDeclaration(prop)) {
				unimplemented(`${ts.SyntaxKind[(prop as ts.Node).kind]} in ObjectLiteral`);
			}
			const name = (prop as { name?: ts.PropertyName }).name;
			if (name !== undefined && ts.isComputedPropertyName(name)) vm.pushNode(name.expression, frame.scope);
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.base as number);
		const obj = new vm.realm.Object() as Record<PropertyKey, unknown>;
		let cursor = 0; // advances over the evaluated keys and values, in source order
		const keyOf = (name: ts.PropertyName): PropertyKey => (ts.isComputedPropertyName(name) ? toPropertyKey(values[cursor++]) : propertyName(name));
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) {
				// `__proto__: v` (non-computed) sets the prototype instead of defining a property.
				if (!ts.isComputedPropertyName(prop.name) && propertyName(prop.name) === "__proto__") {
					const value = values[cursor++];
					if (value === null || typeof value === "object" || typeof value === "function") Object.setPrototypeOf(obj, value);
					continue;
				}
				const key = keyOf(prop.name);
				const value = values[cursor++];
				defineData(obj, key, nameAnonymous(value, key, prop.initializer));
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				defineData(obj, prop.name.text, values[cursor++]);
			} else if (ts.isSpreadAssignment(prop)) {
				spreadInto(vm, obj, values[cursor++]); // own enumerable props, each through the guard
			} else if (ts.isMethodDeclaration(prop)) {
				const key = keyOf(prop.name);
				const fn = createGuestFunction(vm, prop, frame.scope, obj);
				setFunctionName(fn, key);
				Object.defineProperty(obj, key, { value: fn, writable: true, enumerable: true, configurable: true });
			} else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
				const key = keyOf(prop.name);
				const fn = createGuestFunction(vm, prop, frame.scope, obj);
				setFunctionName(fn, key, ts.isGetAccessorDeclaration(prop) ? "get" : "set");
				// An accessor replaces an earlier data property of the same name (and vice versa).
				const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(obj, key) ?? {}), enumerable: true, configurable: true };
				delete desc.value;
				delete desc.writable;
				if (ts.isGetAccessorDeclaration(prop)) desc.get = fn as () => unknown;
				else desc.set = fn as (v: unknown) => void;
				Object.defineProperty(obj, key, desc);
			}
		}
		vm.frames.pop();
		vm.push(obj);
	}
});

/** GetValue on a member reference. A primitive base is boxed in the GUEST realm (its
 *  `String.prototype`, not the host's — `"".constructor === String` must hold for the guest's
 *  `String`), with the primitive itself as the receiver for getters. Same-realm: a plain read. */
function getProperty(vm: VM, obj: unknown, key: PropertyKey): unknown {
	if (vm.realm.Object !== Object && typeof obj !== "object" && typeof obj !== "function") return Reflect.get(vm.realm.Object(obj) as object, key, obj);
	return (obj as Record<PropertyKey, unknown>)[key];
}

/** PutValue on a member reference (strict): a primitive base finds a guest-realm setter or throws. */
function setProperty(vm: VM, obj: unknown, key: PropertyKey, value: unknown): void {
	if (vm.realm.Object !== Object && typeof obj !== "object" && typeof obj !== "function") {
		if (!Reflect.set(vm.realm.Object(obj) as object, key, value, obj)) throw new TypeError(`Cannot create property '${keyText(key)}' on ${typeof obj} '${String(obj)}'`);
		return;
	}
	(obj as Record<PropertyKey, unknown>)[key] = value;
}

/** CreateDataProperty — an object literal *defines* properties; assignment would run inherited
 *  setters (notably `__proto__`, which a computed `["__proto__"]` key must not trigger). */
function defineData(obj: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** `{ ...source }`: copy own enumerable props (string + symbol keys), each value through the guard. */
function spreadInto(vm: VM, target: Record<PropertyKey, unknown>, source: unknown): void {
	if (source == null) return;
	const src = Object(source) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(src)) {
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) defineData(target, key, vm.fromHost(src[key]));
	}
}

function propertyName(name: ts.PropertyName | ts.Identifier): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	if (ts.isBigIntLiteral(name)) return String(BigInt(name.text.slice(0, -1))); // `{ 1n: v }` → "1"
	if (ts.isPrivateIdentifier(name)) return name.text;
	unimplemented(`computed/other property name (${ts.SyntaxKind[name.kind]})`);
}

// ============================================================================
// Member access
// ============================================================================

// --- optional chains --------------------------------------------------------------------------------
// When a `?.` link finds a nullish base, the *entire chain* is undefined and the remaining links —
// including their index expressions and call arguments — are not evaluated. Links propagate a
// marker; the outermost link of the chain turns it into `undefined`. (A parenthesized sub-chain
// `(a?.b).c` is its own chain: `.c` on undefined throws, as it should.)
const CHAIN_BREAK: unique symbol = Symbol("tsval.optional-chain-short-circuit");

function chainShort(node: ts.Node): unknown {
	const parent = node.parent;
	const continues = parent !== undefined && ts.isOptionalChain(parent) && (parent as { expression?: ts.Node }).expression === node;
	return continues ? CHAIN_BREAK : undefined;
}

/** Describe a property key for an error message without invoking user code (`toString` may throw). */
function keyText(key: unknown): string {
	if (typeof key === "symbol") return key.description ?? "Symbol()";
	if (typeof key === "string" || typeof key === "number" || typeof key === "boolean" || key == null) return String(key);
	return "<computed key>";
}

on(K.PropertyAccessExpression, (vm, frame) => {
	const node = frame.node as ts.PropertyAccessExpression;
	if (node.expression.kind === K.SuperKeyword) {
		vm.frames.pop();
		return void vm.push(vm.fromHost(superGet(frame.scope, node.name.text)));
	}
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const obj = vm.pop();
		vm.frames.pop();
		if (obj === CHAIN_BREAK || (obj == null && node.questionDotToken)) return vm.push(chainShort(node));
		if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${node.name.text}')`);
		if (ts.isPrivateIdentifier(node.name)) return vm.push(privateGet(obj, lookupPrivate(frame.scope, node.name.text)));
		// Every property read is a host→guest crossing (e.g. `[].constructor.constructor` is the real
		// `Function`): route it through the guard.
		vm.push(vm.fromHost(getProperty(vm, obj, node.name.text)));
	}
});

on(K.ElementAccessExpression, (vm, frame) => {
	const node = frame.node as ts.ElementAccessExpression;
	if (node.expression.kind === K.SuperKeyword) {
		if (frame.phase === 0) {
			vm.pushNode(node.argumentExpression, frame.scope);
			frame.phase = 1;
		} else {
			const key = toPropertyKey(vm.pop());
			vm.frames.pop();
			vm.push(vm.fromHost(superGet(frame.scope, key)));
		}
		return;
	}
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const obj = vm.values[vm.values.length - 1];
		if (obj === CHAIN_BREAK || (obj == null && node.questionDotToken)) {
			// short-circuit before the index expression is evaluated
			vm.pop();
			vm.frames.pop();
			return vm.push(chainShort(node));
		}
		vm.pushNode(node.argumentExpression, frame.scope);
		frame.phase = 2;
	} else {
		const index = vm.pop();
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${keyText(index)}')`);
		vm.push(vm.fromHost(getProperty(vm, obj, index as PropertyKey)));
	}
});

// ============================================================================
// Unary
// ============================================================================

on(K.PrefixUnaryExpression, (vm, frame) => {
	const node = frame.node as ts.PrefixUnaryExpression;
	// ++/-- need an lvalue, handled without a normal operand eval.
	if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) {
		return updateExpression(vm, frame, node.operand, node.operator, /* prefix */ true);
	}
	if (frame.phase === 0) {
		vm.pushNode(node.operand, frame.scope);
		frame.phase = 1;
		return;
	}
	const v = vm.pop() as never;
	vm.frames.pop();
	switch (node.operator) {
		case K.PlusToken:
			return vm.push(+v);
		case K.MinusToken:
			return vm.push(-v);
		case K.TildeToken:
			return vm.push(~v);
		case K.ExclamationToken:
			return vm.push(!v);
		default:
			unimplemented(`prefix operator ${ts.SyntaxKind[node.operator]}`);
	}
});

on(K.PostfixUnaryExpression, (vm, frame) => {
	const node = frame.node as ts.PostfixUnaryExpression;
	return updateExpression(vm, frame, node.operand, node.operator, /* prefix */ false);
});

// ++/-- on a simple identifier lvalue (member lvalues: S2).
function updateExpression(vm: VM, frame: Frame, operand: ts.Expression, operator: ts.SyntaxKind, prefix: boolean): void {
	const delta = operator === K.PlusPlusToken ? 1 : -1;
	operand = unwrapParens(operand);
	if (isSuperRef(operand)) {
		return superReadModifyWrite(vm, frame, operand, true, (current) => {
			const old = toNumeric(current);
			return { kind: "store", value: stepBy(old, delta), result: prefix ? stepBy(old, delta) : old };
		});
	}
	if (ts.isIdentifier(operand)) {
		vm.frames.pop();
		const old = toNumeric(frame.scope.get(operand.text));
		frame.scope.set(operand.text, stepBy(old, delta));
		return void vm.push(prefix ? stepBy(old, delta) : old);
	}
	if (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) {
		const isElem = ts.isElementAccessExpression(operand);
		if (frame.phase === 0) {
			vm.pushNode(operand.expression, frame.scope);
			frame.phase = 1;
		} else if (frame.phase === 1 && isElem) {
			vm.pushNode((operand as ts.ElementAccessExpression).argumentExpression, frame.scope);
			frame.phase = 2;
		} else {
			const key = isElem ? (vm.pop() as PropertyKey) : (operand as ts.PropertyAccessExpression).name.text;
			const obj = vm.pop() as Record<PropertyKey, unknown>;
			const pn = !isElem && ts.isPrivateIdentifier((operand as ts.PropertyAccessExpression).name) ? lookupPrivate(frame.scope, key as string) : undefined;
			const old = toNumeric(pn !== undefined ? privateGet(obj, pn) : obj[key]);
			if (pn !== undefined) privateSet(obj, pn, stepBy(old, delta));
			else obj[key] = stepBy(old, delta);
			vm.frames.pop();
			vm.push(prefix ? stepBy(old, delta) : old);
		}
		return;
	}
	unimplemented(`++/-- on ${ts.SyntaxKind[operand.kind]}`);
}

on(K.TypeOfExpression, (vm, frame) => {
	const node = frame.node as ts.TypeOfExpression;
	if (frame.phase === 0) {
		// `typeof undeclaredVar` (also parenthesized) must not throw; guard identifier reads.
		const inner = unwrapParens(node.expression);
		if (ts.isIdentifier(inner) && !frame.scope.has(inner.text)) {
			vm.frames.pop();
			return vm.push("undefined");
		}
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const v = vm.pop();
		vm.frames.pop();
		vm.push(typeof v);
	}
});

// `delete obj.p` / `delete obj[k]` (strict: a non-configurable property throws, via the host). Any
// other operand is evaluated for effect and yields true. `delete identifier` is a strict-mode
// SyntaxError (parser).
on(K.DeleteExpression, (vm, frame) => {
	const node = frame.node as ts.DeleteExpression;
	const target = node.expression;
	const isProp = ts.isPropertyAccessExpression(target);
	const isElem = ts.isElementAccessExpression(target);
	if (isSuperRef(target)) {
		// `delete super.x` is a ReferenceError (after evaluating a computed key, which we skip).
		vm.frames.pop();
		throw new ReferenceError("Unsupported reference to 'super'");
	}
	if (frame.phase === 0) {
		vm.pushNode(isProp || isElem ? (target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression : target, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (isElem) {
			vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
			frame.phase = 2;
			return;
		}
		const obj = vm.pop();
		vm.frames.pop();
		if (!isProp) return vm.push(true);
		if (obj == null) {
			if ((target as ts.PropertyAccessExpression).questionDotToken) return vm.push(true);
			throw new TypeError(`Cannot convert undefined or null to object`);
		}
		vm.push(delete (obj as Record<string, unknown>)[(target as ts.PropertyAccessExpression).name.text]);
	} else {
		const key = vm.pop() as PropertyKey;
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) {
			if ((target as ts.ElementAccessExpression).questionDotToken) return vm.push(true);
			throw new TypeError(`Cannot convert undefined or null to object`);
		}
		vm.push(delete (obj as Record<PropertyKey, unknown>)[key]);
	}
});

// Tagged templates: `tag\`a${x}b\`` → tag(strings, x) where `strings` is the cooked-strings array with
// a frozen `.raw`, cached per callsite (the spec's template object registry).
const templateObjects = new WeakMap<ts.Node, readonly string[]>();
function templateObject(vm: VM, node: ts.TaggedTemplateExpression): readonly string[] {
	let strings = templateObjects.get(node);
	if (strings === undefined) {
		const cooked = new vm.realm.Array() as string[];
		const raw = new vm.realm.Array() as string[];
		const add = (lit: ts.TemplateLiteralLikeNode): void => {
			cooked.push(lit.text);
			raw.push(lit.rawText ?? lit.text);
		};
		if (ts.isNoSubstitutionTemplateLiteral(node.template)) add(node.template);
		else {
			add(node.template.head);
			for (const span of node.template.templateSpans) add(span.literal);
		}
		Object.defineProperty(cooked, "raw", { value: Object.freeze(raw), enumerable: false }); // GetTemplateObject: non-enumerable
		strings = Object.freeze(cooked);
		templateObjects.set(node, strings);
	}
	return strings;
}

on(K.TaggedTemplateExpression, (vm, frame) => {
	const node = frame.node as ts.TaggedTemplateExpression;
	const tag = node.tag;
	const isProp = ts.isPropertyAccessExpression(tag);
	const spans = ts.isTemplateExpression(node.template) ? node.template.templateSpans : [];
	if (frame.phase === 0) {
		vm.pushNode(isProp ? (tag as ts.PropertyAccessExpression).expression : tag, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (isProp) {
			const obj = vm.pop();
			frame.thisArg = obj;
			if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${(tag as ts.PropertyAccessExpression).name.text}')`);
			vm.push(vm.fromHost((obj as Record<string, unknown>)[(tag as ts.PropertyAccessExpression).name.text]));
		} else {
			frame.thisArg = undefined;
		}
		for (let i = spans.length - 1; i >= 0; i--) vm.pushNode(spans[i].expression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const substitutions = vm.values.splice(vm.values.length - spans.length);
		const calleeVal = vm.pop();
		const args = [templateObject(vm, node), ...substitutions];
		if (isGuestFunction(calleeVal)) {
			vm.pushCall(calleeVal.__tsval, args, frame.thisArg);
			frame.phase = 3;
			return;
		}
		vm.frames.pop();
		if (typeof calleeVal !== "function") throw new TypeError(`${describe(tag)} is not a function`);
		vm.push(vm.invokeHost(calleeVal as (...a: unknown[]) => unknown, frame.thisArg, args, node as unknown as ts.CallExpression, false));
	} else {
		vm.frames.pop();
	}
});

on(K.VoidExpression, (vm, frame) => {
	const node = frame.node as ts.VoidExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		vm.pop();
		vm.frames.pop();
		vm.push(undefined);
	}
});

// ============================================================================
// Suspension: yield / await (machine suspension, ASSIGNMENT §3)
// ============================================================================
//
// `yield` and `await` suspend the current fiber by setting `vm.paused` and stashing the pause payload
// in `vm.pauseValue`. The fiber driver (VM.createGenerator / VM.callAsync) stops, hands control out,
// and on resume feeds a value back via `vm.sentValue` (or injects a return/throw signal). Left as a
// frame at phase 2, the suspension point resumes exactly where it left off.

on(K.YieldExpression, (vm, frame) => {
	const node = frame.node as ts.YieldExpression;
	if (node.asteriskToken) return yieldStar(vm, frame, node);
	if (frame.phase === 0) {
		if (node.expression) {
			vm.pushNode(node.expression, frame.scope);
			frame.phase = 1;
		} else {
			suspend(vm, frame, "yield", undefined, 2);
		}
	} else if (frame.phase === 1) {
		suspend(vm, frame, "yield", vm.pop(), 2);
	} else {
		vm.frames.pop();
		vm.push(vm.fromHost(vm.sentValue)); // `.next(v)` comes from the host caller
		vm.sentValue = undefined;
	}
});

/** Park the current frame at `resumePhase` and suspend the fiber with a payload of the given kind. */
function suspend(vm: VM, frame: Frame, kind: "yield" | "await", value: unknown, resumePhase: number, raw = false): void {
	vm.pauseValue = value;
	vm.pauseKind = kind;
	vm.pauseRaw = raw;
	vm.paused = true;
	frame.phase = resumePhase;
}

/** Take the value fed back in on resume (the `.next(v)` argument / the settled awaited value). */
function resumed(vm: VM): unknown {
	const value = vm.fromHost(vm.sentValue);
	vm.sentValue = undefined;
	return value;
}

/** The guest function whose body `scope` belongs to (arrows are transparent), if any. */
function enclosingFunctionMeta(scope: Scope): GuestFunctionMeta | undefined {
	for (let s: Scope | undefined = scope; s; s = s.parent) if (s.functionMeta !== undefined) return s.functionMeta as GuestFunctionMeta;
	return undefined;
}

/** GetIterator(async): `@@asyncIterator` via GetMethod (present-but-not-callable is a TypeError, not a
 *  fallback), else the sync iterator — and either result must be an object. */
function getAsyncOrSyncIterator(vm: VM, iterable: unknown): { record: IterRecord; sync: boolean } {
	if (iterable == null) throw new TypeError(`${String(iterable)} is not async iterable`);
	const asyncFactory = (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
	if (asyncFactory != null) {
		if (typeof asyncFactory !== "function") throw new TypeError("Symbol.asyncIterator is not a function");
		const iterator = (asyncFactory as () => unknown).call(iterable);
		if (!isObjectLike(iterator)) throw new TypeError("Result of the Symbol.asyncIterator method is not an object");
		return { record: { iterator: iterator as object, next: (iterator as { next?: unknown }).next }, sync: false };
	}
	return { record: getIterator(vm, iterable), sync: true };
}

/** GetMethod: undefined/null → absent; otherwise must be callable. */
function getMethod(obj: unknown, name: string): ((...a: unknown[]) => unknown) | undefined {
	const fn = (obj as Record<string, unknown>)[name];
	if (fn == null) return undefined;
	if (typeof fn !== "function") throw new TypeError(`${name} is not a function`);
	return fn as (...a: unknown[]) => unknown;
}

type Received = { kind: "next" | "throw" | "return"; value: unknown };

/**
 * `yield* iterable` — the spec's delegation loop (14.4.14 / AsyncGeneratorYield):
 * - each resumption of the outer generator is forwarded to the inner iterator: `next(v)`, or
 *   `throw(e)` / `return(v)` (via GetMethod: a missing `throw` closes the iterator and throws a
 *   TypeError; a missing `return` returns from the *outer* generator);
 * - every inner result must be an object; `done` and `value` are read (their getters may throw);
 * - a sync generator yields the inner result object *as-is*; an async generator awaits inner results
 *   (a sync inner iterator is adapted), then awaits the value before yielding it;
 * - the expression's own value is the inner iterator's completion value.
 * The fiber driver routes `throw`/`return` to this frame (`frame.delegating`) instead of unwinding.
 */
function yieldStar(vm: VM, frame: Frame, node: ts.YieldExpression): void {
	const meta = enclosingFunctionMeta(frame.scope);
	const asyncGen = meta?.isAsync === true && meta.isGenerator;
	switch (frame.phase) {
		case 0:
			vm.pushNode(node.expression as ts.Expression, frame.scope);
			frame.phase = 1;
			return;
		case 1: {
			const iterable = vm.pop();
			const record = asyncGen ? getAsyncOrSyncIterator(vm, iterable).record : getIterator(vm, iterable);
			frame.iterRecord = record;
			frame.iterator = record.iterator;
			frame.received = { kind: "next", value: undefined } satisfies Received;
			frame.phase = 2;
			return;
		}
		case 2: {
			// Dispatch the received completion to the inner iterator.
			const it = frame.iterator as Record<string, unknown>;
			const received = frame.received as Received;
			let innerResult: unknown;
			if (received.kind === "next") {
				innerResult = iterNext(frame.iterRecord as IterRecord, received.value);
			} else if (received.kind === "throw") {
				const throwMethod = getMethod(it, "throw");
				if (throwMethod === undefined) {
					closeIterator(it as unknown as Iterator<unknown>, false, false);
					throw new TypeError("The iterator does not provide a 'throw' method");
				}
				innerResult = throwMethod.call(it, received.value);
			} else {
				const returnMethod = getMethod(it, "return");
				if (returnMethod === undefined) {
					vm.frames.pop();
					return void vm.raise({ type: "return", value: received.value }); // the outer generator returns
				}
				innerResult = returnMethod.call(it, received.value);
				frame.returning = true;
			}
			if (asyncGen) return suspend(vm, frame, "await", innerResult, 3);
			return delegateResult(vm, frame, innerResult, false);
		}
		case 3:
			return delegateResult(vm, frame, resumed(vm), true); // the awaited inner result (async)
		case 6:
			// async: the inner value has been awaited (AsyncGeneratorYield) — now yield it
			frame.delegating = true;
			return suspend(vm, frame, "yield", resumed(vm), 4);
		case 4: {
			// Resumed after a yield: either a forwarded throw/return (routed by the driver) or next(v).
			frame.delegating = false;
			const injected = frame.received as Received | undefined;
			frame.received = injected !== undefined && injected.kind !== "next" ? injected : ({ kind: "next", value: resumed(vm) } satisfies Received);
			frame.phase = 2;
			return;
		}
		case 5:
			vm.frames.pop();
			vm.push(frame.result);
			return;
	}
}

function delegateResult(vm: VM, frame: Frame, innerResult: unknown, asyncGen: boolean): void {
	if (!isObjectLike(innerResult)) throw new TypeError("Iterator result is not an object");
	const returning = frame.returning === true;
	frame.returning = false;
	const result = innerResult as { done?: unknown; value?: unknown };
	if (result.done) {
		const value = result.value; // (getter may throw)
		if (returning) {
			vm.frames.pop();
			return void vm.raise({ type: "return", value }); // inner returned → the outer generator returns
		}
		frame.result = vm.fromHost(value);
		frame.phase = 5;
		return;
	}
	if (asyncGen) return suspend(vm, frame, "await", result.value, 6);
	// sync: yield the inner result object itself (GeneratorYield(innerResult)), never re-wrapped.
	frame.received = undefined;
	frame.delegating = true;
	suspend(vm, frame, "yield", innerResult, 4, /* raw */ true);
}

on(K.AwaitExpression, (vm, frame) => {
	const node = frame.node as ts.AwaitExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		suspend(vm, frame, "await", vm.pop(), 2);
	} else {
		vm.frames.pop();
		vm.push(vm.fromHost(vm.sentValue)); // the resolved value of a (host) promise enters guest land
		vm.sentValue = undefined;
	}
});

// ============================================================================
// Binary & conditional
// ============================================================================

const LOGICAL = new Set<number>([K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken]);
const ASSIGN = new Set<number>([
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
	if (op === K.InKeyword && ts.isPrivateIdentifier(node.left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const obj = vm.pop();
			vm.frames.pop();
			vm.push(privateHas(obj, lookupPrivate(frame.scope, node.left.text)));
		}
		return;
	}
	if (op === K.EqualsToken) return assignmentExpression(vm, frame, node);
	if (ASSIGN.has(op)) return compoundAssignment(vm, frame, node, op);
	if (LOGICAL.has(op)) return logicalExpression(vm, frame, node, op);

	// Plain binary: evaluate both operands, then combine.
	if (frame.phase === 0) {
		vm.pushNode(node.left, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 2;
	} else {
		const right = vm.pop() as never;
		const left = vm.pop() as never;
		vm.frames.pop();
		vm.push(applyBinary(op, left, right));
	}
});

function logicalExpression(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
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

function assignmentExpression(vm: VM, frame: Frame, node: ts.BinaryExpression): void {
	// A parenthesized target `(x) = v` / `(o.p) = v` is still a Reference (but not an IdentifierRef:
	// no NamedEvaluation through parentheses).
	const left = unwrapParens(node.left);
	if (ts.isIdentifier(left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const value = left === node.left ? nameAnonymous(vm.pop(), left.text, node.right) : vm.pop();
			frame.scope.set(left.text, value);
			vm.frames.pop();
			vm.push(value);
		}
		return;
	}
	if (isSuperRef(left)) {
		return superReadModifyWrite(vm, frame, left, false, (_current, rhs) => (rhs === undefined ? { kind: "need-rhs" } : { kind: "store", value: rhs.value, result: rhs.value }), node.right);
	}
	if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
		return memberAssignment(vm, frame, left, node.right);
	}
	// Destructuring assignment: `[a, b] = x`, `({ x } = o)`. Evaluate the RHS (stepped), then assign
	// into the (possibly nested) targets synchronously.
	if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else if (frame.phase === 1) {
			const value = vm.pop();
			if (assignNeedsStepping(left)) {
				// The pattern frame runs above; the expression's value (the RHS) is already in place.
				vm.push(value);
				frame.phase = 2;
				pushPattern(vm, frame.scope, assignProgram(left), value);
				return;
			}
			assignPattern(vm, frame.scope, left, value);
			vm.frames.pop();
			vm.push(value);
		} else {
			vm.frames.pop();
		}
		return;
	}
	unimplemented(`assignment target ${ts.SyntaxKind[left.kind]}`);
}

/** Assign `value` into an assignment target expression (existing lvalues, possibly a pattern). */
function assignPattern(vm: VM, scope: Scope, target: ts.Expression, value: unknown): void {
	target = unwrapParens(target);
	if (ts.isIdentifier(target)) return scope.set(target.text, value);
	if (ts.isPropertyAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope);
		if (ts.isPrivateIdentifier(target.name)) return privateSet(obj, lookupPrivate(scope, target.name.text), value);
		if (obj == null) throw new TypeError(`Cannot set properties of ${String(obj)} (setting '${target.name.text}')`);
		(obj as Record<string, unknown>)[target.name.text] = value;
		return;
	}
	if (ts.isElementAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope) as Record<PropertyKey, unknown>;
		obj[vm.evalNodeSync(target.argumentExpression, scope) as PropertyKey] = value;
		return;
	}
	if (ts.isArrayLiteralExpression(target)) {
		const steps = iterationSteps(getIterator(vm, value));
		try {
			for (const element of target.elements) {
				if (ts.isOmittedExpression(element)) {
					steps.step();
				} else if (ts.isSpreadElement(element)) {
					const prepared = prepareAssignTarget(vm, scope, element.expression); // reference first
					const rest = new vm.realm.Array() as unknown[];
					for (let r = steps.step(); !r.done; r = steps.step()) defineData(rest, rest.length, r.value);
					storePrepared(vm, scope, prepared, rest);
				} else {
					// Spec order: evaluate the target *reference* (a member's object/key), then IteratorStep,
					// then a default if the value is undefined, then PutValue.
					const prepared = prepareAssignTarget(vm, scope, element);
					storePrepared(vm, scope, prepared, steps.step().value);
				}
			}
		} catch (error) {
			steps.close(true);
			throw error;
		}
		steps.close(false);
		return;
	}
	if (ts.isObjectLiteralExpression(target)) {
		if (value == null) throw new TypeError(`Cannot destructure '${String(value)}' as it is ${String(value)}.`);
		const used = new Set<PropertyKey>();
		for (const prop of target.properties) {
			if (ts.isSpreadAssignment(prop)) {
				const prepared = prepareAssignTarget(vm, scope, prop.expression);
				const rest = new vm.realm.Object();
				copyRestProperties(vm, rest, value, used);
				storePrepared(vm, scope, prepared, rest);
			} else if (ts.isPropertyAssignment(prop)) {
				const key = memberKey(vm, prop.name, scope);
				used.add(key);
				const prepared = prepareAssignTarget(vm, scope, prop.initializer); // reference before GetV
				storePrepared(vm, scope, prepared, vm.fromHost((value as Record<PropertyKey, unknown>)[key]));
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				const key = prop.name.text;
				used.add(key);
				let v = vm.fromHost((value as Record<string, unknown>)[key]);
				if (v === undefined && prop.objectAssignmentInitializer) v = nameAnonymous(vm.evalNodeSync(prop.objectAssignmentInitializer, scope), key, prop.objectAssignmentInitializer);
				scope.set(key, v);
			} else {
				unimplemented(`assignment pattern property ${ts.SyntaxKind[prop.kind]}`);
			}
		}
		return;
	}
	unimplemented(`assignment pattern target ${ts.SyntaxKind[target.kind]}`);
}

// An assignment-pattern element: a target (identifier / member / nested pattern) possibly with a
// default (`a = 1` inside a pattern parses as a BinaryExpression with `=`). The target *reference* is
// evaluated before the value is fetched (spec), so member targets are resolved eagerly here.
interface PreparedTarget {
	kind: "id" | "member" | "pattern";
	target: ts.Expression;
	init?: ts.Expression;
	name?: string;
	obj?: object;
	key?: PropertyKey;
	pn?: PrivateName;
}

function prepareAssignTarget(vm: VM, scope: Scope, element: ts.Expression): PreparedTarget {
	let target = element;
	let init: ts.Expression | undefined;
	if (ts.isBinaryExpression(element) && element.operatorToken.kind === K.EqualsToken) {
		target = element.left;
		init = element.right;
	}
	target = unwrapParens(target);
	if (ts.isIdentifier(target)) return { kind: "id", target, init, name: target.text };
	if (ts.isPropertyAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope);
		if (obj == null) throw new TypeError(`Cannot set properties of ${obj} (setting '${target.name.text}')`);
		const pn = ts.isPrivateIdentifier(target.name) ? lookupPrivate(scope, target.name.text) : undefined;
		return { kind: "member", target, init, obj: obj as object, key: target.name.text, pn };
	}
	if (ts.isElementAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope);
		const key = toPropertyKey(vm.evalNodeSync(target.argumentExpression, scope));
		if (obj == null) throw new TypeError(`Cannot set properties of ${obj} (setting '${keyText(key)}')`);
		return { kind: "member", target, init, obj: obj as object, key };
	}
	return { kind: "pattern", target, init };
}

function storePrepared(vm: VM, scope: Scope, t: PreparedTarget, value: unknown): void {
	if (value === undefined && t.init !== undefined) value = namedIf(vm.evalNodeSync(t.init, scope), t.target, t.init);
	if (t.kind === "id") scope.set(t.name as string, value);
	else if (t.kind === "member") {
		if (t.pn !== undefined) privateSet(t.obj, t.pn, value);
		else (t.obj as Record<PropertyKey, unknown>)[t.key as PropertyKey] = value;
	} else assignPattern(vm, scope, t.target, value);
}

function memberAssignment(vm: VM, frame: Frame, target: ts.PropertyAccessExpression | ts.ElementAccessExpression, right: ts.Expression): void {
	const isElement = ts.isElementAccessExpression(target);
	if (frame.phase === 0) {
		vm.pushNode(target.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 && isElement) {
		vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 1 || frame.phase === 2) {
		vm.pushNode(right, frame.scope);
		frame.phase = 3;
	} else {
		const value = vm.pop();
		const key = isElement ? (vm.pop() as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.pop() as Record<PropertyKey, unknown>;
		if (!isElement && ts.isPrivateIdentifier((target as ts.PropertyAccessExpression).name)) privateSet(obj, lookupPrivate(frame.scope, key as string), value);
		else setProperty(vm, obj, key, value);
		vm.frames.pop();
		vm.push(value);
	}
}

/** For `&&=` / `||=` / `??=`: does the current value already decide the result (RHS not evaluated)? */
function logicalShortCircuits(op: number, current: unknown): boolean {
	if (op === K.AmpersandAmpersandEqualsToken) return !current;
	if (op === K.BarBarEqualsToken) return Boolean(current);
	if (op === K.QuestionQuestionEqualsToken) return current != null;
	return false;
}

// Spec order for `lhs op= rhs`: the LHS *reference* is evaluated, then GetValue (a TDZ or null-base
// error surfaces here, before the RHS runs), then the RHS — and a logical assignment doesn't run the
// RHS at all when the current value decides.
function compoundAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
	const left = unwrapParens(node.left);
	if (ts.isIdentifier(left)) {
		const name = left.text;
		if (frame.phase === 0) {
			const current = frame.scope.get(name); // GetValue before the RHS
			if (logicalShortCircuits(op, current)) {
				vm.frames.pop();
				return vm.push(current);
			}
			frame.current = current;
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			// (a logical assignment `x ??= () => {}` names the function `x`; harmless for arithmetic ops)
			const right = nameAnonymous(vm.pop(), name, node.right) as never;
			const result = applyCompound(op, frame.current as never, right);
			frame.scope.set(name, result);
			vm.frames.pop();
			vm.push(result);
		}
		return;
	}
	if (isSuperRef(left)) {
		return superReadModifyWrite(
			vm,
			frame,
			left,
			true,
			(current, rhs) => {
				if (rhs === undefined) return logicalShortCircuits(op, current) ? { kind: "done", result: current } : { kind: "need-rhs" };
				const result = applyCompound(op, current as never, rhs.value as never);
				return { kind: "store", value: result, result };
			},
			node.right,
		);
	}
	if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
		return memberCompoundAssignment(vm, frame, left, node.right, op);
	}
	unimplemented(`compound assignment to ${ts.SyntaxKind[left.kind]}`);
}

// `obj.p op= rhs` / `obj[k] op= rhs`: the object (and key) reference is evaluated once.
function memberCompoundAssignment(vm: VM, frame: Frame, target: ts.PropertyAccessExpression | ts.ElementAccessExpression, right: ts.Expression, op: number): void {
	const isElem = ts.isElementAccessExpression(target);
	const privateNameOf = (): PrivateName | undefined => (!isElem && ts.isPrivateIdentifier((target as ts.PropertyAccessExpression).name) ? lookupPrivate(frame.scope, (target as ts.PropertyAccessExpression).name.text) : undefined);
	if (frame.phase === 0) {
		vm.pushNode(target.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 && isElem) {
		vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 1 || frame.phase === 2) {
		// GetValue before the RHS (the object and key stay on the stack for the store).
		const n = vm.values.length;
		const key = isElem ? (vm.values[n - 1] as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.values[isElem ? n - 2 : n - 1];
		if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${keyText(key)}')`);
		const pn = privateNameOf();
		const current = pn !== undefined ? privateGet(obj, pn) : vm.fromHost((obj as Record<PropertyKey, unknown>)[key]);
		if (logicalShortCircuits(op, current)) {
			vm.values.length = isElem ? n - 2 : n - 1;
			vm.frames.pop();
			return vm.push(current);
		}
		frame.current = current;
		vm.pushNode(right, frame.scope);
		frame.phase = 3;
	} else {
		const right = vm.pop() as never;
		const key = isElem ? (vm.pop() as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.pop() as Record<PropertyKey, unknown>;
		const pn = privateNameOf();
		const result = applyCompound(op, frame.current as never, right);
		if (pn !== undefined) privateSet(obj, pn, result);
		else obj[key] = result;
		vm.frames.pop();
		vm.push(result);
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

// ============================================================================
// Function expressions
// ============================================================================

const makeFunction: Handler = (vm, frame) => {
	const node = frame.node as ts.FunctionExpression | ts.ArrowFunction;
	vm.frames.pop();
	vm.push(createGuestFunction(vm, node, frame.scope));
};
on(K.FunctionExpression, makeFunction);
on(K.ArrowFunction, makeFunction);

// ============================================================================
// Calls
// ============================================================================

on(K.CallExpression, (vm, frame) => {
	const node = frame.node as ts.CallExpression;
	// A parenthesized member callee `(a.b)()` is still a Reference: `this` is preserved.
	let callee: ts.Expression = node.expression;
	while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
	if (callee.kind === K.SuperKeyword) return superCall(vm, frame, node);
	if (callee.kind === K.ImportKeyword) {
		// dynamic import(specifier) → Promise of the module namespace.
		if (frame.phase === 0) {
			vm.pushNode(node.arguments[0], frame.scope);
			frame.phase = 1;
		} else {
			const specifier = vm.pop();
			vm.frames.pop();
			vm.push(Promise.resolve(vm.importModule(String(specifier))));
		}
		return;
	}
	const isProp = ts.isPropertyAccessExpression(callee);
	const isElem = ts.isElementAccessExpression(callee);
	// `super.method()` / `super[k]()` — call the super-prototype method with the current `this`.
	const isSuperProp = isProp && (callee as ts.PropertyAccessExpression).expression.kind === K.SuperKeyword;
	const isSuperElem = isElem && (callee as ts.ElementAccessExpression).expression.kind === K.SuperKeyword;

	if (frame.phase === 0 && isSuperProp) {
		frame.thisArg = thisValue(frame.scope);
		vm.push(superGet(frame.scope, (callee as ts.PropertyAccessExpression).name.text));
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 0 && isSuperElem) {
		vm.pushNode((callee as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 5;
	} else if (frame.phase === 5) {
		const key = toPropertyKey(vm.pop());
		frame.thisArg = thisValue(frame.scope);
		vm.push(superGet(frame.scope, key));
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 0) {
		// Evaluate the callee (its object first, for method calls, to capture `this`).
		vm.pushNode(isProp || isElem ? (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression : callee, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (isElem) {
			// obj is on the stack; a nullish base under `?.` short-circuits before the index is evaluated.
			const obj = vm.values[vm.values.length - 1];
			if (obj === CHAIN_BREAK || (obj == null && (callee as ts.ElementAccessExpression).questionDotToken)) {
				vm.pop();
				vm.frames.pop();
				return vm.push(chainShort(node));
			}
			vm.pushNode((callee as ts.ElementAccessExpression).argumentExpression, frame.scope);
			frame.phase = 2;
			return;
		}
		if (isProp) {
			const obj = vm.pop();
			frame.thisArg = obj;
			const name = (callee as ts.PropertyAccessExpression).name;
			if (obj === CHAIN_BREAK || (obj == null && (callee as ts.PropertyAccessExpression).questionDotToken)) return void (vm.frames.pop(), vm.push(chainShort(node)));
			if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${name.text}')`);
			if (ts.isPrivateIdentifier(name)) vm.push(privateGet(obj, lookupPrivate(frame.scope, name.text)));
			else vm.push(getProperty(vm, obj, name.text));
		} else {
			frame.thisArg = undefined;
		}
		// `f?.()` on a nullish callee (or a broken chain) short-circuits before the arguments run.
		const calleeValue = vm.values[vm.values.length - 1];
		if (calleeValue === CHAIN_BREAK || (calleeValue == null && node.questionDotToken)) return void (vm.pop(), vm.frames.pop(), vm.push(chainShort(node)));
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 2) {
		const index = vm.pop();
		const obj = vm.pop();
		frame.thisArg = obj;
		if (obj == null) throw new TypeError(`Cannot read properties of ${obj} (reading '${keyText(index)}')`);
		vm.push(getProperty(vm, obj, index as PropertyKey));
		const calleeValue = vm.values[vm.values.length - 1];
		if (calleeValue === CHAIN_BREAK || (calleeValue == null && node.questionDotToken)) return void (vm.pop(), vm.frames.pop(), vm.push(chainShort(node)));
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 3) {
		const args = collectCallArguments(vm, frame);
		const calleeVal = vm.pop();

		if (isGuestFunction(calleeVal)) {
			const meta = calleeVal.__tsval;
			// Generator / async calls produce a generator object / Promise instead of running the body
			// on the main stack (they run as suspendable fibers).
			if (meta.isGenerator && meta.isAsync) {
				vm.frames.pop();
				return vm.push(vm.createAsyncGenerator(meta, frame.thisArg, args));
			}
			if (meta.isGenerator) {
				vm.frames.pop();
				return vm.push(vm.createGenerator(meta, frame.thisArg, args));
			}
			if (meta.isAsync) {
				vm.frames.pop();
				return vm.push(vm.callAsync(meta, frame.thisArg, args));
			}
			vm.pushCall(meta, args, frame.thisArg);
			frame.phase = 4; // resume after the call returns its value
			return;
		}
		vm.frames.pop();
		if (typeof calleeVal !== "function") {
			if (node.questionDotToken && calleeVal == null) return vm.push(undefined);
			throw new TypeError(`${describe(node.expression)} is not a function`);
		}
		// Through the host guard (vets the callable, sanitizes the result) with the callsite exposed so a
		// capability shim can introspect the static type of its argument (type-directed canary, S6).
		vm.push(vm.invokeHost(calleeVal as (...a: unknown[]) => unknown, frame.thisArg, args, node, false));
	} else {
		// phase 4: guest call has left its return value on the stack.
		vm.frames.pop();
	}
});

// Evaluate call/new arguments left-to-right (pushed in reverse). A spread argument's operand is
// evaluated like any other; `spreadMask` records which operands to flatten when collecting.
function pushCallArguments(vm: VM, frame: Frame, args: readonly ts.Expression[]): void {
	const spreadMask: boolean[] = [];
	for (let i = args.length - 1; i >= 0; i--) {
		const arg = args[i];
		if (ts.isSpreadElement(arg)) {
			vm.pushNode(arg.expression, frame.scope);
			spreadMask[i] = true;
		} else {
			vm.pushNode(arg, frame.scope);
			spreadMask[i] = false;
		}
	}
	frame.argCount = args.length;
	frame.spreadMask = spreadMask;
}

function collectCallArguments(vm: VM, frame: Frame): unknown[] {
	const argCount = frame.argCount as number;
	const raw = vm.values.splice(vm.values.length - argCount);
	const spreadMask = frame.spreadMask as boolean[];
	const args: unknown[] = [];
	for (let i = 0; i < argCount; i++) {
		if (spreadMask[i]) args.push(...(raw[i] as Iterable<unknown>));
		else args.push(raw[i]);
	}
	return args;
}

// NewExpression: construct with evaluated args.
on(K.NewExpression, (vm, frame) => {
	const node = frame.node as ts.NewExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		pushCallArguments(vm, frame, node.arguments ?? []);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const args = collectCallArguments(vm, frame);
		const ctor = vm.pop();
		if (typeof ctor !== "function") throw new TypeError(`${describe(node.expression)} is not a constructor`);
		if (isGuestClass(ctor)) {
			// Construct a guest class on the explicit stack (steppable; super() supported).
			vm.pushFrame({ kind: "construct", node: null, phase: 0, scope: vm.rootScope, valuesBase: vm.values.length, ctor, args, isNew: true, newTarget: ctor });
			frame.phase = 3;
			return;
		}
		vm.frames.pop();
		vm.push(vm.invokeHost(ctor as (...a: unknown[]) => unknown, undefined, args, node, true));
	} else {
		vm.frames.pop(); // phase 3: guest construction left the instance on the stack
	}
});

// ============================================================================
// Classes
// ============================================================================

interface ClassMeta {
	node: ts.ClassLikeDeclaration;
	closure: Scope;
	superClass: unknown;
	proto: object;
	ctorNode?: ts.ConstructorDeclaration;
	/** public (`name`) or private (`privateName`) instance fields, in source order. */
	instanceFields: { name?: PropertyKey; privateName?: PrivateName; initializer?: ts.Expression }[];
	/** private methods/accessors installed on each instance before its fields initialize. */
	instancePrivateMethods: PrivateName[];
}

// ============================================================================
// Private names (#x)
// ============================================================================
//
// A private name is created fresh per class *evaluation* (a unique symbol) and resolved lexically —
// nearest enclosing class that declares it. Private elements live in a side table keyed by object
// (never as properties: they're invisible to reflection), and every access is a brand check: an
// object the class didn't initialize throws a TypeError.

export interface PrivateName {
	key: symbol;
	/** `#x`, as written (for messages and `Function.name`). */
	description: string;
	kind: "field" | "method" | "accessor";
	isStatic: boolean;
	method?: unknown;
	get?: unknown;
	set?: unknown;
}

interface PrivateEntry {
	pn: PrivateName;
	value?: unknown;
}

const privateElements = new WeakMap<object, Map<symbol, PrivateEntry>>();

function isObjectLike(v: unknown): v is object {
	return (typeof v === "object" && v !== null) || typeof v === "function";
}

function lookupPrivate(scope: Scope, name: string): PrivateName {
	for (let s: Scope | undefined = scope; s; s = s.parent) {
		const pn = s.privateNames?.get(name);
		if (pn !== undefined) return pn as PrivateName;
	}
	return unimplemented(`unbound private name ${name} (a parse-time error in valid code)`);
}

function privateEntry(obj: unknown, pn: PrivateName, verb: string): PrivateEntry {
	if (!isObjectLike(obj)) throw new TypeError(`Cannot ${verb} private member ${pn.description} from a non-object`);
	const entry = privateElements.get(obj)?.get(pn.key);
	if (entry === undefined) throw new TypeError(`Cannot ${verb} private member ${pn.description} from an object whose class did not declare it`);
	return entry;
}

function privateGet(obj: unknown, pn: PrivateName): unknown {
	const entry = privateEntry(obj, pn, "read");
	if (pn.kind === "field") return entry.value;
	if (pn.kind === "method") return pn.method;
	if (typeof pn.get !== "function") throw new TypeError(`'${pn.description}' was defined without a getter`);
	return (pn.get as (this: unknown) => unknown).call(obj);
}

function privateSet(obj: unknown, pn: PrivateName, value: unknown): void {
	const entry = privateEntry(obj, pn, "write");
	if (pn.kind === "field") {
		entry.value = value;
		return;
	}
	if (pn.kind === "method") throw new TypeError(`Private method '${pn.description}' is not writable`);
	if (typeof pn.set !== "function") throw new TypeError(`'${pn.description}' was defined without a setter`);
	(pn.set as (this: unknown, v: unknown) => void).call(obj, value);
}

function privateHas(obj: unknown, pn: PrivateName): boolean {
	if (!isObjectLike(obj)) throw new TypeError("Cannot use 'in' operator to search for a private field in a non-object");
	return privateElements.get(obj)?.has(pn.key) === true;
}

/** PrivateFieldAdd / PrivateMethodOrAccessorAdd: brand the object with this private name. */
function privateAdd(obj: object, pn: PrivateName, value?: unknown): void {
	let map = privateElements.get(obj);
	if (map === undefined) privateElements.set(obj, (map = new Map()));
	if (map.has(pn.key)) throw new TypeError(`Cannot initialize ${pn.description} twice on the same object`);
	map.set(pn.key, { pn, value });
}

/** Fork support: a cloned object keeps its private state (values cloned, names shared). */
export function clonePrivateElements(from: object, to: object, cloneValue: (v: unknown) => unknown): void {
	const map = privateElements.get(from);
	if (map === undefined) return;
	const copy = new Map<symbol, PrivateEntry>();
	for (const [key, entry] of map) copy.set(key, { pn: entry.pn, value: cloneValue(entry.value) });
	privateElements.set(to, copy);
}

interface GuestClass {
	new (...args: unknown[]): unknown;
	prototype: object;
}

/** IsConstructor, without calling anything: `Reflect.construct` validates its newTarget up front. */
function isConstructor(value: unknown): boolean {
	if (typeof value !== "function") return false;
	try {
		Reflect.construct(String, [], value as new () => unknown);
		return true;
	} catch {
		return false;
	}
}

/** The brand for guest classes — a side table, never a property (own-property lists are observable). */
const CLASS_META = new WeakMap<object, ClassMeta>();

export function isGuestClass(value: unknown): value is GuestClass {
	return typeof value === "function" && CLASS_META.has(value);
}

function classMetaOf(ctor: GuestClass): ClassMeta {
	return CLASS_META.get(ctor) as ClassMeta;
}

function hasStatic(member: ts.ClassElement): boolean {
	const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
	return (modifiers ?? []).some((m) => m.kind === K.StaticKeyword);
}

function memberKey(vm: VM, name: ts.PropertyName | undefined, scope: Scope): PropertyKey {
	if (name === undefined) return "";
	if (ts.isComputedPropertyName(name)) return toPropertyKey(vm.evalNodeSync(name.expression, scope));
	return propertyName(name);
}

/** Private names are created up front (fresh per class evaluation, BEFORE the heritage and computed
 *  keys evaluate — they may mention them) so every member, including initializers and methods that
 *  run later, resolves them lexically through the class scope. Idempotent per scope. */
function declarePrivateNames(node: ts.ClassLikeDeclaration, scope: Scope): Map<string, object> {
	if (scope.privateNames !== undefined) return scope.privateNames;
	const privateNames = new Map<string, object>();
	scope.privateNames = privateNames;
	for (const member of node.members) {
		const name = (member as { name?: ts.Node }).name;
		if (name === undefined || !ts.isPrivateIdentifier(name)) continue;
		if (privateNames.has(name.text)) continue; // a get/set pair shares one name
		const kind: PrivateName["kind"] = ts.isPropertyDeclaration(member) ? "field" : ts.isMethodDeclaration(member) ? "method" : "accessor";
		privateNames.set(name.text, { key: Symbol(name.text), description: name.text, kind, isStatic: hasStatic(member) } satisfies PrivateName);
	}
	return privateNames;
}

/** What the stepped class handler evaluated up front: the class scope, the `extends` value and the
 *  raw computed key values (source order). Without it (host-initiated builds) they are evaluated here. */
interface PreEvaluatedClass {
	scope: Scope;
	superClass: unknown;
	keys: unknown[];
}

export function createGuestClass(vm: VM, node: ts.ClassLikeDeclaration, outerScope: Scope, pre?: PreEvaluatedClass): GuestClass {
	assertSupportedClassSurface(node);
	// The class body sees an inner, immutable binding of its own name (so static initializers,
	// `static {}` blocks and methods can refer to it — also for a *named class expression*, whose name
	// is visible only inside). It is in the TDZ while the `extends` expression evaluates and is
	// initialized once the constructor exists.
	const scope = pre?.scope ?? new Scope(outerScope, false);
	if (pre === undefined && node.name) scope.declareLexical(node.name.text, "const");
	const heritage = node.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);
	const superClass = pre !== undefined ? pre.superClass : heritage ? vm.evalNodeSync(heritage.types[0].expression, scope) : undefined;
	if (heritage && superClass !== null && typeof superClass !== "function") throw new TypeError(`Class extends value ${String(superClass)} is not a constructor or null`);
	if (typeof superClass === "function") {
		// IsConstructor first (an arrow / async / generator / bound-arrow parent is a TypeError before its
		// `prototype` is ever read), then the prototype must be an object (a function counts) or null.
		if (!isConstructor(superClass)) throw new TypeError("Class extends value is not a constructor or null");
		const parentProto = (superClass as { prototype?: unknown }).prototype;
		if (parentProto !== null && typeof parentProto !== "object" && typeof parentProto !== "function") throw new TypeError(`Class extends value does not have valid prototype property ${String(parentProto)}`);
	}
	const proto = superClass === null ? Object.create(null) : superClass !== undefined ? Object.create((superClass as GuestClass).prototype) : new vm.realm.Object();
	const meta: ClassMeta = { node, closure: scope, superClass, proto, instanceFields: [], instancePrivateMethods: [] };
	const privateNames = declarePrivateNames(node, scope);
	const privateOf = (member: ts.ClassElement): PrivateName | undefined => {
		const name = (member as { name?: ts.Node }).name;
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
		if (privateOf(member) !== undefined) continue;
		if (isStaticCtorMethod(member)) memberKeys.set(member, "constructor");
		else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isPropertyDeclaration(member)) {
			const key = pre !== undefined && ts.isComputedPropertyName(member.name) ? toPropertyKey(pre.keys[computedIndex++]) : memberKey(vm, member.name, scope);
			memberKeys.set(member, key);
		}
	}
	const keyOf = (member: ts.ClassElement): PropertyKey => memberKeys.get(member) as PropertyKey;

	const Ctor = function (this: unknown, ...args: unknown[]): unknown {
		// Host-initiated construction (rare); guest `new` uses the explicit construct frame.
		if (new.target === undefined) throw new TypeError(`Class constructor ${node.name?.text ?? ""} cannot be invoked without 'new'`);
		return vm.constructGuestSync(Ctor as unknown as GuestClass, args);
	} as unknown as GuestClass;
	CLASS_META.set(Ctor, meta);
	Ctor.prototype = proto;
	Object.defineProperty(proto, "constructor", { value: Ctor, enumerable: false, writable: true, configurable: true });
	Object.setPrototypeOf(Ctor, typeof superClass === "function" ? superClass : vm.realm.Function.prototype);
	// Always set: an anonymous class expression is `""`, and V8 would otherwise infer the host
	// variable's name ("Ctor") — observable via `.name`.
	Object.defineProperty(Ctor, "name", { value: node.name?.text ?? "", configurable: true });
	if (node.name) scope.initialize(node.name.text, Ctor); // leaves the TDZ

	// Pass 1 — methods and accessors (public and private, instance and static), and the constructor.
	// Spec order: all methods exist before any static field initializer or static block runs.
	const staticPrivateInstalled = new Set<symbol>();
	for (const member of node.members) {
		const target = hasStatic(member) ? (Ctor as unknown as object) : proto;
		const pn = privateOf(member);
		if (isStaticCtorMethod(member) || ts.isMethodDeclaration(member)) {
			const fn = createGuestFunction(vm, member, scope, target);
			if (pn !== undefined) {
				pn.method = fn;
				if (pn.isStatic) privateAdd(Ctor as unknown as object, pn);
				else meta.instancePrivateMethods.push(pn);
			} else {
				const key = keyOf(member);
				setFunctionName(fn, key);
				Object.defineProperty(target, key, { value: fn, enumerable: false, writable: true, configurable: true });
			}
		} else if (ts.isConstructorDeclaration(member)) {
			if (member.body) meta.ctorNode = member;
		} else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			const fn = createGuestFunction(vm, member, scope, target);
			if (pn !== undefined) {
				if (ts.isGetAccessorDeclaration(member)) pn.get = fn;
				else pn.set = fn;
				if (pn.isStatic) {
					if (!staticPrivateInstalled.has(pn.key)) privateAdd(Ctor as unknown as object, pn);
				} else if (!meta.instancePrivateMethods.includes(pn)) meta.instancePrivateMethods.push(pn);
				staticPrivateInstalled.add(pn.key);
			} else {
				const key = keyOf(member);
				setFunctionName(fn, key, ts.isGetAccessorDeclaration(member) ? "get" : "set");
				const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(target, key) ?? {}), enumerable: false, configurable: true };
				delete desc.value;
				delete desc.writable;
				if (ts.isGetAccessorDeclaration(member)) desc.get = fn as () => unknown;
				else desc.set = fn as (v: unknown) => void;
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
				if (pn === undefined && key === "prototype") throw new TypeError("Classes may not have a static property named 'prototype'");
				const value = member.initializer ? nameAnonymous(vm.evalNodeSync(member.initializer, fieldScope(meta, Ctor, Ctor as object)), key, member.initializer) : undefined;
				if (pn !== undefined) privateAdd(Ctor as unknown as object, pn, value);
				else defineData(Ctor, key, value);
			} else if (pn !== undefined) {
				meta.instanceFields.push({ privateName: pn, initializer: member.initializer });
			} else {
				meta.instanceFields.push({ name: keyOf(member), initializer: member.initializer });
			}
		} else if (ts.isClassStaticBlockDeclaration(member)) {
			// `static { … }` runs at definition time, in source order with static fields, `this` = the class.
			vm.evalNodeSync(member.body, fieldScope(meta, Ctor, Ctor as object));
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
function assertSupportedClassSurface(node: ts.ClassLikeDeclaration): void {
	const refuse = (what: string): never => unimplemented(`${what} (out of scope: not standard / not erasable TypeScript)`);
	if ((ts.getDecorators(node) ?? []).length > 0) refuse("class decorators");
	for (const member of node.members) {
		if (ts.canHaveDecorators(member) && (ts.getDecorators(member) ?? []).length > 0) refuse("member decorators");
		if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) {
			for (const param of member.parameters) {
				if ((ts.getDecorators(param) ?? []).length > 0) refuse("parameter decorators");
				if (ts.isConstructorDeclaration(member) && ts.isParameterPropertyDeclaration(param, member)) refuse("parameter properties");
			}
		}
	}
}

// A scope for evaluating a field/static initializer, with `this` and [[HomeObject]] bound.
function fieldScope(meta: ClassMeta, thisVal: unknown, homeObject: object): Scope {
	const s = new Scope(meta.closure, true);
	s.hasThis = true;
	s.thisVal = thisVal;
	s.homeObject = homeObject;
	s.classMeta = meta;
	return s;
}

function initInstanceFields(vm: VM, meta: ClassMeta, instance: object): void {
	// Private methods/accessors brand the instance first (so field initializers may call them).
	for (const pn of meta.instancePrivateMethods) privateAdd(instance, pn);
	for (const field of meta.instanceFields) {
		const key: PropertyKey = field.privateName?.description ?? (field.name as PropertyKey);
		const value = field.initializer ? nameAnonymous(vm.evalNodeSync(field.initializer, fieldScope(meta, instance, meta.proto)), key, field.initializer) : undefined;
		if (field.privateName !== undefined) privateAdd(instance, field.privateName, value);
		else defineData(instance, key, value); // DefineField: CreateDataProperty, never an inherited setter
	}
}

/**
 * Run the parent's construction for a derived class. A guest parent runs as a `construct` frame on
 * the explicit stack (nothing returned). A **host** parent (`extends Error`, `extends Array`) must
 * *create* `this` itself, with the derived class as `new.target` so the prototype is right — the
 * spec's "`this` is uninitialized until `super()` returns" model — so the created object is returned
 * and the caller rebinds `this` to it.
 */
function pushParentConstruct(vm: VM, superClass: unknown, args: unknown[], instance: object, newTarget: unknown): object | undefined {
	if (isGuestClass(superClass)) {
		// `forSuper`: the frame leaves its final instance on the value stack — a parent constructor may
		// `return` a different object (a Proxy, say), and that is what `super()` yields as `this`.
		vm.pushFrame({ kind: "construct", node: null, phase: 0, scope: vm.rootScope, valuesBase: vm.values.length, ctor: superClass, args, instance, isNew: false, forSuper: true, newTarget });
		return undefined;
	}
	if (typeof superClass === "function") return Reflect.construct(superClass as new (...a: unknown[]) => object, args, newTarget as new (...a: unknown[]) => unknown);
	throw new TypeError("Class extends value is not a constructor or null");
}

/** The instance under construction (the nearest `construct` frame's). */
function currentConstructInstance(vm: VM): object {
	for (let i = vm.frames.length - 1; i >= 0; i--) {
		const f = vm.frames[i];
		if (f.kind === "construct") return f.instance as object;
	}
	throw new SyntaxError("'super' keyword unexpected here");
}

/** After a parent created/initialized `this`, point the constructor's `this` and the pending construct frame at it. */
function rebindThis(vm: VM, scope: Scope, replacement: object): void {
	for (let s: Scope | undefined = scope; s; s = s.parent) {
		if (s.hasThis) {
			s.thisVal = replacement;
			break;
		}
	}
	setConstructInstance(vm, replacement);
}

// `super(...)` inside a derived constructor: construct the parent on the current instance, then
// initialize this class's own instance fields (spec order), then the call yields undefined.
function superCall(vm: VM, frame: Frame, node: ts.CallExpression): void {
	if (frame.phase === 0) {
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const args = collectCallArguments(vm, frame);
		const meta = frame.scope.getClassMeta() as ClassMeta;
		const instance = currentConstructInstance(vm);
		const newTarget = frame.scope.getNewTarget();
		// Spec order: the parent constructs FIRST; binding `this` a second time is the ReferenceError
		// (so a double `super()` runs the parent twice and initializes fields once).
		if (isGuestClass(meta.superClass)) {
			// initfields runs after the parent construct frame completes (it's pushed first, below it);
			// it also binds `this` — the parent's construction is what initializes it.
			vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance, thisScope: frame.scope, fromStack: true });
			pushParentConstruct(vm, meta.superClass, args, instance, newTarget);
		} else {
			const created = pushParentConstruct(vm, meta.superClass, args, instance, newTarget) as object;
			assertThisUnbound(frame.scope);
			rebindThis(vm, frame.scope, created);
			vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance: created });
		}
		frame.phase = 2;
	} else {
		vm.frames.pop();
		vm.push(thisValue(frame.scope)); // `super()` evaluates to the now-bound `this`
	}
}

function assertThisUnbound(scope: Scope): void {
	if (scope.getThis() !== THIS_TDZ) throw new ReferenceError("Super constructor may only be called once");
}

/** The computed member keys of a class, in source order (the order they are evaluated in). */
function computedKeyNodes(node: ts.ClassLikeDeclaration): ts.Expression[] {
	const out: ts.Expression[] = [];
	for (const member of node.members) {
		const name = (member as { name?: ts.PropertyName }).name;
		if (name !== undefined && ts.isComputedPropertyName(name)) out.push(name.expression);
	}
	return out;
}

/**
 * ClassDefinitionEvaluation in two phases: the `extends` expression and every computed member key
 * are evaluated on the stepped stack — in the class scope, with the class name in its TDZ — so a
 * `yield`/`await` inside them suspends like anywhere else; then the class is built from those values.
 * Returns the constructor once built (undefined while the sub-expressions are still evaluating).
 */
function classDefinition(vm: VM, frame: Frame, node: ts.ClassLikeDeclaration): GuestClass | undefined {
	const heritage = node.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);
	if (frame.phase === 0) {
		assertSupportedClassSurface(node);
		const scope = new Scope(frame.scope, false);
		if (node.name) scope.declareLexical(node.name.text, "const");
		declarePrivateNames(node, scope);
		frame.classScope = scope;
		frame.base = vm.values.length;
		const keys = computedKeyNodes(node);
		for (let i = keys.length - 1; i >= 0; i--) vm.pushNode(keys[i], scope);
		if (heritage) vm.pushNode(heritage.types[0].expression, scope); // on top: evaluates first
		frame.phase = 1;
		return undefined;
	}
	const values = vm.values.splice(frame.base as number);
	const superClass = heritage ? values.shift() : undefined;
	return createGuestClass(vm, node, frame.scope, { scope: frame.classScope as Scope, superClass, keys: values });
}

on(K.ClassDeclaration, (vm, frame) => {
	const node = frame.node as ts.ClassDeclaration;
	const Ctor = classDefinition(vm, frame, node);
	if (Ctor === undefined) return;
	vm.frames.pop();
	if (node.name) {
		frame.scope.declareLexical(node.name.text, "let");
		frame.scope.initialize(node.name.text, Ctor);
	}
});

on(K.ClassExpression, (vm, frame) => {
	const Ctor = classDefinition(vm, frame, frame.node as ts.ClassExpression);
	if (Ctor === undefined) return;
	vm.frames.pop();
	vm.push(Ctor);
});

// ============================================================================
// enum (runtime-emit, ASSIGNMENT §4)
// ============================================================================
//
// Numeric members auto-increment from the previous numeric value and get a reverse mapping
// (E[0] === "A"); string members don't. Member initializers may reference earlier members by bare
// name or `E.member`, so they're evaluated in a scope layering the members declared so far.
on(K.EnumDeclaration, (vm, frame) => {
	const node = frame.node as ts.EnumDeclaration;
	vm.frames.pop();
	const name = node.name.text;
	const enumObject = new vm.realm.Object() as Record<string, string | number>;
	frame.scope.declareLexical(name, "const");
	frame.scope.initialize(name, enumObject); // bound first so `E.member` resolves inside initializers
	const memberScope = new Scope(frame.scope, false);

	let auto = 0;
	for (const member of node.members) {
		const key = ts.isComputedPropertyName(member.name) ? String(vm.evalNodeSync(member.name.expression, memberScope)) : propertyName(member.name);
		const value = member.initializer !== undefined ? (vm.evalNodeSync(member.initializer, memberScope) as string | number) : auto;
		enumObject[key] = value;
		if (typeof value === "number") {
			enumObject[value] = key; // reverse mapping (numeric enums only)
			auto = value + 1;
		}
		memberScope.declareLexical(key, "const");
		memberScope.initialize(key, value);
	}
});

// Synthetic construct frame: build one class level's instance on the explicit stack.
syntheticHandlers.construct = (vm, frame) => {
	const ctor = frame.ctor as GuestClass;
	const meta = classMetaOf(ctor);
	if (frame.phase === 0) {
		const instance = (frame.instance as object) ?? Object.create(ctor.prototype);
		frame.instance = instance;
		frame.derived = meta.superClass !== undefined; // (a constructor's `return` is judged in VM.unwind)
		if (meta.ctorNode) {
			const fnScope = new Scope(meta.closure, true);
			fnScope.hasThis = true;
			// Derived: `this` is uninitialized until `super()` returns (ReferenceError before that).
			fnScope.thisVal = meta.superClass !== undefined ? THIS_TDZ : instance;
			frame.ctorScope = fnScope;
			fnScope.homeObject = meta.proto;
			fnScope.classMeta = meta;
			fnScope.newTarget = frame.newTarget ?? ctor;
			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", createArgumentsObject(vm, frame.args as unknown[]));
			bindParameters(vm, fnScope, meta.ctorNode.parameters, frame.args as unknown[]);
			// Base class: fields init before the body. Derived: after super() (handled in the super call).
			if (meta.superClass === undefined) initInstanceFields(vm, meta, instance);
			hoist(vm, fnScope, (meta.ctorNode.body as ts.Block).statements);
			const body = vm.pushNode(meta.ctorNode.body as ts.Block, fnScope);
			body.reuseScope = true;
		} else if (meta.superClass !== undefined) {
			// Implicit derived constructor: super(...args), then this class's fields.
			const newTarget = frame.newTarget ?? ctor;
			if (isGuestClass(meta.superClass)) {
				vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance, fromStack: true });
				pushParentConstruct(vm, meta.superClass, frame.args as unknown[], instance, newTarget);
			} else {
				const created = pushParentConstruct(vm, meta.superClass, frame.args as unknown[], instance, newTarget) as object;
				frame.instance = created;
				vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance: created });
			}
		} else {
			initInstanceFields(vm, meta, instance);
		}
		frame.phase = 1;
	} else {
		// A derived constructor that never called super() leaves `this` uninitialized: ReferenceError.
		const ctorScope = frame.ctorScope as Scope | undefined;
		if (ctorScope !== undefined && frame.overridden !== true && ctorScope.thisVal === THIS_TDZ) throw new ReferenceError("Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
		vm.frames.pop();
		if (frame.isNew || frame.forSuper === true) vm.push(frame.instance);
	}
};

// After `super()` returns: adopt the parent's final instance (`fromStack`: left by its construct
// frame), bind `this` (leaving its TDZ), then run this class's field initializers on it.
syntheticHandlers.initfields = (vm, frame) => {
	let instance = frame.instance as object;
	if (frame.fromStack === true) instance = vm.pop() as object;
	if (frame.thisScope !== undefined) {
		assertThisUnbound(frame.thisScope as Scope);
		rebindThis(vm, frame.thisScope as Scope, instance);
	} else if (frame.fromStack === true) setConstructInstance(vm, instance);
	initInstanceFields(vm, frame.meta as ClassMeta, instance);
	vm.frames.pop();
};

/** Point the nearest pending construct frame at `instance` (what its `new` will yield). */
function setConstructInstance(vm: VM, instance: object): void {
	for (let i = vm.frames.length - 1; i >= 0; i--) {
		const f = vm.frames[i];
		if (f.kind === "construct") {
			f.instance = instance;
			return;
		}
	}
}

// Synthetic call frame: run a guest function on the explicit stack.
syntheticHandlers.call = (vm, frame) => {
	const meta = frame.meta as GuestFunctionMeta;
	const node = meta.node;
	if (frame.phase === 0) {
		const fnScope = new Scope(meta.closure, /* isolated */ true);
		if (!meta.isArrow) {
			fnScope.hasThis = true;
			fnScope.thisVal = frame.thisArg;
			if (meta.homeObject !== undefined) fnScope.homeObject = meta.homeObject;
			if (frame.newTarget !== undefined) fnScope.newTarget = frame.newTarget;
			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", createArgumentsObject(vm, frame.args as unknown[]));
		}
		bindParameters(vm, fnScope, node.parameters, frame.args as unknown[]);
		fnScope.functionMeta = meta;
		frame.scope = fnScope;
		// With non-simple parameters (defaults, patterns, rest) the body gets its own var environment:
		// a closure in a default sees the *parameter*, not a same-named `var` declared in the body.
		const bodyScope = node.parameters.some((p) => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name)) ? new Scope(fnScope, true) : fnScope;

		if (ts.isBlock(node.body!)) {
			hoist(vm, bodyScope, node.body.statements);
			// Reuse the body scope for the body block (body vars live there directly).
			const bodyFrame = vm.pushNode(node.body, bodyScope);
			bodyFrame.reuseScope = true;
			frame.phase = 1;
		} else {
			// Arrow with an expression body: value is the return value.
			vm.pushNode(node.body!, bodyScope);
			frame.phase = 2;
		}
	} else if (frame.phase === 1) {
		// Body completed with no explicit return.
		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(undefined);
	} else {
		// Arrow expression-body value is on the stack; it is the return value.
		const value = vm.pop();
		vm.frames.pop();
		vm.values.length = frame.valuesBase;
		vm.push(value);
	}
};

/** A TypeScript `this:` pseudo-parameter — types the receiver, binds nothing, takes no argument. */
function isThisParameter(param: ts.ParameterDeclaration): boolean {
	return ts.isIdentifier(param.name) && param.name.text === "this";
}

/** JS `Function.length`: params before the first default/rest, excluding a `this:` pseudo-param. */
function functionLength(params: readonly ts.ParameterDeclaration[]): number {
	let n = 0;
	for (const param of params) {
		if (isThisParameter(param)) continue;
		if (param.initializer !== undefined || param.dotDotDotToken !== undefined) break;
		n++;
	}
	return n;
}

function bindParameters(vm: VM, scope: Scope, allParams: readonly ts.ParameterDeclaration[], args: unknown[]): void {
	const params = allParams.filter((p) => !isThisParameter(p));
	// All parameter names start in the TDZ, so a default referring to itself or a later parameter
	// (`function f(a = b, b) {}`) is a ReferenceError; each binding leaves the TDZ as it's bound.
	for (const param of params) for (const name of bindingNames(param.name)) scope.declareLexical(name, "let");
	for (let i = 0; i < params.length; i++) {
		const param = params[i];
		if (param.dotDotDotToken) {
			// Rest parameter — binds the remaining args (which may themselves be destructured).
			bindTarget(vm, scope, param.name, realmArray(vm, Array.prototype.slice.call(args, i)), "param");
			return;
		}
		let value = args[i];
		if (value === undefined && param.initializer) value = namedIf(vm.evalNodeSync(param.initializer, scope), param.name, param.initializer);
		bindTarget(vm, scope, param.name, value, "param");
	}
}

// --- NamedEvaluation: an anonymous function/class takes the name it's bound or assigned to --------

/** `function () {}`, `() => {}`, `class {}` — possibly parenthesized (the cover grammar). */
function isAnonymousFunctionDefinition(node: ts.Node): boolean {
	while (ts.isParenthesizedExpression(node)) node = node.expression;
	return (ts.isFunctionExpression(node) && node.name === undefined) || ts.isArrowFunction(node) || (ts.isClassExpression(node) && node.name === undefined);
}

/** SetFunctionName's text for a property key: a symbol's description in brackets, an optional `get`/`set` prefix. */
function functionNameText(key: PropertyKey, prefix = ""): string {
	const base = typeof key === "symbol" ? (key.description === undefined ? "" : `[${key.description}]`) : String(key);
	return prefix === "" ? base : `${prefix} ${base}`;
}

/** SetFunctionName for a method/accessor defined under `key`. */
function setFunctionName(fn: GuestFunction, key: PropertyKey, prefix = ""): void {
	const text = functionNameText(key, prefix);
	Object.defineProperty(fn, "name", { value: text, configurable: true });
	fn.__tsval.name = text;
}

/** Give `value` the name `name` iff it came from an anonymous function definition `from` and has none. */
function nameAnonymous(value: unknown, name: PropertyKey, from: ts.Node | undefined): unknown {
	if (from === undefined || !isAnonymousFunctionDefinition(from)) return value;
	if (!(isGuestFunction(value) || isGuestClass(value))) return value;
	if ((value as { name?: string }).name !== "") return value;
	const text = functionNameText(name);
	Object.defineProperty(value, "name", { value: text, configurable: true });
	if (isGuestFunction(value)) value.__tsval.name = text;
	return value;
}

/** NamedEvaluation for a binding target: only a plain identifier names the value. */
function namedIf(value: unknown, target: ts.BindingName | ts.Expression, from: ts.Node | undefined): unknown {
	return ts.isIdentifier(target) ? nameAnonymous(value, target.text, from) : value;
}

/**
 * Bind a declaration target (identifier or binding pattern) to an already-computed value, declaring
 * into `scope`. The leaf sub-expressions of a pattern — default values and computed keys — are
 * evaluated synchronously (`vm.evalNodeSync`); the destructuring itself is pure.
 */
function bindIdentifier(scope: Scope, name: string, value: unknown, kind: BindingKind): void {
	if (kind === "var") {
		scope.declareVar(name);
		scope.set(name, value);
	} else {
		scope.declareLexical(name, kind);
		scope.initialize(name, value);
	}
}

export function bindTarget(vm: VM, scope: Scope, target: ts.BindingName, value: unknown, kind: BindingKind): void {
	if (ts.isIdentifier(target)) return bindIdentifier(scope, target.text, value, kind);
	if (ts.isObjectBindingPattern(target)) {
		if (value == null) throw new TypeError(`Cannot destructure '${String(value)}' as it is ${String(value)}.`);
		const used = new Set<PropertyKey>();
		for (const element of target.elements) {
			if (element.dotDotDotToken) {
				const rest = new vm.realm.Object();
				copyRestProperties(vm, rest, value, used);
				bindTarget(vm, scope, element.name, rest, kind);
				continue;
			}
			const key = element.propertyName ? bindingKey(vm, scope, element.propertyName) : (element.name as ts.Identifier).text;
			used.add(key);
			let v = vm.fromHost((value as Record<PropertyKey, unknown>)?.[key]);
			if (v === undefined && element.initializer) v = namedIf(vm.evalNodeSync(element.initializer, scope), element.name, element.initializer);
			bindTarget(vm, scope, element.name, v, kind);
		}
		return;
	}
	if (ts.isArrayBindingPattern(target)) {
		const steps = iterationSteps(getIterator(vm, value));
		try {
			for (const element of target.elements) {
				if (ts.isOmittedExpression(element)) {
					steps.step();
					continue;
				}
				if (element.dotDotDotToken) {
					const rest = new vm.realm.Array() as unknown[];
					for (let r = steps.step(); !r.done; r = steps.step()) defineData(rest, rest.length, r.value);
					bindTarget(vm, scope, element.name, rest, kind);
					continue;
				}
				let v: unknown = steps.step().value;
				if (v === undefined && element.initializer) v = namedIf(vm.evalNodeSync(element.initializer, scope), element.name, element.initializer);
				bindTarget(vm, scope, element.name, v, kind);
			}
		} catch (error) {
			steps.close(true);
			throw error;
		}
		steps.close(false);
		return;
	}
	unimplemented(`binding target ${ts.SyntaxKind[(target as ts.Node).kind]}`);
}

// ============================================================================
// Stepped destructuring
// ============================================================================
// `bindTarget`/`assignPattern` above evaluate a pattern's defaults, computed keys and member targets
// synchronously (`evalNodeSync`), which cannot suspend: `const [a = yield] = it` or
// `[o[await k]] = v` need those sub-expressions on the stepped stack. Such patterns (detected
// syntactically; or ALL patterns under `TSVAL_STEPPED_PATTERNS=1`, the parity-testing switch) are
// compiled once into a flat list of plain-data ops, run by a synthetic `pattern` frame whose state —
// pc, a temp stack, open iterator records, open source objects — lives in frame fields, so a fork
// or a snapshot mid-pattern is an ordinary frame clone. The compiled program is a class instance
// (shared by forks, never mutated). Semantics mirror the synchronous path op for op.

type PatOp =
	| { op: "eval"; node: ts.Expression } // push a node frame; its value lands on temps on resume
	| { op: "iter-open" } // temps.pop() → GetIterator → iters.push
	| { op: "iter-step" } // IteratorStep+IteratorValue → temps.push (undefined once done)
	| { op: "iter-skip" } // an elision
	| { op: "iter-rest" } // drain → temps.push(array)
	| { op: "iter-close" } // IteratorClose (normal completion) → iters.pop
	| { op: "obj-open" } // temps.pop() → RequireObjectCoercible → objs.push
	| { op: "to-key" } // temps.pop() → ToPropertyKey → keys.push
	| { op: "obj-get"; key?: PropertyKey } // GetV(source, key ?? keys.pop()) → temps.push; remembers the key for rest
	| { op: "obj-rest" } // CopyDataProperties minus the used keys → temps.push
	| { op: "obj-close" }
	| { op: "jump-if-defined"; offset: number } // default: keep a defined value and skip its initializer ops
	| { op: "name"; name: string; from: ts.Node } // NamedEvaluation of a default onto an identifier target
	| { op: "bind"; name: string; kind: BindingKind } // temps.pop() → declare/initialize
	| { op: "assign-id"; name: string } // temps.pop() → PutValue
	| { op: "member-ref"; hasKey: boolean; text: string; privateName?: string } // (key), base → reference record
	| { op: "member-store" }; // value, reference → PutValue

class PatternProgram {
	readonly ops: readonly PatOp[];
	constructor(ops: readonly PatOp[]) {
		this.ops = ops; // (an explicit field: Node's strip-only TS has no parameter properties)
	}
}

interface PatternIterator {
	record: IterRecord;
	done: boolean;
}
interface PatternSource {
	value: unknown;
	used: PropertyKey[];
}
interface MemberRef {
	obj: object;
	key: PropertyKey;
	pn?: PrivateName;
}

/** Test switch: run EVERY pattern through the stepped machine (parity with the synchronous path). */
export const patternSettings = { forceStepped: process.env.TSVAL_STEPPED_PATTERNS === "1" };

const suspensionCache = new WeakMap<ts.Node, boolean>();
/** Does a pattern contain `yield`/`await` outside nested functions/classes? */
function containsSuspension(node: ts.Node): boolean {
	let known = suspensionCache.get(node);
	if (known === undefined) {
		const walk = (n: ts.Node): boolean => {
			if (ts.isYieldExpression(n) || ts.isAwaitExpression(n)) return true;
			if (ts.isFunctionLike(n) || ts.isClassLike(n)) return false;
			return ts.forEachChild(n, walk) === true;
		};
		known = walk(node);
		suspensionCache.set(node, known);
	}
	return known;
}

export function bindingNeedsStepping(target: ts.BindingName): boolean {
	return !ts.isIdentifier(target) && (patternSettings.forceStepped || containsSuspension(target));
}
export function assignNeedsStepping(target: ts.Expression): boolean {
	return (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) && (patternSettings.forceStepped || containsSuspension(target));
}

const patternPrograms = new WeakMap<ts.Node, Map<string, PatternProgram>>();
function cachedProgram(node: ts.Node, variant: string, compile: (ops: PatOp[]) => void): PatternProgram {
	let byVariant = patternPrograms.get(node);
	if (byVariant === undefined) patternPrograms.set(node, (byVariant = new Map()));
	let program = byVariant.get(variant);
	if (program === undefined) {
		const ops: PatOp[] = [];
		compile(ops);
		byVariant.set(variant, (program = new PatternProgram(ops)));
	}
	return program;
}
export const bindingProgram = (target: ts.BindingName, kind: BindingKind): PatternProgram => cachedProgram(target, `bind:${kind}`, (ops) => compileBinding(target, kind, ops));
export const assignProgram = (target: ts.Expression): PatternProgram => cachedProgram(target, "assign", (ops) => compileAssign(target, ops));

/** Start binding `value` through `program` in `scope`: the frame runs above the caller's. */
export function pushPattern(vm: VM, scope: Scope, program: PatternProgram, value: unknown): void {
	vm.pushFrame({ kind: "pattern", node: null, phase: 0, scope, valuesBase: vm.values.length, program, pc: 0, temps: [value], iters: [], objs: [], keys: [] });
}

// --- compilation (each compiled pattern consumes temps.top) ---

function compileDefault(init: ts.Expression | undefined, nameTarget: ts.Node, ops: PatOp[]): void {
	if (init === undefined) return;
	const naming: PatOp[] = ts.isIdentifier(nameTarget) ? [{ op: "name", name: nameTarget.text, from: init }] : [];
	ops.push({ op: "jump-if-defined", offset: 1 + naming.length }, { op: "eval", node: init }, ...naming);
}

function compileKey(name: ts.PropertyName, ops: PatOp[]): void {
	if (ts.isComputedPropertyName(name)) ops.push({ op: "eval", node: name.expression }, { op: "to-key" }, { op: "obj-get" });
	else ops.push({ op: "obj-get", key: propertyName(name) });
}

function compileBinding(target: ts.BindingName, kind: BindingKind, ops: PatOp[]): void {
	if (ts.isIdentifier(target)) return void ops.push({ op: "bind", name: target.text, kind });
	if (ts.isArrayBindingPattern(target)) {
		ops.push({ op: "iter-open" });
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) {
				ops.push({ op: "iter-skip" });
			} else if (element.dotDotDotToken) {
				ops.push({ op: "iter-rest" });
				compileBinding(element.name, kind, ops);
			} else {
				ops.push({ op: "iter-step" });
				compileDefault(element.initializer, element.name, ops);
				compileBinding(element.name, kind, ops);
			}
		}
		ops.push({ op: "iter-close" });
		return;
	}
	ops.push({ op: "obj-open" });
	for (const element of target.elements) {
		if (element.dotDotDotToken) {
			ops.push({ op: "obj-rest" });
			compileBinding(element.name, kind, ops);
			continue;
		}
		compileKey(element.propertyName ?? (element.name as ts.Identifier), ops);
		compileDefault(element.initializer, element.name, ops);
		compileBinding(element.name, kind, ops);
	}
	ops.push({ op: "obj-close" });
}

/** One assignment-pattern element: the target *reference* is evaluated before the value is obtained
 *  (`emitSource`), then the default, then PutValue — the spec's order. */
function compileAssignElement(elementTarget: ts.Expression, init: ts.Expression | undefined, emitSource: () => void, ops: PatOp[]): void {
	const target = unwrapParens(elementTarget);
	if (isSuperRef(target)) unimplemented("a super reference as a destructuring target");
	const isMember = ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target);
	if (isMember) {
		ops.push({ op: "eval", node: target.expression });
		if (ts.isElementAccessExpression(target)) ops.push({ op: "eval", node: target.argumentExpression }, { op: "member-ref", hasKey: true, text: "" });
		else ops.push({ op: "member-ref", hasKey: false, text: target.name.text, privateName: ts.isPrivateIdentifier(target.name) ? target.name.text : undefined });
	}
	emitSource();
	compileDefault(init, target, ops);
	if (isMember) ops.push({ op: "member-store" });
	else compileAssign(target, ops);
}

function compileAssign(elementTarget: ts.Expression, ops: PatOp[]): void {
	const target = unwrapParens(elementTarget);
	if (ts.isIdentifier(target)) return void ops.push({ op: "assign-id", name: target.text });
	if (ts.isArrayLiteralExpression(target)) {
		ops.push({ op: "iter-open" });
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) ops.push({ op: "iter-skip" });
			else if (ts.isSpreadElement(element)) compileAssignElement(element.expression, undefined, () => ops.push({ op: "iter-rest" }), ops);
			else {
				const withDefault = ts.isBinaryExpression(element) && element.operatorToken.kind === K.EqualsToken;
				compileAssignElement(withDefault ? element.left : element, withDefault ? element.right : undefined, () => ops.push({ op: "iter-step" }), ops);
			}
		}
		ops.push({ op: "iter-close" });
		return;
	}
	if (ts.isObjectLiteralExpression(target)) {
		ops.push({ op: "obj-open" });
		for (const prop of target.properties) {
			if (ts.isSpreadAssignment(prop)) {
				compileAssignElement(prop.expression, undefined, () => ops.push({ op: "obj-rest" }), ops);
			} else if (ts.isPropertyAssignment(prop)) {
				// Key (with ToPropertyKey) first, then the target reference, then GetV.
				let source: PatOp;
				if (ts.isComputedPropertyName(prop.name)) {
					ops.push({ op: "eval", node: prop.name.expression }, { op: "to-key" });
					source = { op: "obj-get" };
				} else source = { op: "obj-get", key: propertyName(prop.name) };
				const withDefault = ts.isBinaryExpression(prop.initializer) && prop.initializer.operatorToken.kind === K.EqualsToken;
				compileAssignElement(withDefault ? prop.initializer.left : prop.initializer, withDefault ? prop.initializer.right : undefined, () => ops.push(source), ops);
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				ops.push({ op: "obj-get", key: prop.name.text });
				compileDefault(prop.objectAssignmentInitializer, prop.name, ops);
				ops.push({ op: "assign-id", name: prop.name.text });
			} else unimplemented(`assignment pattern property ${ts.SyntaxKind[prop.kind]}`);
		}
		ops.push({ op: "obj-close" });
		return;
	}
	unimplemented(`assignment pattern target ${ts.SyntaxKind[target.kind]}`);
}

// --- execution ---

/** IteratorStep + IteratorValue on an open record; a throwing iterator is marked done (no IteratorClose). */
function patternIterStep(it: PatternIterator): unknown {
	if (it.done) return undefined;
	try {
		const r = iterNext(it.record);
		if (r.done) {
			it.done = true;
			return undefined;
		}
		return r.value;
	} catch (error) {
		it.done = true;
		throw error;
	}
}

syntheticHandlers.pattern = (vm, frame) => {
	const program = frame.program as PatternProgram;
	const temps = frame.temps as unknown[];
	const iters = frame.iters as PatternIterator[];
	const objs = frame.objs as PatternSource[];
	const keys = frame.keys as PropertyKey[];
	const scope = frame.scope;
	if (frame.awaiting === true) {
		frame.awaiting = false;
		temps.push(vm.pop());
	}
	for (;;) {
		const pc = frame.pc as number;
		if (pc >= program.ops.length) return void vm.frames.pop();
		const op = program.ops[pc];
		frame.pc = pc + 1;
		switch (op.op) {
			case "eval":
				frame.awaiting = true;
				vm.pushNode(op.node, scope);
				return;
			case "iter-open":
				iters.push({ record: getIterator(vm, temps.pop()), done: false });
				break;
			case "iter-step":
				temps.push(patternIterStep(iters[iters.length - 1]));
				break;
			case "iter-skip":
				patternIterStep(iters[iters.length - 1]);
				break;
			case "iter-rest": {
				const it = iters[iters.length - 1];
				const rest = new vm.realm.Array() as unknown[];
				for (;;) {
					const v = patternIterStep(it);
					if (it.done) break;
					defineData(rest, rest.length, v);
				}
				temps.push(rest);
				break;
			}
			case "iter-close": {
				const it = iters.pop() as PatternIterator;
				closeIterator(it.record.iterator, it.done, false);
				break;
			}
			case "obj-open": {
				const value = temps.pop();
				if (value == null) throw new TypeError(`Cannot destructure '${String(value)}' as it is ${String(value)}.`);
				objs.push({ value, used: [] });
				break;
			}
			case "to-key":
				keys.push(toPropertyKey(temps.pop()));
				break;
			case "obj-get": {
				const source = objs[objs.length - 1];
				const key = op.key ?? (keys.pop() as PropertyKey);
				source.used.push(key);
				temps.push(vm.fromHost(getProperty(vm, source.value, key)));
				break;
			}
			case "obj-rest": {
				const source = objs[objs.length - 1];
				const rest = new vm.realm.Object();
				copyRestProperties(vm, rest, source.value, new Set(source.used));
				temps.push(rest);
				break;
			}
			case "obj-close":
				objs.pop();
				break;
			case "jump-if-defined":
				if (temps[temps.length - 1] !== undefined) frame.pc = (frame.pc as number) + op.offset;
				else temps.pop();
				break;
			case "name":
				temps.push(nameAnonymous(temps.pop(), op.name, op.from));
				break;
			case "bind":
				bindIdentifier(scope, op.name, temps.pop(), op.kind);
				break;
			case "assign-id":
				scope.set(op.name, temps.pop());
				break;
			case "member-ref": {
				const key = op.hasKey ? toPropertyKey(temps.pop()) : op.text;
				const obj = temps.pop();
				if (obj == null) throw new TypeError(`Cannot set properties of ${String(obj)} (setting '${keyText(key)}')`);
				const pn = op.privateName !== undefined ? lookupPrivate(scope, op.privateName) : undefined;
				temps.push({ obj, key, pn } satisfies MemberRef);
				break;
			}
			case "member-store": {
				const value = temps.pop();
				const ref = temps.pop() as MemberRef;
				if (ref.pn !== undefined) privateSet(ref.obj, ref.pn, value);
				else setProperty(vm, ref.obj, ref.key, value);
				break;
			}
		}
	}
};

/** A strict-mode `arguments` object: an array-like with the arguments as own indexed properties, a
 *  non-enumerable `length` and `@@iterator`, and a `callee` accessor that throws (strict). Unmapped —
 *  sloppy-mode parameter aliasing is out of scope. */
function createArgumentsObject(vm: VM, args: unknown[]): object {
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
function realmArray(vm: VM, list: ArrayLike<unknown>): unknown[] {
	const out = new vm.realm.Array(list.length) as unknown[];
	for (let i = 0; i < list.length; i++) defineData(out, i, list[i]);
	return out;
}

/** The spec's Iterator Record: the iterator plus its `next` method, read ONCE at GetIterator time
 *  (observable: a `next` getter fires once, and a later reassignment of `next` is not seen). */
export interface IterRecord {
	iterator: object;
	next: unknown;
}

/**
 * Iteration state for an array whose iteration is pristine (see getIterator): a PLAIN object, so a
 * fork mid-iteration clones it — a host ArrayIterator would be shared, and one fork's steps would
 * starve the other's (`exploreCanary` forks inside `for…of` bodies). Observably the same as the
 * intrinsic: each step reads `length` then the index (through any getter or Proxy trap); once
 * exhausted it stays done without reading again; results are guest-realm objects.
 */
interface ArrayIteration {
	array: ArrayLike<unknown>;
	index: number;
	done: boolean;
	Obj: ObjectConstructor;
}
const arrayIterationNext = function (this: ArrayIteration): IteratorResult<unknown> {
	const result = new this.Obj() as unknown as { value: unknown; done: boolean };
	if (!this.done) {
		const i = this.index;
		if (i < this.array.length) {
			this.index = i + 1;
			result.value = this.array[i];
			result.done = false;
			return result;
		}
		this.done = true;
	}
	result.value = undefined;
	result.done = true;
	return result;
};

/** GetIterator: a TypeError (not a property-of-null error) when the value isn't iterable. */
function getIterator(vm: VM, value: unknown): IterRecord {
	const factory = value == null ? undefined : (value as { [Symbol.iterator]?: () => Iterator<unknown> })[Symbol.iterator];
	if (typeof factory !== "function") throw new TypeError(`${value === null ? "null" : typeof value === "object" ? "object" : String(value)} is not iterable`);
	const realm = vm.realm;
	if (Array.isArray(value) && factory === realm.arrayValues && realm.arrayIteratorPrototype.next === realm.arrayIteratorNext) {
		const iteration: ArrayIteration = { array: value, index: 0, done: false, Obj: realm.Object };
		return { iterator: iteration, next: arrayIterationNext };
	}
	const iterator = factory.call(value);
	if (typeof iterator !== "object" || iterator === null) throw new TypeError("Result of the Symbol.iterator method is not an object");
	return { iterator, next: (iterator as { next?: unknown }).next };
}

/** IteratorNext: call the cached `next` (must be callable); the result must be an object. */
function iterNext(record: IterRecord, ...args: unknown[]): IteratorResult<unknown> {
	if (typeof record.next !== "function") throw new TypeError("iterator.next is not a function");
	const result = (record.next as (...a: unknown[]) => unknown).apply(record.iterator, args);
	if (typeof result !== "object" || result === null) throw new TypeError("Iterator result is not an object");
	return result as IteratorResult<unknown>;
}

/**
 * Destructuring's view of an iterator: `step()` is IteratorStep + IteratorValue with the record's
 * [[Done]] tracked — an exhausted iterator keeps answering `done` (no further `next` calls), and an
 * iterator whose `next`/`done`/`value` throws is marked done so IteratorClose is NOT attempted
 * on it (spec: the error is the iterator's own). `close(abrupt)` is IteratorClose unless done.
 */
function iterationSteps(record: IterRecord): { step(): { done: boolean; value: unknown }; close(abrupt: boolean): void } {
	let done = false;
	return {
		step() {
			if (done) return { done: true, value: undefined };
			try {
				const r = iterNext(record);
				if (r.done) {
					done = true;
					return { done: true, value: undefined };
				}
				return { done: false, value: r.value };
			} catch (error) {
				done = true;
				throw error;
			}
		},
		close(abrupt) {
			closeIterator(record.iterator, done, abrupt);
		},
	};
}

/** CopyDataProperties for an object rest: own enumerable string and symbol keys not already bound. */
function copyRestProperties(vm: VM, target: object, source: unknown, excluded: Set<PropertyKey>): void {
	const src = Object(source) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(src)) {
		if (excluded.has(key)) continue;
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) defineData(target, key, vm.fromHost(src[key]));
	}
}

/** IteratorClose: call `return()` on an iterator a pattern didn't exhaust. On an abrupt completion the
 *  original error wins over anything `return()` throws; on a normal one, `return()`'s errors surface. */
export function closeIterator(iterator: object, done: boolean, abrupt: boolean): void {
	if (done) return;
	const ret = (iterator as { return?: unknown }).return;
	if (ret == null) return;
	if (abrupt) {
		try {
			if (typeof ret === "function") (ret as () => unknown).call(iterator);
		} catch {
			/* the original error wins */
		}
		return;
	}
	if (typeof ret !== "function") throw new TypeError("iterator.return is not a function");
	const result = (ret as () => unknown).call(iterator);
	if (typeof result !== "object" || result === null) throw new TypeError("iterator.return() did not return an object");
}

/** The loop head's `let`/`const` names are in the TDZ while the iterable expression evaluates
 *  (`for (const x of x)` is a ReferenceError). */
function headTdzScope(scope: Scope, initializer: ts.ForInitializer): Scope {
	if (!ts.isVariableDeclarationList(initializer) || (initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return scope;
	const tdz = new Scope(scope, false);
	for (const decl of initializer.declarations) for (const name of bindingNames(decl.name)) tdz.declareLexical(name, "let");
	return tdz;
}

/** ToPropertyKey: a symbol stays a symbol; anything else is its string form (`{[["a"]]: 1}` → "a"). */
/** ToPrimitive: `@@toPrimitive` (must return a primitive), else OrdinaryToPrimitive by hint. */
function toPrimitive(v: unknown, hint: "string" | "number" | "default"): unknown {
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
function toNumeric(v: unknown): number | bigint {
	const primitive = toPrimitive(v, "number");
	return typeof primitive === "bigint" ? primitive : Number(primitive);
}

/** `++`/`--` on a Number or a BigInt. */
const stepBy = (old: number | bigint, delta: number): number | bigint => (typeof old === "bigint" ? old + BigInt(delta) : old + delta);

/** ToPropertyKey: ToPrimitive(hint string), then a symbol stays a symbol, anything else ToString. */
const toPropertyKey = (v: unknown): PropertyKey => {
	const primitive = toPrimitive(v, "string");
	return typeof primitive === "symbol" ? primitive : String(primitive);
};

function bindingKey(vm: VM, scope: Scope, name: ts.PropertyName): PropertyKey {
	if (ts.isComputedPropertyName(name)) return toPropertyKey(vm.evalNodeSync(name.expression, scope));
	return propertyName(name);
}

// ============================================================================
// Operator semantics
// ============================================================================

function applyBinary(op: number, left: never, right: never): unknown {
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

function applyCompound(op: number, left: never, right: never): unknown {
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

function describe(node: ts.Node): string {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return `${describe(node.expression)}.${node.name.text}`;
	return ts.SyntaxKind[node.kind];
}
