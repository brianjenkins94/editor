/**
 * Hoisting: function declarations, `let`/`const` TDZ, recursive `var` collection, ambient (`declare`) statements, import bindings.
 */
import type { Scope } from "../scope.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { createGuestFunction } from "./functions.ts";

// TypeScript's exports object is in dictionary mode (thousands of members), so each `ts.x` read is a hash lookup: the
// functions used here are read off it once.
const { canHaveModifiers, forEachChild, getModifiers, isClassDeclaration, isClassLike, isEnumDeclaration, isFunctionDeclaration, isFunctionLike, isIdentifier, isImportDeclaration, isNamedImports, isNamespaceImport, isOmittedExpression, isVariableDeclarationList, isVariableStatement } = ts;

const Kind = ts.SyntaxKind;

/** One thing a statement list hoists (see HoistPlan). */
type HoistStep =
	| { "kind": "import"; "node": ts.ImportDeclaration }
	| { "kind": "function"; "name": string; "node": ts.FunctionDeclaration }
	| { "kind": "var"; "name": string }
	| { "kind": "lexical"; "names": string[]; "binding": "let" | "const" };

/**
 * What a statement list hoists, worked out once per list (the AST doesn't change): its imports and function declarations
 * (bound at each entry: a function object is a new closure each time), its enum and `let`/`const` names, in statement
 * order; the `var` names collected from anywhere inside it; and the statements that run (the ambient ones never do). A
 * block in a loop is entered every turn and a function's body every call — walking its statements each time was a fifth
 * of a tight loop's run.
 */
export interface HoistPlan {
	"steps": HoistStep[];
	"vars": string[];
	"executed": ts.Statement[];
	/** whether a block of these statements binds anything of its own — most don't (`{ if (…) { return false; } }`), and
	 *  a scope made each time a loop's body is entered was a tenth of a tight loop's run. Without, it runs in the scope
	 *  around it (the `var`s it hoists are the function's either way). */
	"scoped": boolean;
}

const hoistPlans = new WeakMap<readonly ts.Statement[], HoistPlan>();

export function hoistPlan(statements: readonly ts.Statement[]): HoistPlan {
	let plan = hoistPlans.get(statements);

	if (plan !== undefined) {
		return plan;
	}

	const steps: HoistStep[] = [];
	const executed: ts.Statement[] = [];
	let classes = false;

	for (const statement of statements) {
		// Ambient (`declare`) statements never execute, so they hoist nothing.
		if (!isAmbient(statement)) {
			executed.push(statement);
			if (isClassDeclaration(statement)) {
				classes = true; // (bound when it runs: classes.ts)
			}

			if (isImportDeclaration(statement)) {
				steps.push({ "kind": "import", "node": statement });
			} else if (isFunctionDeclaration(statement) && statement.name) {
				if (statement.body !== undefined) {
					steps.push({ "kind": "function", "name": statement.name.text, "node": statement }); // (an overload signature is erased)
				}
			} else if (isEnumDeclaration(statement)) {
				// tsc emits an enum as `var E; (function (E) {…})(E || (E = {}))`: the name is var-hoisted
				// (undefined before the declaration runs; declarations merge). A `const enum` is the same at
				// runtime — single-file transpilation (tsc's transpileModule, Node's type stripping) cannot
				// inline its members.
				steps.push({ "kind": "var", "name": statement.name.text });
			} else if (isVariableStatement(statement)) {
				const { flags } = statement.declarationList;
				const isLet = (flags & ts.NodeFlags.Let) !== 0;
				const isConst = (flags & ts.NodeFlags.Const) !== 0;

				if (isLet || isConst) {
					steps.push({ "kind": "lexical", "names": statement.declarationList.declarations.flatMap((decl) => bindingNames(decl.name)), "binding": isConst ? "const" : "let" });
				}
			}
		}
	}

	// `var` is function-scoped no matter how deeply nested in blocks/loops/try/switch: collect
	// recursively (not into nested functions/classes, which are their own var scope). Idempotent, so
	// re-running at each block entry is harmless.
	plan = { "steps": steps, "vars": collectVarNames(statements), "executed": executed, "scoped": classes || steps.length > 0 };
	hoistPlans.set(statements, plan);

	return plan;
}

