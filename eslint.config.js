import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	{
		// Build output, monaco's regenerated demo/ (vendored CodinGame source), tsval's vendored differential
		// corpora, and generated test reports — none of it is editor's own source.
		// Not editor's code to restyle: build output, monaco's regenerated demo + synced upstream fork
		// (main.ts), tsval's vendored corpora, the vendored @bablr/record shim, generated reports, and
		// markdown code blocks (no tsconfig for typed rules).
		"ignores": ["**/dist/**", "**/demo/**", "components/monaco-vscode-api/main.ts", "packages/tsval/vendor/**", "packages/bablr/shims/**", "packages/*/test/reports/**", "**/*.md"]
	},
	{
		// tsval's tests run on `node:test`, not vitest. @antfu's test config assumes vitest and its auto-fix
		// rewrites `node:test`→`vitest` (and `test`→`it`), which breaks them — keep the node:test convention.
		"files": ["**/*.test.*", "**/test/**"],
		"rules": {
			"test/no-import-node-test": "off",
			"test/consistent-test-it": "off"
		}
	}
];
