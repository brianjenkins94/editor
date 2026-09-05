/**
 * Statements: program/block, declarations, control flow (if / loops / switch / labels / try), enums.
 */
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import type { Iteration, NodeFrame } from "../frame.ts";
import { Scope } from "../scope.ts";
import type { BindingKind } from "../scope.ts";
import type { Signal, VM } from "../vm.ts";
import { namedIf } from "./functions.ts";
import { resumed, suspend } from "./generators.ts";
import { bindingNames, hoist, isAmbient } from "./hoist.ts";
import { getAsyncOrSyncIterator, getIterator, iterNext, iterationStep } from "./iteration.ts";
import { propertyName } from "./literals.ts";
import { PatternProgram, assignProgram, bindIdentifier, bindingProgram, pushPattern } from "./patterns.ts";
import { unwrapParens } from "./references.ts";
import { evaluating, noop, on } from "./registry.ts";

const K = ts.SyntaxKind;

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

export function pushStatementsReverse(vm: VM, statements: readonly ts.Statement[], scope: Scope): void {
	for (let i = statements.length - 1; i >= 0; i--) {
		if (!isAmbient(statements[i])) vm.pushNode(statements[i], scope);
	}
}

on(K.EmptyStatement, (vm) => {
	vm.frames.pop();
});

on(
	K.VariableStatement,
	evaluating<ts.VariableStatement>((node) => [node.declarationList], () => {}),
);

// Shared driver for a VariableDeclarationList: declare each name (defensively — `hoist` may already
// have, e.g. for TDZ in a block, but a `for`-init has no hoist pass), evaluate initializers in order,
// then bind. Runs in `frame.scope` (the scope the list was pushed with).
on(K.VariableDeclarationList, (vm, frame) => {
	const list = frame.node as ts.VariableDeclarationList;
	const decls = list.declarations;
	if ((list.flags & ts.NodeFlags.Using) !== 0) unimplemented("`using` / `await using` declarations (explicit resource management: disposal is not modeled)");
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
			if (kind !== "var") bindIdentifier(frame.scope, (decl.name as ts.Identifier).text, undefined, kind); // (a pattern needs an initializer)
			frame.phase += 2; // -> next decl
		}
	} else {
		const value = namedIf(vm.pop(), decl.name, decl.initializer);
		if (ts.isIdentifier(decl.name)) bindIdentifier(frame.scope, decl.name.text, value, kind);
		else pushPattern(vm, frame.scope, bindingProgram(decl.name, kind), value); // a frame above this one
		frame.phase++; // -> next decl (now even)
	}
});

on(
	K.ExpressionStatement,
	evaluating<ts.ExpressionStatement>(
		(node) => [node.expression],
		(vm, frame, _node, [value]) => {
			// The program's completion value (eval/script semantics): the last value-producing statement
			// of the PROGRAM — statements inside function bodies do not count.
			if (!vm.insideFunction(frame.scope)) vm.setCompletion(value);
		},
	),
);

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

on(
	K.ReturnStatement,
	evaluating<ts.ReturnStatement>(
		(node) => (node.expression ? [node.expression] : []),
		(vm, _frame, node, [value]) => vm.raise({ type: "return", value: node.expression ? value : undefined }),
	),
);

on(
	K.ThrowStatement,
	evaluating<ts.ThrowStatement>((node) => [node.expression], (vm, _frame, _node, [value]) => vm.raise({ type: "throw", value })),
);

// A hoisted function declaration is a no-op at execution time (created during hoist).
on(K.FunctionDeclaration, (vm) => void vm.frames.pop()); // hoisted (an overload signature is erased)

on(K.DebuggerStatement, (vm) => void vm.frames.pop());

on(K.TypeAliasDeclaration, noop);

on(K.InterfaceDeclaration, noop);

on(K.ExportDeclaration, noop); // `export { ... }` — module output isn't modeled

