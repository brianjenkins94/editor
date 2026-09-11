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
		//   • packages/almostnode — a vendored fork of macaly/almostnode (trimmed upstream node-runtime source),
		//     kept close to upstream rather than restyled to this repo's rules (same rationale as tsval/vendor)
		"ignores": ["**/dist/**", "**/demo/**", "packages/almostnode/**", "packages/tsval/vendor/**", "packages/*/test/reports/**", "**/*.md"]
	},
	{
		// tsval's tests run on `node:test`, not vitest. @antfu's test config assumes vitest and its auto-fix
		// rewrites `node:test`→`vitest` (and `test`→`it`), which breaks them — keep the node:test convention.
		"files": ["**/*.test.*", "**/test/**"],
		"rules": {
			"test/no-import-node-test": "off",
			"test/consistent-test-it": "off",
			// A top-level `test(...)` returns a promise that is MEANT to float: under `node --test
			// --test-isolation=none`, `await`ing it during module evaluation deadlocks the runner (eval blocks on
			// the test, the test can't start until eval finishes). The floating call is the node:test idiom, so
			// no-floating-promises is a false positive on every top-level test in these files.
			"ts/no-floating-promises": "off"
		}
	},
	{
		// The BABLR grammar is a class of parser PRODUCTIONS, not ordinary methods, and two "everything-on"
		// rules are semantically impossible to satisfy on it rather than merely noisy:
		//   • naming-convention — a production's name IS its grammar symbol: `*_Type()` is what `<_Type />` calls
		//     and `*Statement()` what `<Statement />` calls. Renaming them to camelCase would break the grammar.
		//   • class-methods-use-this — productions are dispatched by the BABLR runtime off the class and drive the
		//     parse through the yielded instruction API (eat/match/…); many legitimately never touch `this`. They
		//     cannot be hoisted to free functions without losing that dispatch.
		"files": ["packages/bablr-language-ts/lib/grammar.ts"],
		"rules": {
			"ts/naming-convention": "off",
			"ts/class-methods-use-this": "off"
		}
	}
];
