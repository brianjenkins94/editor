/**
 * Statements: program/block, declarations, control flow (if / loops / switch / labels / try), enums.
 */
import type { NodeFrame } from "../frame.ts";
import type { BindingKind } from "../scope.ts";
import type { Machine } from "../vm.ts";
import type { PatternProgram } from "./patterns.ts";
import ts from "typescript";
import { unimplemented } from "../errors.ts";
import { Scope } from "../scope.ts";
import { namedIf } from "./functions.ts";
import { resumed, suspend } from "./generators.ts";
import { bindingNames, hoist, hoistPlan, holdsClosure } from "./hoist.ts";
import { getAsyncOrSyncIterator, getIterator, iterationStep, iterNext } from "./iteration.ts";
import { propertyName } from "./literals.ts";
import { assignProgram, bindIdentifier, bindingProgram, pushPattern } from "./patterns.ts";
import { unwrapParens } from "./references.ts";
import { evaluating, noop, on } from "./registry.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions used here are read off it once.
const { isClassExpression, isComputedPropertyName, isIdentifier, isOmittedExpression, isVariableDeclarationList } = ts;

const Kind = ts.SyntaxKind;
const { NodeFlags } = ts;

function sourceFile(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.SourceFile;

	if (frame.phase === 0) {
		// The program's modules (MODULES.md): the program files it imports from, evaluated first.
		if (vm.linkImports(node, frame)) {
			return;
		}

		const plan = hoistPlan(node.statements);

		hoist(vm, frame.scope, plan);
		vm.linkExports(node, frame.scope);
		pushStatementsReverse(vm, plan.executed, frame.scope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
}

function block(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.Block;

	if (frame.phase === 0) {
		// A function-body Block runs directly in the function scope (params + body share it); a plain
		// Block gets a fresh child scope, when it binds anything. `frame.reuseScope` is set by the call handler.
		const plan = hoistPlan(node.statements);
		const blockScope = frame.reuseScope || !plan.scoped ? frame.scope : new Scope(frame.scope, false);

		if (!frame.reuseScope) {
			hoist(vm, blockScope, plan);
		}

		pushStatementsReverse(vm, plan.executed, blockScope);
		frame.phase = 1;
	} else {
		vm.frames.pop();
	}
}

/** Push the statements that run (HoistPlan.executed), the first on top. */
export function pushStatementsReverse(vm: Machine, executed: readonly ts.Statement[], scope: Scope): void {
	for (let index = executed.length - 1; index >= 0; index--) {
		vm.pushNode(executed[index], scope);
	}
}

function emptyStatement(vm: Machine): void {
	vm.frames.pop();
}

const variableStatement = evaluating<ts.VariableStatement>((node) => [node.declarationList], () => {
	// Nothing to do after the declaration list frame: it performs the declarations and bindings itself.
});

// Shared driver for a VariableDeclarationList: declare each name (defensively — `hoist` may already
// have, e.g. for TDZ in a block, but a `for`-init has no hoist pass), evaluate initializers in order,
// then bind. Runs in `frame.scope` (the scope the list was pushed with).
function variableDeclarationList(vm: Machine, frame: NodeFrame): void {
	const list = frame.node as ts.VariableDeclarationList;
	const decls = list.declarations;

	if ((list.flags & NodeFlags.Using) !== 0) {
		unimplemented("`using` / `await using` declarations (explicit resource management: disposal is not modeled)");
	}

	const isConst = (list.flags & NodeFlags.Const) !== 0;
	const isLet = (list.flags & NodeFlags.Let) !== 0;
	let kind: BindingKind;

	if (isConst) {
		kind = "const";
	} else if (isLet) {
		kind = "let";
	} else {
		kind = "var";
	}

	// phase encodes "which declaration are we on": phase 2*i => start decl i; phase 2*i+1 => bind decl i.
	const index = frame.phase >> 1;

	// The previous declaration's pattern, bound by now (its frame ran above this one): each name it bound, traced.
	// (never `decls[-1]`: a read out of bounds turns the load megamorphic)
	const previous = (frame.phase & 1) === 0 && index > 0 ? decls[index - 1] : undefined;

	if (vm.trace !== undefined && previous?.initializer !== undefined && !isIdentifier(previous.name)) {
		for (const name of bindingNames(previous.name)) {
			vm.traced("bind", previous, name, frame.scope.get(name));
		}
	}

	if (index >= decls.length) {
		vm.frames.pop();

		return;
	}

	const decl = decls[index];

	if ((frame.phase & 1) === 0) {
		if (decl.initializer) {
			frame.phase += 1; // -> bind

			if (isIdentifier(decl.name) && isClassExpression(unwrapParens(decl.initializer))) {
				vm.pushNode(decl.initializer, frame.scope).nameHint = decl.name.text; // (see classDefinition)

				return;
			}

			// (a leaf — `let count = 0`, `const x = y` — on the stack already: on to bind it in this step)
			if (!vm.pushOperand(decl.initializer, frame.scope)) {
				return;
			}
		} else {
			// no initializer: `let x;` leaves the TDZ as undefined. `var x;` is a runtime no-op — it must
			// not overwrite a hoisted `function x` (or an earlier assignment) with undefined.
			if (kind !== "var") {
				bindIdentifier(frame.scope, (decl.name as ts.Identifier).text, undefined, kind); // (a pattern needs an initializer)
			}

			frame.phase += 2; // -> next decl
		}
	}

	if ((frame.phase & 1) === 1) {
		const value = namedIf(vm.pop(), decl.name, decl.initializer);

		if (isIdentifier(decl.name)) {
			bindIdentifier(frame.scope, decl.name.text, value, kind);
			vm.traced("bind", decl, decl.name.text, value);
		} else {
			pushPattern(vm, frame.scope, bindingProgram(decl.name, kind), value); // a frame above this one
		}

		frame.phase += 1; // -> next decl (now even)
	}
}

const expressionStatement = evaluating<ts.ExpressionStatement>(
	(node) => [node.expression],
	(vm, frame, _node, [value]) => {
		// The program's completion value (eval/script semantics): the last value-producing statement
		// of the PROGRAM — statements inside function bodies do not count.
		if (!vm.insideFunction(frame.scope)) {
			vm.setCompletion(value);
		}
	}
);

function ifStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.IfStatement;

	if (frame.phase === 0) {
		frame.phase = 1;

		if (!vm.pushOperand(node.expression, frame.scope)) {
			return;
		}
	}

	if (frame.phase === 1) {
		const cond = vm.pop();

		vm.observe?.(node, "branch", cond ? 0 : 1);
		vm.traced("branch", node, "if", cond ? 0 : 1);
		if (cond) {
			vm.pushNode(node.thenStatement, frame.scope);
		} else if (node.elseStatement) {
			vm.pushNode(node.elseStatement, frame.scope);
		}

		frame.phase = 2;
	} else {
		vm.frames.pop();
	}
}

const returnStatement = evaluating<ts.ReturnStatement>(
	(node) => (node.expression ? [node.expression] : []),
	(vm, _frame, node, [value]) => {
		const returned = node.expression ? value : undefined;

		vm.observe?.(node, "return", returned);
		vm.traced("return", node, "return", returned);
		vm.raise({ "type": "return", "value": returned });
	}
);

const throwStatement = evaluating<ts.ThrowStatement>(
	(node) => [node.expression],
	(vm, _frame, node, [value]) => { vm.raise({ "type": "throw", "value": value }, node); }
);

// A hoisted function declaration is a no-op at execution time (created during hoist).

// Imports are bound during hoisting; the statement itself is a no-op. `import =` / `export` (module
// output) aren't modeled — this interpreter runs a program, it doesn't emit one.
function importDeclaration(vm: Machine): void {
	vm.frames.pop();
}

function breakStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.BreakStatement;

	vm.frames.pop();
	vm.raise({ "type": "break", "label": node.label?.text });
}

function continueStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ContinueStatement;

	vm.frames.pop();
	vm.raise({ "type": "continue", "label": node.label?.text });
}

//
// Loop frames set `frame.isLoop = true` (so `unwind` catches break/continue) and `frame.continuePhase`
// (the phase to resume at on `continue`). A labeled loop's `frame.label` is set by LabeledStatement
// before the loop's phase 0 runs.

function whileStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.WhileStatement;

	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 0;
		frame.phase = 1;

		if (!vm.pushOperand(node.expression, frame.scope)) {
			return;
		}
	}

	if (frame.phase === 1) {
		if (!vm.pop()) {
			vm.frames.pop();

			return;
		}

		frame.turn = (frame.turn ?? -1) + 1;
		vm.pushNode(node.statement, frame.scope);
		frame.phase = 2;
	} else {
		frame.phase = 0; // next iteration: re-evaluate the condition
	}
}

function doStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.DoStatement;

	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 1; // `continue` in a do-while proceeds to the condition test
		frame.turn = (frame.turn ?? -1) + 1;
		vm.pushNode(node.statement, frame.scope);
		frame.phase = 1;
	} else if (frame.phase === 1) {
		vm.pushNode(node.expression, frame.scope);
		frame.phase = 2;
	} else if (vm.pop()) {
		frame.phase = 0;
	} else {
		vm.frames.pop();
	}
}

function forStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ForStatement;

	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 4; // `continue` runs the incrementor, then re-checks the condition
		const loopScope = new Scope(frame.scope, false);

		frame.iterScope = loopScope;
		// For per-iteration `let`/`const` binding (fresh binding each turn — correct closure capture), when the loop
		// holds a closure to capture one.
		frame.lexicalNames =
			node.initializer !== null && node.initializer !== undefined && isVariableDeclarationList(node.initializer) && (node.initializer.flags & (NodeFlags.Let | NodeFlags.Const)) !== 0 && holdsClosure(node)
				? node.initializer.declarations.flatMap((decl) => bindingNames(decl.name))
				: null;
		// The copies keep the declaration's kind: `for (const x = 0; ; x++)` is a TypeError, not a loop.
		frame.lexicalKind = node.initializer !== null && node.initializer !== undefined && (node.initializer.flags & NodeFlags.Const) !== 0 ? "const" : "let";

		if (node.initializer) {
			vm.pushNode(node.initializer, loopScope);
			frame.initIsExpr = !isVariableDeclarationList(node.initializer);
			frame.phase = 1;
		} else {
			frame.phase = 2;
		}
	} else if (frame.phase === 1) {
		if (frame.initIsExpr) {
			vm.pop();
		}

		copyPerIteration(frame);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const scope = frame.iterScope!;

		if (node.condition === undefined) {
			frame.turn = (frame.turn ?? -1) + 1;
			vm.pushNode(node.statement, scope);
			frame.phase = 4;
		} else if (vm.pushOperand(node.condition, scope)) {
			forTurn(vm, frame, node); // (a simple condition — `n < limit` — tested in this step)
		} else {
			frame.phase = 3;
		}
	} else if (frame.phase === 3) {
		forTurn(vm, frame, node);
	} else if (frame.phase === 4) {
		// After the body: snapshot bindings into a fresh scope (so the body's closures keep their
		// values), THEN run the incrementor in that fresh scope. (spec CreatePerIterationEnvironment.)
		copyPerIteration(frame);
		if (node.incrementor === undefined) {
			frame.phase = 2;
		} else if (vm.pushOperand(node.incrementor, frame.iterScope!)) {
			vm.pop(); // (a simple incrementor — `d += 1`, `i++` — run in this step; its value discarded)
			frame.phase = 2;
		} else {
			frame.phase = 5;
		}
	} else {
		vm.pop(); // discard incrementor value
		frame.phase = 2;
	}
}

/** A `for` loop's condition tested (its value on the stack): the loop done, or its body's next turn. */
function forTurn(vm: Machine, frame: NodeFrame, node: ts.ForStatement): void {
	if (!vm.pop()) {
		vm.frames.pop();

		return;
	}

	frame.turn = (frame.turn ?? -1) + 1;
	vm.pushNode(node.statement, frame.iterScope!);
	frame.phase = 4;
}

// Snapshot the loop variables into a fresh scope so each iteration captures its own binding.
export function copyPerIteration(frame: NodeFrame): void {
	const names = frame.lexicalNames as string[] | null;

	if (names === null || names === undefined || names.length === 0) {
		return;
	}

	const prev = frame.iterScope!;
	const next = new Scope(frame.scope, false);
	const kind = (frame.lexicalKind as "let" | "const" | undefined) ?? "let";

	for (const name of names) {
		next.declareLexical(name, kind);
		next.initialize(name, prev.get(name));
	}

	frame.iterScope = next;
}

function forOfStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ForOfStatement;

	if (node.awaitModifier) {
		forAwaitOf(vm, frame, node);

		return;
	}

	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		frame.iteration = { "record": getIterator(vm, vm.pop()), "done": false }; // (VM.unwind IteratorCloses it on abrupt exit)
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const it = frame.iteration!;
		const value = iterationStep(it);

		if (it.done) {
			vm.frames.pop();

			return;
		}

		bindForTarget(vm, frame, node.initializer, vm.fromHost(value));
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
}

// `for await (x of iterable)`: an async iterator's `.next()` results are awaited; a sync iterable's
// *values* are awaited (the spec's async-from-sync adaptation). Each await suspends the enclosing
// fiber, which is what makes the loop steppable/forkable like any other.
export function forAwaitOf(vm: Machine, frame: NodeFrame, node: ts.ForOfStatement): void {
	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const { record, sync } = getAsyncOrSyncIterator(vm, vm.pop());

		frame.iteration = { "record": record, "done": false };
		frame.syncIterator = sync;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const it = frame.iteration!;

		if (frame.syncIterator) {
			const value = iterationStep(it);

			if (it.done) {
				vm.frames.pop();

				return;
			}

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
		const it = frame.iteration!;

		if (typeof result !== "object" || result === null) {
			throw new TypeError("Iterator result is not an object");
		}

		let value: unknown;

		try {
			if ((result as IteratorResult<unknown>).done) {
				it.done = true;
				vm.frames.pop();

				return;
			}

			({ value } = result as IteratorResult<unknown>);
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

function forInStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.ForInStatement;

	if (frame.phase === 0) {
		frame.isLoop = true;
		frame.continuePhase = 2;
		vm.pushNode(node.expression, headTdzScope(frame.scope, node.initializer));
		frame.phase = 1;
	} else if (frame.phase === 1) {
		const obj = vm.pop();
		const keys: string[] = [];

		if (obj !== null && obj !== undefined) {
			for (const key in obj) {
				keys.push(key);
			}
		}

		frame.keys = keys;
		frame.enumerated = obj === null || obj === undefined ? undefined : (new Object(obj));
		frame.index = 0;
		frame.phase = 2;
	} else if (frame.phase === 2) {
		const keys = frame.keys as string[];
		let index = frame.index!;

		// A property deleted before its turn is not visited (EnumerateObjectProperties).
		while (index < keys.length && !((keys[index]) in (frame.enumerated!))) {
			index += 1;
		}

		if (index >= keys.length) {
			vm.frames.pop();

			return;
		}

		frame.index = index + 1;
		bindForTarget(vm, frame, node.initializer, keys[index]);
		frame.phase = 3;
	} else {
		frame.phase = 2;
	}
}

// Bind the current for-of/for-in element to the loop target in a fresh per-iteration scope, then
// push the body. Destructuring targets: S2 (later).
export function bindForTarget(vm: Machine, frame: NodeFrame, initializer: ts.ForInitializer, value: unknown): void {
	const node = frame.node as ts.ForOfStatement | ts.ForInStatement;
	const bodyScope = turnScope(frame, node);

	frame.turn = (frame.turn ?? -1) + 1;
	// A plain identifier binds directly; anything else (a pattern, a member target) is bound by a
	// pattern frame pushed ABOVE the body, so it runs first.
	let stepped: { "scope": Scope; "program": PatternProgram } | undefined;

	if (isVariableDeclarationList(initializer)) {
		const [decl] = initializer.declarations;
		const isConst = (initializer.flags & NodeFlags.Const) !== 0;
		const isLet = (initializer.flags & NodeFlags.Let) !== 0;
		let kind: BindingKind;

		if (isConst) {
			kind = "const";
		} else if (isLet) {
			kind = "let";
		} else {
			kind = "var";
		}

		if (isIdentifier(decl.name)) {
			bindIdentifier(bodyScope, decl.name.text, value, kind);
			vm.traced("bind", decl, decl.name.text, value);
		} else {
			stepped = { "scope": bodyScope, "program": bindingProgram(decl.name, kind) };
		}
	} else {
		const target = unwrapParens(initializer);

		if (isIdentifier(target)) {
			frame.scope.set(target.text, value);
			vm.traced("bind", target, target.text, value);
		} else {
			stepped = { "scope": frame.scope, "program": assignProgram(target) };
		}
	}

	vm.pushNode(node.statement, bodyScope);
	if (stepped !== undefined) {
		pushPattern(vm, stepped.scope, stepped.program, value);
	}
}

const sharedTurns = new WeakMap<ts.Node, boolean>();

/** The scope a for-of/for-in turn binds its target in. A `var` or an assignment target binds outside it, so none; a
 *  `let`/`const` one, a fresh scope each turn — unless nothing in the loop could capture the binding, when the turns
 *  share one (rebinding resets it). A pattern with defaults or computed keys gets a fresh one regardless: one of them
 *  could read a name the pattern hasn't bound yet this turn. */
function turnScope(frame: NodeFrame, node: ts.ForOfStatement | ts.ForInStatement): Scope {
	const { initializer } = node;

	if (!isVariableDeclarationList(initializer) || (initializer.flags & (NodeFlags.Let | NodeFlags.Const)) === 0) {
		return frame.scope;
	}

	let shared = sharedTurns.get(node);

	if (shared === undefined) {
		shared = !holdsClosure(node) && initializer.declarations.every((decl) => plainBinding(decl.name));
		sharedTurns.set(node, shared);
	}

	if (!shared) {
		return new Scope(frame.scope, false);
	}

	if (frame.iterScope === undefined) {
		frame.iterScope = new Scope(frame.scope, false);
	}

	return frame.iterScope;
}

/** A binding name with no default values or computed keys in it. */
function plainBinding(name: ts.BindingName): boolean {
	return isIdentifier(name) || name.elements.every((element) => isOmittedExpression(element) || (element.initializer === undefined && (element.propertyName === undefined || !isComputedPropertyName(element.propertyName)) && plainBinding(element.name)));
}

function switchStatement(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.SwitchStatement;
	const { clauses } = node.caseBlock;

	if (frame.phase === 0) {
		frame.isSwitch = true;
		frame.phase = 1;

		if (!vm.pushOperand(node.expression, frame.scope)) {
			return;
		}
	}

	if (frame.phase === 1) {
		frame.disc = vm.pop();
		frame.caseIndex = 0;
		frame.defaultIndex = clauses.findIndex((clause) => clause.kind === Kind.DefaultClause);
		frame.switchScope = new Scope(frame.scope, false);
		frame.phase = 2;
	} else if (frame.phase === 2) {
		// Scan forward for the next `case` test to evaluate (skip `default` while matching).
		let index = frame.caseIndex!;

		while (index < clauses.length && clauses[index].kind === Kind.DefaultClause) {
			index += 1;
		}

		if (index >= clauses.length) {
			const def = frame.defaultIndex!;

			frame.execIndex = def >= 0 ? def : clauses.length;
			frame.phase = 4;

			return;
		}

		frame.pendingCase = index;
		vm.pushNode((clauses[index] as ts.CaseClause).expression, frame.switchScope!);
		frame.phase = 3;
	} else if (frame.phase === 3) {
		const testValue = vm.pop();

		if (testValue === frame.disc) {
			frame.execIndex = frame.pendingCase;
			frame.phase = 4;
		} else {
			frame.caseIndex = (frame.pendingCase!) + 1;
			frame.phase = 2;
		}
	} else if (frame.phase === 4) {
		// Execute statements from the matched clause to the end (fall-through), sharing one block scope.
		const start = frame.execIndex!;

		if (start >= clauses.length) {
			vm.frames.pop();

			return;
		}

		const statements: ts.Statement[] = [];

		for (let clauseIndex = start; clauseIndex < clauses.length; clauseIndex++) {
			for (const statement of clauses[clauseIndex].statements) {
				statements.push(statement);
			}
		}

		const switchScope = frame.switchScope!;

		hoist(vm, switchScope, hoistPlan(statements));
		for (let index = statements.length - 1; index >= 0; index--) {
			vm.pushNode(statements[index], switchScope);
		}

		frame.phase = 5;
	} else {
		vm.frames.pop();
	}
}

function labeledStatement(vm: Machine, frame: NodeFrame): void {
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
}

//
// The phases here pair with `unwindTry` in vm.ts: unwind sets phase 3 (catch) or 5 (pending-finally)
// and pushes the appropriate block; these phases run after a block completes normally.

function tryStatement(vm: Machine, frame: NodeFrame): void {
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
			frame.completionSave = { "value": vm.completion, "serial": vm.completionSerial };
			vm.pushNode(node.finallyBlock, frame.scope);
			frame.phase = frame.phase === 1 ? 2 : 4;
		} else {
			vm.frames.pop();
		}
	} else if (frame.phase === 2 || frame.phase === 4) {
		vm.frames.pop(); // finally done (after a normal try / catch)
		const saved = frame.completionSave as { "value": unknown; "serial": number };

		vm.completion = saved.value;
		vm.completionSerial = saved.serial;
	} else {
		// phase 5: pending-finally done → re-raise the signal that was escaping.
		vm.frames.pop();
		vm.raise(frame.pendingSignal!);
	}
}