on(K.ImportEqualsDeclaration, noop);

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
				? node.initializer.declarations.flatMap((d) => bindingNames(d.name))
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
export function copyPerIteration(frame: NodeFrame): void {
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
		frame.iteration = { record: getIterator(vm, vm.pop()), done: false }; // (VM.unwind IteratorCloses it on abrupt exit)
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const it = frame.iteration as Iteration;
		const value = iterationStep(it);
		if (it.done) return void vm.frames.pop();
		bindForTarget(vm, frame, node.initializer, vm.fromHost(value));
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
});

// `for await (x of iterable)`: an async iterator's `.next()` results are awaited; a sync iterable's
// *values* are awaited (the spec's async-from-sync adaptation). Each await suspends the enclosing
// fiber, which is what makes the loop steppable/forkable like any other.
export function forAwaitOf(vm: VM, frame: NodeFrame, node: ts.ForOfStatement): void {
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const { record, sync } = getAsyncOrSyncIterator(vm, vm.pop());
		frame.iteration = { record, done: false };
		frame.syncIterator = sync;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const it = frame.iteration as Iteration;
		if (frame.syncIterator) {
			const value = iterationStep(it);
			if (it.done) return void vm.frames.pop();
			suspend(vm, frame, "await", value, 3); // await the element itself
		} else {
			let step: unknown;
			try {
				step = iterNext(it.record);
			} catch (error) {
				it.done = true; // a throwing iterator is not closed
				throw error;
			}
			suspend(vm, frame, "await", step, 4); // await the result object
		}
	} else if (frame.phase === 3) {
		bindForTarget(vm, frame, node.initializer, resumed(vm));
		frame.phase = 5;
	} else if (frame.phase === 4) {
		const result = resumed(vm);
		const it = frame.iteration as Iteration;
		if (typeof result !== "object" || result === null) throw new TypeError("Iterator result is not an object");
		let value: unknown;
		try {
			if ((result as IteratorResult<unknown>).done) {
				it.done = true;
				return void vm.frames.pop();
			}
			value = (result as IteratorResult<unknown>).value;
		} catch (error) {
			it.done = true;
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
export function bindForTarget(vm: VM, frame: NodeFrame, initializer: ts.ForInitializer, value: unknown): void {
	const node = frame.node as ts.ForOfStatement | ts.ForInStatement;
	const bodyScope = new Scope(frame.scope, false);
	// A plain identifier binds directly; anything else (a pattern, a member target) is bound by a
	// pattern frame pushed ABOVE the body, so it runs first.
	let stepped: { scope: Scope; program: PatternProgram } | undefined;
	if (ts.isVariableDeclarationList(initializer)) {
		const decl = initializer.declarations[0];
		const isConst = (initializer.flags & ts.NodeFlags.Const) !== 0;
		const isLet = (initializer.flags & ts.NodeFlags.Let) !== 0;
		const kind: BindingKind = isConst ? "const" : isLet ? "let" : "var";
		if (ts.isIdentifier(decl.name)) bindIdentifier(bodyScope, decl.name.text, value, kind);
		else stepped = { scope: bodyScope, program: bindingProgram(decl.name, kind) };
	} else {
		const target = unwrapParens(initializer as ts.Expression);
		if (ts.isIdentifier(target)) frame.scope.set(target.text, value);
		else stepped = { scope: frame.scope, program: assignProgram(target) };
	}
	vm.pushNode(node.statement, bodyScope);
	if (stepped !== undefined) pushPattern(vm, stepped.scope, stepped.program, value);
}

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

//
// The phases here pair with `unwindTry` in vm.ts: unwind sets phase 3 (catch) or 5 (pending-finally)
// and pushes the appropriate block; these phases run after a block completes normally.

on(K.TryStatement, (vm, frame) => {
	const node = frame.node as ts.TryStatement;
	if (frame.phase === 0) {
		frame.state = "try";
		vm.pushNode(node.tryBlock, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1 || frame.phase === 3) {
		// try block (1) / catch block (3) completed normally
		if (node.finallyBlock) {
			frame.state = "finally";
			// A normal `finally` contributes nothing to the statement's completion value (the spec's
			// UpdateEmpty(B, …) keeps the try/catch block's): remember it and restore afterwards.
			frame.completionSave = { value: vm.completion, serial: vm.completionSerial };
			vm.pushNode(node.finallyBlock, frame.scope);
			frame.phase = frame.phase === 1 ? 2 : 4;
		} else {
			vm.frames.pop();
		}
	} else if (frame.phase === 2 || frame.phase === 4) {
		vm.frames.pop(); // finally done (after a normal try / catch)
		const saved = frame.completionSave as { value: unknown; serial: number };
		vm.completion = saved.value;
		vm.completionSerial = saved.serial;
	} else {
		// phase 5: pending-finally done → re-raise the signal that was escaping.
		vm.frames.pop();
		vm.raise(frame.pendingSignal as Signal);
	}
});

//
// Numeric members auto-increment from the previous numeric value and get a reverse mapping
// (E[0] === "A"); string members don't. Member initializers may reference earlier members by bare
// name or `E.member`, so they're evaluated in a scope layering the members declared so far.
on(K.EnumDeclaration, (vm, frame) => {
	const node = frame.node as ts.EnumDeclaration;
	vm.frames.pop();
	const name = node.name.text;
	const existing = frame.scope.has(name) ? frame.scope.get(name) : undefined;
	frame.scope.set(name, buildEnum(vm, frame.scope, node, typeof existing === "object" && existing !== null ? (existing as Record<string, string | number>) : undefined));
	// The emitted form is an expression statement (an IIFE call): the program's completion becomes undefined.
	if (!vm.insideFunction(frame.scope)) vm.setCompletion(undefined);
});

/** Build (or extend — declarations merge) an enum object: members with auto-increment and reverse
 *  mappings for numeric values; each member is also a constant visible to later initializers. */
export function buildEnum(vm: VM, scope: Scope, node: ts.EnumDeclaration, into: Record<string, string | number> | undefined): Record<string, string | number> {
	const enumObject = into ?? (new vm.realm.Object() as Record<string, string | number>);
	// Inside initializers a bare member name reads the enum's property (tsc emits `E.name`): members of
	// earlier declarations have their values; this declaration's are undefined until defined.
	const memberScope = new Scope(scope, false);
	memberScope.declareLexical(node.name.text, "const");
	memberScope.initialize(node.name.text, enumObject);
	const declared = new Set<string>();
	const declareMember = (key: string, value: unknown): void => {
		if (!declared.has(key)) {
			declared.add(key);
			memberScope.declareLexical(key, "let");
			memberScope.initialize(key, value);
		} else memberScope.set(key, value);
	};
	for (const key of Object.keys(enumObject)) if (Number.isNaN(Number(key))) declareMember(key, enumObject[key]);
	for (const member of node.members) if (!ts.isComputedPropertyName(member.name)) declareMember(propertyName(member.name), enumObject[propertyName(member.name)]);
	let auto = 0;
	for (const member of node.members) {
		const key = ts.isComputedPropertyName(member.name) ? String(vm.evalNodeSync(member.name.expression, memberScope)) : propertyName(member.name);
		const value = member.initializer !== undefined ? (vm.evalNodeSync(member.initializer, memberScope) as string | number) : auto;
		enumObject[key] = value;
		if (typeof value === "number") {
			enumObject[value] = key; // reverse mapping (numeric enums only)
			auto = value + 1;
		}
		declareMember(key, value);
	}
	return enumObject;
}

/** The loop head's `let`/`const` names are in the TDZ while the iterable expression evaluates
 *  (`for (const x of x)` is a ReferenceError). */
export function headTdzScope(scope: Scope, initializer: ts.ForInitializer): Scope {
	if (!ts.isVariableDeclarationList(initializer) || (initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return scope;
	const tdz = new Scope(scope, false);
	for (const decl of initializer.declarations) for (const name of bindingNames(decl.name)) tdz.declareLexical(name, "let");
	return tdz;
}
