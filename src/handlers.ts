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
		name: node.name != null && ts.isIdentifier(node.name) ? node.name.text : "",
		isArrow: node.kind === K.ArrowFunction,
		isGenerator: (node as ts.FunctionLikeDeclaration).asteriskToken != null,
		isAsync: (modifierFlags & ts.ModifierFlags.Async) !== 0,
		homeObject,
	};
	const fn = function (this: unknown, ...args: unknown[]): unknown {
		// Host-invoked path (array callbacks, shims, host-mediated `new`): run a nested loop to
		// completion. `new.target` is forwarded so the body can observe construction.
		return vm.callGuestFromHost(meta, this, args, new.target);
	} as GuestFunction;
	fn.__tsval = meta;
	Object.defineProperty(fn, "length", { value: functionLength(node.parameters), configurable: true });
	if (meta.name) Object.defineProperty(fn, "name", { value: meta.name, configurable: true });
	return fn;
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
			// no initializer: `let x;` leaves the TDZ as undefined; `var x;` already undefined.
			bindTarget(vm, frame.scope, decl.name, undefined, kind);
			frame.phase += 2; // -> next decl
		}
	} else {
		bindTarget(vm, frame.scope, decl.name, vm.pop(), kind);
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
	for (const name of names) {
		next.declareLexical(name, "let");
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
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const iterable = vm.pop();
		const iterator = (iterable as Iterable<unknown>)[Symbol.iterator]();
		frame.iterator = iterator;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const result = (frame.iterator as Iterator<unknown>).next();
		if (result.done) return void vm.frames.pop();
		bindForTarget(vm, frame, node.initializer, vm.fromHost(result.value));
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
});

// `for await (x of iterable)`: an async iterator's `.next()` results are awaited; a sync iterable's
// *values* are awaited (the spec's async-from-sync adaptation). Each await suspends the enclosing
// fiber, which is what makes the loop steppable/forkable like any other.
function forAwaitOf(vm: VM, frame: Frame, node: ts.ForOfStatement): void {
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const { iterator, sync } = getAsyncOrSyncIterator(vm.pop());
		frame.iterator = iterator;
		frame.syncIterator = sync;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const step = (frame.iterator as Iterator<unknown>).next();
		if (frame.syncIterator) {
			const result = step as IteratorResult<unknown>;
			if (result.done) return void vm.frames.pop();
			suspend(vm, frame, "await", result.value, 3); // await the element itself
		} else {
			suspend(vm, frame, "await", step, 4); // await the result object
		}
	} else if (frame.phase === 3) {
		bindForTarget(vm, frame, node.initializer, resumed(vm));
		frame.phase = 5;
	} else if (frame.phase === 4) {
		const result = resumed(vm) as IteratorResult<unknown>;
		if (result.done) return void vm.frames.pop();
		bindForTarget(vm, frame, node.initializer, vm.fromHost(result.value));
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
		vm.pushNode(node.expression, frame.scope);
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
	if (ts.isVariableDeclarationList(initializer)) {
		const decl = initializer.declarations[0];
		const isConst = (initializer.flags & ts.NodeFlags.Const) !== 0;
		const isLet = (initializer.flags & ts.NodeFlags.Let) !== 0;
		bindTarget(vm, bodyScope, decl.name, value, isConst ? "const" : isLet ? "let" : "var");
	} else if (ts.isIdentifier(initializer)) {
		frame.scope.set(initializer.text, value);
	} else {
		unimplemented(`for-of/in assignment target ${ts.SyntaxKind[initializer.kind]}`);
	}
	vm.pushNode(node.statement, bodyScope);
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
	vm.push(new RegExp(node.text.slice(1, lastSlash), node.text.slice(lastSlash + 1)));
});

on(K.Identifier, (vm, frame) => {
	const node = frame.node as ts.Identifier;
	vm.frames.pop();
	// Globals are host values; guest bindings pass through the guard unchanged (identity by default).
	vm.push(vm.fromHost(frame.scope.get(node.text)));
});