//
// Numeric members auto-increment from the previous numeric value and get a reverse mapping
// (E[0] === "A"); string members don't. Member initializers may reference earlier members by bare
// name or `E.member`, so they're evaluated in a scope layering the members declared so far.
function enumDeclaration(vm: Machine, frame: NodeFrame): void {
	const node = frame.node as ts.EnumDeclaration;

	vm.frames.pop();
	const name = node.name.text;
	const existing = frame.scope.has(name) ? frame.scope.get(name) : undefined;

	frame.scope.set(name, buildEnum(vm, frame.scope, node, typeof existing === "object" && existing !== null ? (existing as Record<string, string | number>) : undefined));
	// The emitted form is an expression statement (an IIFE call): the program's completion becomes undefined.
	if (!vm.insideFunction(frame.scope)) {
		vm.setCompletion(undefined);
	}
}

/** Build (or extend — declarations merge) an enum object: members with auto-increment and reverse
 *  mappings for numeric values; each member is also a constant visible to later initializers. */
export function buildEnum(vm: Machine, scope: Scope, node: ts.EnumDeclaration, into: Record<string, string | number> | undefined): Record<string, string | number> {
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
		} else {
			memberScope.set(key, value);
		}
	};

	for (const key of Object.keys(enumObject)) {
		if (Number.isNaN(Number(key))) {
			declareMember(key, enumObject[key]);
		}
	}

	for (const member of node.members) {
		if (!isComputedPropertyName(member.name)) {
			declareMember(propertyName(member.name), enumObject[propertyName(member.name)]);
		}
	}

	let auto = 0;

	for (const member of node.members) {
		const key = isComputedPropertyName(member.name) ? String(vm.evalNodeSync(member.name.expression, memberScope)) : propertyName(member.name);
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
	if (!isVariableDeclarationList(initializer) || (initializer.flags & (NodeFlags.Let | NodeFlags.Const)) === 0) {
		return scope;
	}

	const tdz = new Scope(scope, false);

	for (const decl of initializer.declarations) {
		for (const name of bindingNames(decl.name)) {
			tdz.declareLexical(name, "let");
		}
	}

	return tdz;
}

