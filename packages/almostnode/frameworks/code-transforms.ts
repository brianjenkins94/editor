/**
 * Code transforms for the dev servers — SLIM vendored copy.
 *
 * Upstream's frameworks/code-transforms.ts also carried acorn+css-tree JSX/TS/CSS-module transforms, but the
 * editor's dev server transpiles with the browser TypeScript (`ts.transpileModule`, see vite-dev-server.ts),
 * so only React-Refresh registration is needed here. Kept dep-light: the component detector reuses the same
 * `typescript` the transpiler already loads (no acorn, no css-tree). CSS Modules are deferred (see the
 * preview-pane plan).
 */
import ts from "typescript";

/**
 * Add React Refresh registration to transformed code — enables state-preserving HMR for React components.
 * Wraps the module with a Vite-compatible `import.meta.hot` context and, for files that define components,
 * registers them with the refresh runtime and accepts self-updates.
 */
export function addReactRefresh(code: string, filename: string): string {
	const components = detectReactComponents(code);

	if (components.length === 0) {
		return `// HMR Setup
import.meta.hot = window.__vite_hot_context__("${filename}");

${code}

// HMR Accept
if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
	}

	const registrations = components
		.map((name) => `  $RefreshReg$(${name}, "${filename} ${name}");`)
		.join("\n");

	return `// HMR Setup
import.meta.hot = window.__vite_hot_context__("${filename}");

${code}

// React Refresh Registration
if (import.meta.hot) {
${registrations}
  import.meta.hot.accept(() => {
    if (window.$RefreshRuntime$) {
      window.$RefreshRuntime$.performReactRefresh();
    }
  });
}
`;
}

function isUppercaseStart(name: string): boolean {
	return name.length > 0 && name[0] >= "A" && name[0] <= "Z";
}

/**
 * Detect React components: top-level functions/arrows with uppercase names. TypeScript AST, regex fallback.
 */
function detectReactComponents(code: string): string[] {
	try {
		return detectReactComponentsAst(code);
	} catch {
		return detectReactComponentsRegex(code);
	}
}

function detectReactComponentsAst(code: string): string[] {
	// ScriptKind.TSX parses the JS/JSX/TS superset the transpiler emits; components are top-level, so a scan of
	// sourceFile.statements matches acorn's `ast.body` walk. An `export`ed function/class is still a
	// Function/ClassDeclaration node here (the `export` is just a modifier), so one check covers the plain,
	// `export`, and `export default` forms that were three separate branches under acorn's ESTree.
	const sourceFile = ts.createSourceFile("module.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const components: string[] = [];

	const add = (name: string): void => {
		if (isUppercaseStart(name) && !components.includes(name)) {
			components.push(name);
		}
	};

	for (const node of sourceFile.statements) {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
			add(node.name.text);
		}

		if (ts.isVariableStatement(node)) {
			for (const declarator of node.declarationList.declarations) {
				if (ts.isIdentifier(declarator.name) && declarator.initializer !== undefined
					&& (ts.isArrowFunction(declarator.initializer)
						|| ts.isFunctionExpression(declarator.initializer)
						|| ts.isCallExpression(declarator.initializer))) {
					add(declarator.name.text);
				}
			}
		}
	}

	return components;
}

function detectReactComponentsRegex(code: string): string[] {
	const components: string[] = [];
	const funcDeclRegex = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/gu;
	let match;

	while ((match = funcDeclRegex.exec(code)) !== null) {
		if (!components.includes(match[1])) {
			components.push(match[1]);
		}
	}

	const arrowRegex = /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*=/gu;

	while ((match = arrowRegex.exec(code)) !== null) {
		if (!components.includes(match[1])) {
			components.push(match[1]);
		}
	}

	return components;
}