on(K.ThisKeyword, (vm, frame) => {
	vm.frames.pop();
	vm.push(frame.scope.getThis());
});

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
		const spreadMask: boolean[] = [];
		for (let i = node.elements.length - 1; i >= 0; i--) {
			const el = node.elements[i];
			if (ts.isSpreadElement(el)) {
				vm.pushNode(el.expression, frame.scope);
				spreadMask[i] = true;
			} else {
				// Elisions (holes) in `[1, , 3]` parse as OmittedExpression; treat as undefined for S2.
				vm.pushNode(el, frame.scope);
				spreadMask[i] = false;
			}
		}
		frame.spreadMask = spreadMask;
		frame.phase = 1;
	} else {
		const raw = vm.values.splice(frame.base as number);
		const spreadMask = frame.spreadMask as boolean[];
		const out: unknown[] = [];
		for (let i = 0; i < raw.length; i++) {
			if (spreadMask[i]) out.push(...(raw[i] as Iterable<unknown>));
			else out.push(raw[i]);
		}
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
		for (let i = node.properties.length - 1; i >= 0; i--) {
			const prop = node.properties[i];
			if (ts.isPropertyAssignment(prop)) vm.pushNode(prop.initializer, frame.scope);
			else if (ts.isShorthandPropertyAssignment(prop)) vm.pushNode(prop.name, frame.scope);
			else if (ts.isSpreadAssignment(prop)) vm.pushNode(prop.expression, frame.scope);
			else if (!ts.isMethodDeclaration(prop) && !ts.isGetAccessorDeclaration(prop) && !ts.isSetAccessorDeclaration(prop)) {
				unimplemented(`${ts.SyntaxKind[(prop as ts.Node).kind]} in ObjectLiteral`);
			}
		}
		frame.phase = 1;
	} else {
		const values = vm.values.splice(frame.base as number);
		const obj: Record<PropertyKey, unknown> = {};
		let cursor = 0; // advances only for value-producing properties, in source order
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) {
				obj[memberKey(vm, prop.name, frame.scope)] = values[cursor++];
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				obj[prop.name.text] = values[cursor++];
			} else if (ts.isSpreadAssignment(prop)) {
				spreadInto(vm, obj, values[cursor++]); // own enumerable props, each through the guard
			} else if (ts.isMethodDeclaration(prop)) {
				Object.defineProperty(obj, memberKey(vm, prop.name, frame.scope), { value: createGuestFunction(vm, prop, frame.scope, obj), writable: true, enumerable: true, configurable: true });
			} else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
				const key = memberKey(vm, prop.name, frame.scope);
				const fn = createGuestFunction(vm, prop, frame.scope, obj);
				const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(obj, key) ?? {}), enumerable: true, configurable: true };
				if (ts.isGetAccessorDeclaration(prop)) desc.get = fn as () => unknown;
				else desc.set = fn as (v: unknown) => void;
				Object.defineProperty(obj, key, desc);
			}
		}
		vm.frames.pop();
		vm.push(obj);
	}
});

/** `{ ...source }`: copy own enumerable props (string + symbol keys), each value through the guard. */
function spreadInto(vm: VM, target: Record<PropertyKey, unknown>, source: unknown): void {
	if (source == null) return;
	const src = Object(source) as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(src)) {
		if (Object.getOwnPropertyDescriptor(src, key)?.enumerable) target[key] = vm.fromHost(src[key]);
	}
}

function propertyName(name: ts.PropertyName | ts.Identifier): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	if (ts.isPrivateIdentifier(name)) return name.text;
	unimplemented(`computed/other property name (${ts.SyntaxKind[name.kind]})`);
}

// ============================================================================
// Member access
// ============================================================================

