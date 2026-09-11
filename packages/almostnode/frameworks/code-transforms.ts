/**
 * Code transforms for the dev servers — SLIM vendored copy.
 *
 * Upstream's frameworks/code-transforms.ts also carried acorn+css-tree JSX/TS/CSS-module transforms, but the
 * editor's dev server transpiles with the browser TypeScript (`ts.transpileModule`, see vite-dev-server.ts),
 * so only React-Refresh registration is needed here. Kept dep-light: acorn only (no css-tree). CSS Modules are
 * deferred (see the preview-pane plan).
 */
import * as acorn from "acorn";

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
 * Detect React components: top-level functions/arrows with uppercase names. Acorn AST, regex fallback.
 */
function detectReactComponents(code: string): string[] {
	try {
		return detectReactComponentsAst(code);
	} catch {
		return detectReactComponentsRegex(code);
	}
}

function detectReactComponentsAst(code: string): string[] {
	const ast = acorn.parse(code, { "ecmaVersion": "latest", "sourceType": "module" });
	const components: string[] = [];

	// eslint-disable-next-line ts/no-explicit-any -- acorn's Node type is loose; we read a few known fields
	for (const node of (ast as any).body) {
		if (node.type === "FunctionDeclaration" && node.id && isUppercaseStart(node.id.name)) {
			if (!components.includes(node.id.name)) {
				components.push(node.id.name);
			}
		}

		if (node.type === "ExportDefaultDeclaration"
			&& node.declaration?.type === "FunctionDeclaration"
			&& node.declaration.id && isUppercaseStart(node.declaration.id.name)) {
			if (!components.includes(node.declaration.id.name)) {
				components.push(node.declaration.id.name);
			}
		}

		if (node.type === "ExportNamedDeclaration"
			&& node.declaration?.type === "FunctionDeclaration"
			&& node.declaration.id && isUppercaseStart(node.declaration.id.name)) {
			if (!components.includes(node.declaration.id.name)) {
				components.push(node.declaration.id.name);
			}
		}

		const varDecl = node.type === "VariableDeclaration"
			? node
			: (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration")
				? node.declaration
				: null;

		if (varDecl) {
			for (const declarator of varDecl.declarations) {
				if (declarator.id?.name && isUppercaseStart(declarator.id.name) && declarator.init) {
					const initType = declarator.init.type;

					if (initType === "ArrowFunctionExpression" || initType === "FunctionExpression" || initType === "CallExpression") {
						if (!components.includes(declarator.id.name)) {
							components.push(declarator.id.name);
						}
					}
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
