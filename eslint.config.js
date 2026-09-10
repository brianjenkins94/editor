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
	},
	{
		// The BABLR grammar is a class of parser PRODUCTIONS, not ordinary methods, and a few "everything-on"
		// rules are semantically impossible to satisfy on it rather than merely noisy:
		//   • naming-convention — a production's name IS its grammar symbol: `*_Type()` is what `<_Type />` calls
		//     and `*Statement()` what `<Statement />` calls. Renaming them to camelCase would break the grammar.
		//   • class-methods-use-this — productions are dispatched by the BABLR runtime off the class and drive the
		//     parse through the yielded instruction API (eat/match/…); many legitimately never touch `this`. They
		//     cannot be hoisted to free functions without losing that dispatch.
		//   • require-unicode-regexp — the grammar's regexes run on BABLR's own regex VM, which does not implement
		//     the `u` flag's semantics (see the UPSTREAM-WORKAROUND header in grammar.ts); adding `/u` is wrong.
		"files": ["packages/bablr-language-ts/lib/grammar.ts"],
		"rules": {
			"ts/naming-convention": "off",
			"ts/class-methods-use-this": "off",
			"require-unicode-regexp": "off"
		}
	},
	{
		// Vendored hand-synced forks: monaco's `main.ts` tracks the upstream CodinGame demo and `record.js` is the
		// @bablr/record shim. We keep them at minimal diff from upstream so re-syncing stays a clean apply — style
		// conformance here would be pure drift. Their earlier error-level violations were already fixed in place.
		"files": ["components/monaco-vscode-api/main.ts", "packages/bablr/shims/record.js"],
		"rules": {
			"style/no-tabs": "off",
			"style/max-statements-per-line": "off",
			"ts/require-await": "off",
			"id-length": "off",
			"guard-for-in": "off",
			"no-nested-ternary": "off",
			"complexity": "off"
		}
	}
];
