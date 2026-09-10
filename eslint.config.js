import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	{
		// CI fails only on ERRORS (util-lint counts errorCount); warnings never fail it. So most of what used to
		// be ignored is now LINTED — bablr-language-ts/lib/{grammar,spans}.ts included (0 errors; grammar just
		// carries DSL-structural warnings). Ignore only what genuinely can't pass or is pure noise:
		//   • build output (dist) and monaco's regenerated demo (vendored CodinGame source)
		//   • components/monaco-vscode-api/main.ts — synced upstream fork; 0 errors but ~490 auto-fixable style
		//     warnings we don't want as noise (would pass CI if linted; restyling just drifts on re-sync)
		//   • packages/bablr/shims/** — the vendored @bablr/record shim; carries real ERRORS (mutable exports,
		//     no-undef, error-message) that are vendored code, not ours to fix
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
