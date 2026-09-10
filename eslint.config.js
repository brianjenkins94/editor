import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	{
		// Not editor's code to restyle: build output, monaco's regenerated demo (vendored CodinGame source) +
		// its install-generated tsconfig.js + synced upstream fork (main.ts), the bablr-DSL grammar (its lib/
		// is authored in bablr's grammar format, not editor's JS style), tsval's vendored differential
		// corpora, the vendored @bablr/record shim, generated test reports, and markdown code blocks (no
		// tsconfig for typed rules).
		"ignores": ["**/dist/**", "**/demo/**", "packages/tsval/vendor/**", "packages/bablr/shims/**", "packages/*/test/reports/**", "**/*.md"]
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