export function hoist(vm: Machine, scope: Scope, plan: HoistPlan): void {
	const { steps, vars } = plan;

	for (const step of steps) {
		if (step.kind === "import") {
			bindImport(vm, scope, step.node);
		} else if (step.kind === "function") {
			scope.declareFunction(step.name, createGuestFunction(vm, step.node, scope));
		} else if (step.kind === "var") {
			scope.declareVar(step.name);
		} else {
			for (const name of step.names) {
				scope.declareLexical(name, step.binding);
			}
		}
	}

	for (const name of vars) {
		scope.declareVar(name);
	}
}

/** All identifiers bound by a (possibly destructuring) binding name. */
export function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
	if (isIdentifier(name)) {
		out.push(name.text);
	} else {
		for (const element of name.elements) {
			if (!isOmittedExpression(element)) {
				bindingNames(element.name, out);
			}
		}
	}

	return out;
}

/** Names of every `var` declared anywhere in `statements`, excluding nested function/class bodies. */
export function collectVarNames(statements: readonly ts.Node[], out: string[] = []): string[] {
	// An explicit work list, not recursion: a pathological expression (a 10k-term `a + a + …`) is
	// thousands of AST levels deep, which the host stack would not survive.
	const pending: ts.Node[] = [...statements].reverse();

	while (pending.length > 0) {
		const node = pending.pop()!;

		// A function/class is its own var scope; an ambient `declare var x` describes a host binding and
		// never creates one — either way, skip the node and don't descend into it.
		if (!(isFunctionLike(node) || isClassLike(node) || isAmbient(node))) {
			if (isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0) {
				for (const decl of node.declarations) {
					bindingNames(decl.name, out);
				}
			}

			if (isEnumDeclaration(node) && !isAmbient(node)) {
				out.push(node.name.text); // tsc emits `var E` (also as a bare `if` branch)
			}

			const children: ts.Node[] = [];

			forEachChild(node, (child) => {
				children.push(child);
			});
			for (let index = children.length - 1; index >= 0; index--) {
				pending.push(children[index]);
			}
		}
	}

	return out;
}

const capturing = new WeakMap<ts.Node, boolean>();

/** Whether `node` holds a function or a class — something that can capture a binding made while it runs. A loop whose
 *  turns nothing can capture needs no fresh scope per turn: no one could tell the turns' bindings apart. */
export function holdsClosure(node: ts.Node): boolean {
	let found = capturing.get(node);

	if (found !== undefined) {
		return found;
	}

	found = false;
	// A work list, as in collectVarNames.
	const pending: ts.Node[] = [node];

	while (pending.length > 0 && !found) {
		const current = pending.pop()!;

		if (isFunctionLike(current) || isClassLike(current)) {
			found = true;
		} else {
			forEachChild(current, (child) => {
				pending.push(child);
			});
		}
	}

	capturing.set(node, found);

	return found;
}

/** Ambient (`declare ...`) statements describe host shapes for the checker; they never execute. */
export function isAmbient(node: ts.Node): boolean {
	return canHaveModifiers(node) && (getModifiers(node) ?? []).some((modifier) => modifier.kind === Kind.DeclareKeyword);
}

/**
 * Bind an ImportDeclaration's names from the resolved module namespace. ESM-hoisted: run during the
 * `hoist` pass so imports are live before the first statement. Type-only imports resolve to nothing
 * useful but never run at runtime; `import type` is elided by the parser's `importClause.isTypeOnly`.
 */
export function bindImport(vm: Machine, scope: Scope, node: ts.ImportDeclaration): void {
	const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
	const clause = node.importClause;

	if (clause === undefined) {
		vm.importModule(specifier, node.getSourceFile().fileName); // side-effect import

		return;
	}

	if (clause.isTypeOnly) {
		return;
	}

	const ns = vm.importModule(specifier, node.getSourceFile().fileName) as Record<string, unknown>;
	const bind = (name: string, value: unknown): void => {
		scope.declareLexical(name, "const");
		scope.initialize(name, value);
	};

	if (clause.name) {
		bind(clause.name.text, vm.fromHost((ns as { "default"?: unknown }).default ?? ns)); // default import
	}

	const bindings = clause.namedBindings;

	if (bindings && isNamespaceImport(bindings)) {
		bind(bindings.name.text, ns);
	} else if (bindings && isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			if (!element.isTypeOnly) {
				bind(element.name.text, vm.fromHost(ns[(element.propertyName ?? element.name).text]));
			}
		}
	}
}

/** No handlers to register: this module only provides helpers. */
export function register(): void {
	// intentionally empty — this module exports helpers only, with nothing to install into the registry
}
