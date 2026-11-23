/**
 * ESM→CJS source transform: TypeScript's own CommonJS emit (`transpileModule`), which keeps an ES module's semantics —
 * its imports are live (read through the imported module at each use, so a cycle sees a binding once it's set, not a
 * copy taken while the other module was still evaluating), its exported declarations keep their local names, and its
 * exports follow later assignments. The editor already ships `typescript`, so no second transformer is bundled.
 *
 * (It replaced a hand-written transform derived from macaly/almostnode@0.2.14's transformEsmToCjsSimple, which copied
 * imports by destructuring and turned `export const x = …` into `exports.x = …` without a local `x`: real packages —
 * eslint's plugins — broke on both.)
 */

import ts from "typescript";

/** The names the emit uses for the loader's — its imports call `require`, its exports assign `exports` — and what a
 *  module's own top-level binding of one is renamed to: in Node an ES module's `require`, `exports` and `module` are
 *  its own (`const require = createRequire(import.meta.url)`; unenv's net.mjs builds `const exports = {…}` for its
 *  default), never the loader's, so they can't take the emit's names. */
const OWN = new Map([["require", "require$own"], ["exports", "exports$own"], ["module", "module$own"]]);

/** The names of `statement`'s top-level bindings. */
function bound(statement: ts.Statement): string[] {
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
	}

	return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined ? [statement.name.text] : [];
}

/** `code` with the module's own top-level `require`, `exports` or `module` binding — and every reference to it — renamed,
 *  when it has one; a shorthand property keeps its name (`{ exports }`, `{ exports: exports$own }`). */
function renameOwn(code: string, sourceFile: ts.SourceFile): string {
	const own = new Set(sourceFile.statements.flatMap(bound).filter((name) => OWN.has(name)));

	if (own.size === 0) {
		return code;
	}

	const edits: [number, number, string][] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && own.has(node.text)) {
			const { parent } = node;
			const to = OWN.get(node.text)!;
			const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
				|| ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && parent.name === node);

			if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
				edits.push([node.getStart(sourceFile), node.getEnd(), `${node.text}: ${to}`]);
			} else if (ts.isExportSpecifier(parent) && parent.propertyName === undefined && parent.name === node) {
				edits.push([node.getStart(sourceFile), node.getEnd(), `${to} as ${node.text}`]);
			} else if (!isPropertyName) {
				edits.push([node.getStart(sourceFile), node.getEnd(), to]);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	let renamed = code;

	for (const [start, end, text] of edits.sort((left, right) => right[0] - left[0])) {
		renamed = renamed.slice(0, start) + text + renamed.slice(end);
	}

	return renamed;
}

/** `code` (an ES module, JavaScript or TypeScript) as CommonJS. */
export function transformEsmToCjsSimple(code: string): string {
	const sourceFile = ts.createSourceFile("module.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

	return ts.transpileModule(renameOwn(code, sourceFile), {
		"fileName": "module.tsx",
		"compilerOptions": { "module": ts.ModuleKind.CommonJS, "target": ts.ScriptTarget.ESNext, "esModuleInterop": true, "jsx": ts.JsxEmit.Preserve, "verbatimModuleSyntax": false, "isolatedModules": true }
	}).outputText;
}
