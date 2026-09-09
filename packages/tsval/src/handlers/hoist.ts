/**
 * Hoisting: function declarations, `let`/`const` TDZ, recursive `var` collection, ambient (`declare`) statements, import bindings.
 */
import type { Scope } from "../scope.ts";
import type { Machine } from "../vm.ts";
import ts from "typescript";
import { createGuestFunction } from "./functions.ts";

const K = ts.SyntaxKind;

export function hoist(vm: Machine, scope: Scope, statements: readonly ts.Statement[]): void {
	for (const statement of statements) {
		if (isAmbient(statement)) {
			continue;
		} else if (ts.isImportDeclaration(statement)) {
			bindImport(vm, scope, statement);
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			if (statement.body !== undefined) { scope.declareFunction(statement.name.text, createGuestFunction(vm, statement, scope)); } // (an overload signature is erased)
		} else if (ts.isEnumDeclaration(statement)) {
			// tsc emits an enum as `var E; (function (E) {…})(E || (E = {}))`: the name is var-hoisted
			// (undefined before the declaration runs; declarations merge). A `const enum` is the same at
			// runtime — single-file transpilation (tsc's transpileModule, Node's type stripping) cannot
			// inline its members.
			scope.declareVar(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			const { flags } = statement.declarationList;
			const isLet = (flags & ts.NodeFlags.Let) !== 0;
			const isConst = (flags & ts.NodeFlags.Const) !== 0;

			if (isLet || isConst) {
				for (const decl of statement.declarationList.declarations) {
					for (const name of bindingNames(decl.name)) { scope.declareLexical(name, isConst ? "const" : "let"); }
				}
			}
		}
	}

	// `var` is function-scoped no matter how deeply nested in blocks/loops/try/switch: collect
	// recursively (not into nested functions/classes, which are their own var scope). Idempotent, so
	// re-running at each block entry is harmless.
	for (const name of collectVarNames(statements)) { scope.declareVar(name); }
}

/** All identifiers bound by a (possibly destructuring) binding name. */
export function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
	if (ts.isIdentifier(name)) { out.push(name.text); } else {
		for (const element of name.elements) {
			if (!ts.isOmittedExpression(element)) { bindingNames(element.name, out); }
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

		if (ts.isFunctionLike(node) || ts.isClassLike(node)) { continue; } // own var scope
		if (isAmbient(node)) { continue; } // `declare var x` describes a host binding; it never creates one
		if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using)) === 0) {
			for (const decl of node.declarations) { bindingNames(decl.name, out); }
		}

		if (ts.isEnumDeclaration(node) && !isAmbient(node)) { out.push(node.name.text); } // tsc emits `var E` (also as a bare `if` branch)
		const children: ts.Node[] = [];

		ts.forEachChild(node, (child) => void children.push(child));
		for (let i = children.length - 1; i >= 0; i--) { pending.push(children[i]); }
	}

	return out;
}

/** Ambient (`declare ...`) statements describe host shapes for the checker; they never execute. */
export function isAmbient(node: ts.Node): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === K.DeclareKeyword);
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
		vm.importModule(specifier); // side-effect import

		return;
	}

	if (clause.isTypeOnly) { return; }
	const ns = vm.importModule(specifier) as Record<string, unknown>;
	const bind = (name: string, value: unknown): void => {
		scope.declareLexical(name, "const");
		scope.initialize(name, value);
	};

	if (clause.name) { bind(clause.name.text, vm.fromHost((ns as { "default"?: unknown }).default ?? ns)); } // default import
	const bindings = clause.namedBindings;

	if (bindings && ts.isNamespaceImport(bindings)) {
		bind(bindings.name.text, ns);
	} else if (bindings && ts.isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			if (element.isTypeOnly) { continue; }
			bind(element.name.text, vm.fromHost(ns[(element.propertyName ?? element.name).text]));
		}
	}
}

/** No handlers to register: this module only provides helpers. */
export function register(): void {
}