on(K.PropertyAccessExpression, (vm, frame) => {
	const node = frame.node as ts.PropertyAccessExpression;
	if (node.expression.kind === K.SuperKeyword) {
		// `super.x` — read from the [[HomeObject]]'s prototype (bound `this` handled by the caller).
		const home = frame.scope.getHomeObject();
		const proto = home != null ? Object.getPrototypeOf(home) : undefined;
		vm.frames.pop();
		return void vm.push(vm.fromHost((proto as Record<string, unknown>)?.[node.name.text]));
	}
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else {
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) {
			if (node.questionDotToken) return vm.push(undefined);
			throw new TypeError(`Cannot read properties of ${obj} (reading '${node.name.text}')`);
		}
		// Every property read is a host→guest crossing (e.g. `[].constructor.constructor` is the real
		// `Function`): route it through the guard.
		vm.push(vm.fromHost((obj as Record<string, unknown>)[node.name.text]));
	}
});

on(K.ElementAccessExpression, (vm, frame) => {
	const node = frame.node as ts.ElementAccessExpression;
	if (frame.phase === 0) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.argumentExpression, frame.scope);
		frame.phase = 2;
	} else {
		const index = vm.pop();
		const obj = vm.pop();
		vm.frames.pop();
		if (obj == null) {
			if (node.questionDotToken) return vm.push(undefined);
			throw new TypeError(`Cannot read properties of ${obj} (reading '${String(index)}')`);
		}
		vm.push(vm.fromHost((obj as Record<PropertyKey, unknown>)[index as PropertyKey]));
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
	if (ts.isIdentifier(operand)) {
		vm.frames.pop();
		const old = Number(frame.scope.get(operand.text));
		frame.scope.set(operand.text, old + delta);
		return void vm.push(prefix ? old + delta : old);
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
			const old = Number(obj[key]);
			obj[key] = old + delta;
			vm.frames.pop();
			vm.push(prefix ? old + delta : old);
		}
		return;
	}
	unimplemented(`++/-- on ${ts.SyntaxKind[operand.kind]}`);
}