/** Registers this module's handlers (called by ../handlers.ts once every module has loaded). */
export function register(): void {
	on(Kind.SourceFile, sourceFile);
	on(Kind.Block, block);
	on(Kind.EmptyStatement, emptyStatement);
	on(Kind.VariableStatement, variableStatement);
	on(Kind.VariableDeclarationList, variableDeclarationList);
	on(Kind.ExpressionStatement, expressionStatement);
	on(Kind.IfStatement, ifStatement);
	on(Kind.ReturnStatement, returnStatement);
	on(Kind.ThrowStatement, throwStatement);
	on(Kind.FunctionDeclaration, noop); // hoisted (an overload signature is erased)
	on(Kind.DebuggerStatement, noop);
	on(Kind.TypeAliasDeclaration, noop);
	on(Kind.InterfaceDeclaration, noop);
	on(Kind.ExportDeclaration, noop); // `export { ... }` — module output isn't modeled
	on(Kind.ImportEqualsDeclaration, noop);
	on(Kind.ImportDeclaration, importDeclaration);
	on(Kind.BreakStatement, breakStatement);
	on(Kind.ContinueStatement, continueStatement);
	on(Kind.WhileStatement, whileStatement);
	on(Kind.DoStatement, doStatement);
	on(Kind.ForStatement, forStatement);
	on(Kind.ForOfStatement, forOfStatement);
	on(Kind.ForInStatement, forInStatement);
	on(Kind.SwitchStatement, switchStatement);
	on(Kind.LabeledStatement, labeledStatement);
	on(Kind.TryStatement, tryStatement);
	on(Kind.EnumDeclaration, enumDeclaration);
}
