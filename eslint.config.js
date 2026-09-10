import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	{
		// CI fails only on ERRORS (util-lint counts errorCount); warnings never fail it. Almost everything is
		// LINTED, including the vendored monaco `main.ts` and the vendored `@bablr/record` shim — their few
		// error-level violations were fixed in place (they still carry non-failing style warnings). Only truly
		// un-lintable / non-source paths are ignored:
		//   • build output (dist) and monaco's regenerated demo (vendored CodinGame source)
		//   • tsval's vendored differential corpora, generated test reports, and markdown (no tsconfig for typed rules)
		"ignores": ["**/dist/**", "**/demo/**", "packages/tsval/vendor/**", "packages/*/test/reports/**", "**/*.md"]
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