on(K.TypeOfExpression, (vm, frame) => {
	const node = frame.node as ts.TypeOfExpression;
	if (frame.phase === 0) {
		// `typeof undeclaredVar` must not throw; guard identifier reads.
		if (ts.isIdentifier(node.expression) && !frame.scope.has(node.expression.text)) {
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
function suspend(vm: VM, frame: Frame, kind: "yield" | "await", value: unknown, resumePhase: number): void {
	vm.pauseValue = value;
	vm.pauseKind = kind;
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

/** An async iterator for `iterable` (`Symbol.asyncIterator`, else its sync iterator), and which it is. */
function getAsyncOrSyncIterator(iterable: unknown): { iterator: Iterator<unknown> | AsyncIterator<unknown>; sync: boolean } {
	const asyncFactory = (iterable as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })?.[Symbol.asyncIterator];
	if (typeof asyncFactory === "function") return { iterator: asyncFactory.call(iterable), sync: false };
	return { iterator: (iterable as Iterable<unknown>)[Symbol.iterator](), sync: true };
}

// `yield* iterable`: drive the inner iterator, re-yielding each value; the `yield*` expression's own
// value is the inner iterator's completion (`return`) value. Inside an `async function*` the inner
// iterator is async (or a sync one adapted): each `.next()` result is awaited before it is re-yielded.
function yieldStar(vm: VM, frame: Frame, node: ts.YieldExpression): void {
	const meta = enclosingFunctionMeta(frame.scope);
	const asyncGen = meta?.isAsync === true && meta.isGenerator;
	if (frame.phase === 0) {
		vm.pushNode(node.expression as ts.Expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		frame.iterator = asyncGen ? getAsyncOrSyncIterator(vm.pop()).iterator : (vm.pop() as Iterable<unknown>)[Symbol.iterator]();
		frame.sent = undefined;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const step = (frame.iterator as Iterator<unknown>).next(frame.sent);
		if (asyncGen) return suspend(vm, frame, "await", step, 5); // result object arrives on resume
		settleDelegate(vm, frame, step as IteratorResult<unknown>);
	} else if (frame.phase === 5) {
		settleDelegate(vm, frame, resumed(vm) as IteratorResult<unknown>);
	} else if (frame.phase === 3) {
		frame.sent = resumed(vm);
		frame.phase = 2;
	} else {
		vm.frames.pop();
		vm.push(frame.result);
	}
}

function settleDelegate(vm: VM, frame: Frame, result: IteratorResult<unknown>): void {
	if (result.done) {
		frame.result = vm.fromHost(result.value);
		frame.phase = 4;
		return;
	}
	suspend(vm, frame, "yield", vm.fromHost(result.value), 3);
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
	// Simple identifier / member lvalues (destructuring assignment targets: S2).
	if (ts.isIdentifier(node.left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const value = vm.pop();
			frame.scope.set((node.left as ts.Identifier).text, value);
			vm.frames.pop();
			vm.push(value);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
		return memberAssignment(vm, frame, node);
	}
	// Destructuring assignment: `[a, b] = x`, `({ x } = o)`. Evaluate the RHS (stepped), then assign
	// into the (possibly nested) targets synchronously.
	if (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left)) {
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const value = vm.pop();
			assignPattern(vm, frame.scope, node.left, value);
			vm.frames.pop();
			vm.push(value);
		}
		return;
	}
	unimplemented(`assignment target ${ts.SyntaxKind[node.left.kind]}`);
}

/** Assign `value` into an assignment target expression (existing lvalues, possibly a pattern). */
function assignPattern(vm: VM, scope: Scope, target: ts.Expression, value: unknown): void {
	if (ts.isIdentifier(target)) return scope.set(target.text, value);
	if (ts.isPropertyAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope) as Record<string, unknown>;
		obj[target.name.text] = value;
		return;
	}
	if (ts.isElementAccessExpression(target)) {
		const obj = vm.evalNodeSync(target.expression, scope) as Record<PropertyKey, unknown>;
		obj[vm.evalNodeSync(target.argumentExpression, scope) as PropertyKey] = value;
		return;
	}
	if (ts.isArrayLiteralExpression(target)) {
		const iterator = (value as Iterable<unknown>)[Symbol.iterator]();
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) {
				iterator.next();
			} else if (ts.isSpreadElement(element)) {
				const rest: unknown[] = [];
				for (let r = iterator.next(); !r.done; r = iterator.next()) rest.push(r.value);
				assignPattern(vm, scope, element.expression, rest);
			} else {
				const r = iterator.next();
				assignPatternElement(vm, scope, element, r.done ? undefined : r.value);
			}
		}
		return;
	}
	if (ts.isObjectLiteralExpression(target)) {
		const used = new Set<PropertyKey>();
		for (const prop of target.properties) {
			if (ts.isSpreadAssignment(prop)) {
				const rest: Record<string, unknown> = {};
				for (const k in value as object) if (!used.has(k)) rest[k] = (value as Record<string, unknown>)[k];
				assignPattern(vm, scope, prop.expression, rest);
			} else if (ts.isPropertyAssignment(prop)) {
				const key = memberKey(vm, prop.name, scope);
				used.add(key);
				assignPatternElement(vm, scope, prop.initializer, vm.fromHost((value as Record<PropertyKey, unknown>)[key]));
			} else if (ts.isShorthandPropertyAssignment(prop)) {
				const key = prop.name.text;
				used.add(key);
				let v = vm.fromHost((value as Record<string, unknown>)[key]);
				if (v === undefined && prop.objectAssignmentInitializer) v = vm.evalNodeSync(prop.objectAssignmentInitializer, scope);
				scope.set(key, v);
			} else {
				unimplemented(`assignment pattern property ${ts.SyntaxKind[prop.kind]}`);
			}
		}
		return;
	}
	unimplemented(`assignment pattern target ${ts.SyntaxKind[target.kind]}`);
}

// A target that may carry a default (`a = 1` inside a pattern parses as a BinaryExpression with `=`).
function assignPatternElement(vm: VM, scope: Scope, element: ts.Expression, value: unknown): void {
	if (ts.isBinaryExpression(element) && element.operatorToken.kind === K.EqualsToken) {
		const v = value === undefined ? vm.evalNodeSync(element.right, scope) : value;
		return assignPattern(vm, scope, element.left, v);
	}
	assignPattern(vm, scope, element, value);
}

function memberAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression): void {
	const target = node.left as ts.PropertyAccessExpression | ts.ElementAccessExpression;
	const isElement = ts.isElementAccessExpression(target);
	if (frame.phase === 0) {
		vm.pushNode(target.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 && isElement) {
		vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 1 || frame.phase === 2) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 3;
	} else {
		const value = vm.pop();
		const key = isElement ? (vm.pop() as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.pop() as Record<PropertyKey, unknown>;
		frame.scope; // (obj mutated in place)
		obj[key] = value;
		vm.frames.pop();
		vm.push(value);
	}
}

function compoundAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
	if (ts.isIdentifier(node.left)) {
		const name = node.left.text;
		if (frame.phase === 0) {
			vm.pushNode(node.right, frame.scope);
			frame.phase = 1;
		} else {
			const right = vm.pop() as never;
			const result = applyCompound(op, frame.scope.get(name) as never, right);
			frame.scope.set(name, result);
			vm.frames.pop();
			vm.push(result);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
		return memberCompoundAssignment(vm, frame, node, op);
	}
	unimplemented(`compound assignment to ${ts.SyntaxKind[node.left.kind]}`);
}

// `obj.p op= rhs` / `obj[k] op= rhs`: the object (and key) reference is evaluated once.
function memberCompoundAssignment(vm: VM, frame: Frame, node: ts.BinaryExpression, op: number): void {
	const target = node.left as ts.PropertyAccessExpression | ts.ElementAccessExpression;
	const isElem = ts.isElementAccessExpression(target);
	if (frame.phase === 0) {
		vm.pushNode(target.expression, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 && isElem) {
		vm.pushNode((target as ts.ElementAccessExpression).argumentExpression, frame.scope);
		frame.phase = 2;
	} else if (frame.phase === 1 || frame.phase === 2) {
		vm.pushNode(node.right, frame.scope);
		frame.phase = 3;
	} else {
		const right = vm.pop() as never;
		const key = isElem ? (vm.pop() as PropertyKey) : (target as ts.PropertyAccessExpression).name.text;
		const obj = vm.pop() as Record<PropertyKey, unknown>;
		const result = applyCompound(op, obj[key] as never, right);
		obj[key] = result;
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
	const callee = node.expression;
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
	// `super.method()` — call the super-prototype method with the current `this`.
	const isSuperProp = isProp && (callee as ts.PropertyAccessExpression).expression.kind === K.SuperKeyword;

	if (frame.phase === 0 && isSuperProp) {
		const home = frame.scope.getHomeObject();
		const proto = home != null ? Object.getPrototypeOf(home) : undefined;
		frame.thisArg = frame.scope.getThis();
		vm.push((proto as Record<string, unknown>)?.[(callee as ts.PropertyAccessExpression).name.text]);
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 0) {
		// Evaluate the callee (its object first, for method calls, to capture `this`).
		vm.pushNode(isProp || isElem ? (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression : callee, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		if (isElem) {
			// obj is on the stack; evaluate the index, resolve the callee in phase 2.
			vm.pushNode((callee as ts.ElementAccessExpression).argumentExpression, frame.scope);
			frame.phase = 2;
			return;
		}
		if (isProp) {
			const obj = vm.pop();
			frame.thisArg = obj;
			if (obj == null) {
				if (node.questionDotToken) return void (vm.frames.pop(), vm.push(undefined));
				throw new TypeError(`Cannot read properties of ${obj} (reading '${(callee as ts.PropertyAccessExpression).name.text}')`);
			}
			vm.push((obj as Record<string, unknown>)[(callee as ts.PropertyAccessExpression).name.text]);
		} else {
			frame.thisArg = undefined;
		}
		pushCallArguments(vm, frame, node.arguments);
		frame.phase = 3;
	} else if (frame.phase === 2) {
		const index = vm.pop();
		const obj = vm.pop();
		frame.thisArg = obj;
		if (obj == null) {
			if (node.questionDotToken) return void (vm.frames.pop(), vm.push(undefined));
			throw new TypeError(`Cannot read properties of ${obj} (reading '${String(index)}')`);
		}
		vm.push((obj as Record<PropertyKey, unknown>)[index as PropertyKey]);
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
	instanceFields: { name: PropertyKey; initializer?: ts.Expression }[];
}

interface GuestClass {
	new (...args: unknown[]): unknown;
	prototype: object;
	__tsvalClass: ClassMeta;
}

function isGuestClass(value: unknown): value is GuestClass {
	return typeof value === "function" && (value as Partial<GuestClass>).__tsvalClass != null;
}

function hasStatic(member: ts.ClassElement): boolean {
	const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
	return (modifiers ?? []).some((m) => m.kind === K.StaticKeyword);
}

function memberKey(vm: VM, name: ts.PropertyName | undefined, scope: Scope): PropertyKey {
	if (name === undefined) return "";
	if (ts.isComputedPropertyName(name)) return vm.evalNodeSync(name.expression, scope) as PropertyKey;
	return propertyName(name);
}

export function createGuestClass(vm: VM, node: ts.ClassLikeDeclaration, outerScope: Scope): GuestClass {
	assertSupportedClassSurface(node);
	const heritage = node.heritageClauses?.find((h) => h.token === K.ExtendsKeyword);
	const superClass = heritage ? vm.evalNodeSync(heritage.types[0].expression, outerScope) : undefined;
	const proto = superClass != null ? Object.create((superClass as GuestClass).prototype) : {};
	// The class body sees an inner, immutable binding of its own name (so static initializers,
	// `static {}` blocks and methods can refer to it — also for a *named class expression*, whose name
	// is visible only inside). Bound once the constructor exists, below.
	const scope = new Scope(outerScope, false);
	const meta: ClassMeta = { node, closure: scope, superClass, proto, instanceFields: [] };

	const Ctor = function (this: unknown, ...args: unknown[]): unknown {
		// Host-initiated construction (rare); guest `new` uses the explicit construct frame.
		return vm.constructGuestSync(Ctor as unknown as GuestClass, args);
	} as unknown as GuestClass;
	(Ctor as { __tsvalClass: ClassMeta }).__tsvalClass = meta;
	Ctor.prototype = proto;
	Object.defineProperty(proto, "constructor", { value: Ctor, enumerable: false, writable: true, configurable: true });
	if (superClass != null) Object.setPrototypeOf(Ctor, superClass);
	// Always set: an anonymous class expression is `""`, and V8 would otherwise infer the host
	// variable's name ("Ctor") — observable via `.name`.
	Object.defineProperty(Ctor, "name", { value: node.name?.text ?? "", configurable: true });
	if (node.name) {
		scope.declareLexical(node.name.text, "const");
		scope.initialize(node.name.text, Ctor);
	}

	for (const member of node.members) {
		const target = hasStatic(member) ? (Ctor as unknown as object) : proto;
		if (ts.isConstructorDeclaration(member)) {
			if (member.body) meta.ctorNode = member;
		} else if (ts.isMethodDeclaration(member)) {
			const fn = createGuestFunction(vm, member, scope, target);
			Object.defineProperty(target, memberKey(vm, member.name, scope), { value: fn, enumerable: false, writable: true, configurable: true });
		} else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
			const key = memberKey(vm, member.name, scope);
			const fn = createGuestFunction(vm, member, scope, target);
			const desc: PropertyDescriptor = { ...(Object.getOwnPropertyDescriptor(target, key) ?? {}), enumerable: false, configurable: true };
			delete desc.value;
			delete desc.writable;
			if (ts.isGetAccessorDeclaration(member)) desc.get = fn as () => unknown;
			else desc.set = fn as (v: unknown) => void;
			Object.defineProperty(target, key, desc);
		} else if (ts.isPropertyDeclaration(member)) {
			const key = memberKey(vm, member.name, scope);
			if (hasStatic(member)) {
				(Ctor as unknown as Record<PropertyKey, unknown>)[key] = member.initializer ? vm.evalNodeSync(member.initializer, fieldScope(meta, Ctor, Ctor as object)) : undefined;
			} else {
				meta.instanceFields.push({ name: key, initializer: member.initializer });
			}
		} else if (ts.isClassStaticBlockDeclaration(member)) {
			// `static { … }` runs at definition time, in source order with static fields, `this` = the class.
			vm.evalNodeSync(member.body, fieldScope(meta, Ctor, Ctor as object));
		} else if (ts.isSemicolonClassElement(member)) {
			// ignore stray `;`
		} else {
			unimplemented(`class member ${ts.SyntaxKind[member.kind]}`);
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
	for (const field of meta.instanceFields) {
		const value = field.initializer ? vm.evalNodeSync(field.initializer, fieldScope(meta, instance, meta.proto)) : undefined;
		(instance as Record<PropertyKey, unknown>)[field.name] = value;
	}
}

function pushParentConstruct(vm: VM, superClass: unknown, args: unknown[], instance: object): void {
	if (isGuestClass(superClass)) {
		vm.pushFrame({ kind: "construct", node: null, phase: 0, scope: vm.rootScope, valuesBase: vm.values.length, ctor: superClass, args, instance, isNew: false });
	} else if (typeof superClass === "function") {
		// Host superclass (e.g. `extends Error`): best-effort — copy own props of a fresh instance.
		const parent = Reflect.construct(superClass as new (...a: unknown[]) => object, args, (instance as { constructor: new (...a: unknown[]) => unknown }).constructor);
		Object.assign(instance, parent);
	}
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
		const instance = frame.scope.getThis() as object;
		// initfields runs after the parent construct frame completes (it's pushed first, below it).
		vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance });
		pushParentConstruct(vm, meta.superClass, args, instance);
		frame.phase = 2;
	} else {
		vm.frames.pop();
		vm.push(undefined);
	}
}

on(K.ClassDeclaration, (vm, frame) => {
	const node = frame.node as ts.ClassDeclaration;
	vm.frames.pop();
	const Ctor = createGuestClass(vm, node, frame.scope);
	if (node.name) {
		frame.scope.declareLexical(node.name.text, "let");
		frame.scope.initialize(node.name.text, Ctor);
	}
});

on(K.ClassExpression, (vm, frame) => {
	const node = frame.node as ts.ClassExpression;
	vm.frames.pop();
	vm.push(createGuestClass(vm, node, frame.scope));
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
	const enumObject: Record<string, string | number> = {};
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
	const meta = ctor.__tsvalClass;
	if (frame.phase === 0) {
		const instance = (frame.instance as object) ?? Object.create(ctor.prototype);
		frame.instance = instance;
		if (meta.ctorNode) {
			const fnScope = new Scope(meta.closure, true);
			fnScope.hasThis = true;
			fnScope.thisVal = instance;
			fnScope.homeObject = meta.proto;
			fnScope.classMeta = meta;
			fnScope.newTarget = frame.newTarget ?? ctor;
			fnScope.declareLexical("arguments", "var");
			fnScope.initialize("arguments", frame.args as unknown[]);
			bindParameters(vm, fnScope, meta.ctorNode.parameters, frame.args as unknown[]);
			// Base class: fields init before the body. Derived: after super() (handled in the super call).
			if (meta.superClass == null) initInstanceFields(vm, meta, instance);
			hoist(vm, fnScope, (meta.ctorNode.body as ts.Block).statements);
			const body = vm.pushNode(meta.ctorNode.body as ts.Block, fnScope);
			body.reuseScope = true;
		} else if (meta.superClass != null) {
			// Implicit derived constructor: super(...args), then this class's fields.
			vm.pushFrame({ kind: "initfields", node: null, phase: 0, scope: meta.closure, valuesBase: vm.values.length, meta, instance });
			pushParentConstruct(vm, meta.superClass, frame.args as unknown[], instance);
		} else {
			initInstanceFields(vm, meta, instance);
		}
		frame.phase = 1;
	} else {
		vm.frames.pop();
		if (frame.isNew) vm.push(frame.instance);
	}
};

syntheticHandlers.initfields = (vm, frame) => {
	initInstanceFields(vm, frame.meta as ClassMeta, frame.instance as object);
	vm.frames.pop();
};

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
			fnScope.initialize("arguments", frame.args as unknown[]);
		}
		bindParameters(vm, fnScope, node.parameters, frame.args as unknown[]);
		fnScope.functionMeta = meta;
		frame.scope = fnScope;

		if (ts.isBlock(node.body!)) {
			hoist(vm, fnScope, node.body.statements);
			// Reuse the function scope for the body block (params + body vars share it).
			const bodyFrame = vm.pushNode(node.body, fnScope);
			bodyFrame.reuseScope = true;
			frame.phase = 1;
		} else {
			// Arrow with an expression body: value is the return value.
			vm.pushNode(node.body!, fnScope);
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
	for (let i = 0; i < params.length; i++) {
		const param = params[i];
		if (param.dotDotDotToken) {
			// Rest parameter — binds the remaining args (which may themselves be destructured).
			bindTarget(vm, scope, param.name, args.slice(i), "param");
			return;
		}
		let value = args[i];
		if (value === undefined && param.initializer) value = vm.evalNodeSync(param.initializer, scope);
		bindTarget(vm, scope, param.name, value, "param");
	}
}

/**
 * Bind a declaration target (identifier or binding pattern) to an already-computed value, declaring
 * into `scope`. The leaf sub-expressions of a pattern — default values and computed keys — are
 * evaluated synchronously (`vm.evalNodeSync`); the destructuring itself is pure.
 */
function bindTarget(vm: VM, scope: Scope, target: ts.BindingName, value: unknown, kind: BindingKind): void {
	if (ts.isIdentifier(target)) {
		if (kind === "var") {
			scope.declareVar(target.text);
			scope.set(target.text, value);
		} else {
			scope.declareLexical(target.text, kind);
			scope.initialize(target.text, value);
		}
		return;
	}
	if (ts.isObjectBindingPattern(target)) {
		const used = new Set<PropertyKey>();
		for (const element of target.elements) {
			if (element.dotDotDotToken) {
				const rest: Record<string, unknown> = {};
				for (const key in value as object) if (!used.has(key)) rest[key] = vm.fromHost((value as Record<string, unknown>)[key]);
				bindTarget(vm, scope, element.name, rest, kind);
				continue;
			}
			const key = element.propertyName ? bindingKey(vm, scope, element.propertyName) : (element.name as ts.Identifier).text;
			used.add(key);
			let v = vm.fromHost((value as Record<PropertyKey, unknown>)?.[key]);
			if (v === undefined && element.initializer) v = vm.evalNodeSync(element.initializer, scope);
			bindTarget(vm, scope, element.name, v, kind);
		}
		return;
	}
	if (ts.isArrayBindingPattern(target)) {
		const iterator = (value as Iterable<unknown>)[Symbol.iterator]();
		for (const element of target.elements) {
			if (ts.isOmittedExpression(element)) {
				iterator.next();
				continue;
			}
			if (element.dotDotDotToken) {
				const rest: unknown[] = [];
				for (let r = iterator.next(); !r.done; r = iterator.next()) rest.push(r.value);
				bindTarget(vm, scope, element.name, rest, kind);
				continue;
			}
			const r = iterator.next();
			let v = r.done ? undefined : r.value;
			if (v === undefined && element.initializer) v = vm.evalNodeSync(element.initializer, scope);
			bindTarget(vm, scope, element.name, v, kind);
		}
		return;
	}
	unimplemented(`binding target ${ts.SyntaxKind[(target as ts.Node).kind]}`);
}

function bindingKey(vm: VM, scope: Scope, name: ts.PropertyName): PropertyKey {
	if (ts.isComputedPropertyName(name)) return vm.evalNodeSync(name.expression, scope) as PropertyKey;
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
