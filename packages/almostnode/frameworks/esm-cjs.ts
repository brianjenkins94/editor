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

/** What a module's own `require` (`const require = createRequire(import.meta.url)`) is renamed to: the emit's imports
 *  call `require`, which must stay the loader's — in Node an ES module's imports never go through a local `require`. */
const OWN_REQUIRE = "require$own";

/** `code` with the module's own top-level `require` binding — and every reference to it — renamed, when it has one. */
function renameOwnRequire(code: string, sourceFile: ts.SourceFile): string {
	const declares = sourceFile.statements.some((statement) => (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "require"))
		|| (ts.isFunctionDeclaration(statement) && statement.name?.text === "require"));

	if (!declares) {
		return code;
	}

	const at: number[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === "require") {
			const { parent } = node;
			const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
				|| ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && parent.name === node);

			if (!isPropertyName) {
				at.push(node.getStart(sourceFile));
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	let renamed = code;

	for (const start of at.sort((left, right) => right - left)) {
		renamed = renamed.slice(0, start) + OWN_REQUIRE + renamed.slice(start + "require".length);
	}

	return renamed;
}

/** `code` (an ES module, JavaScript or TypeScript) as CommonJS. */
export function transformEsmToCjsSimple(code: string): string {
	const sourceFile = ts.createSourceFile("module.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

	return ts.transpileModule(renameOwnRequire(code, sourceFile), {
		"fileName": "module.tsx",
		"compilerOptions": { "module": ts.ModuleKind.CommonJS, "target": ts.ScriptTarget.ESNext, "esModuleInterop": true, "jsx": ts.JsxEmit.Preserve, "verbatimModuleSyntax": false, "isolatedModules": true }
	}).outputText;
}
