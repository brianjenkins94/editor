import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import * as url from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the ESLint ENGINE (extensions/eslint/engine.ts → dist/lsp/eslint-engine.js) — eslint's browser-safe
 * `universal` Linter + @typescript-eslint/parser — with `typescript` EXTERNALIZED to the ts-external shim so it
 * uses tsserver's already-loaded `ts` (no bundled ~6MB copy). Loaded INSIDE the tsserver plugin (ts-plugin.js),
 * which sets `globalThis.__eslintTs` before importing it, via a native dynamic import of this served URL.
 *
 * Runs after the LSP build (lsp.config.ts), which doesn't empty dist/, so emptyOutDir is FALSE — it lays the
 * engine next to the served /__vscode__/lsp/ workers.
 *
 * NODE POLYFILLS: the engine runs in the tsserver worker, NOT almostnode, so almostnode's node shims aren't
 * there. typescript-estree pulls a few node builtins at module load (`node:path`, `node:util`) and its deps
 * read `process` — polyfillNode() covers all of it (functional builtins → node-stdlib-browser, the rest →
 * no-op stubs, plus injected process/Buffer globals). Deps are still resolved through their `browser` condition
 * so e.g. debug takes its browser variant.
 */
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
	"base": "./",
	"resolve": {
		// tsserver's own `ts`, via the CJS shim (globalThis.__eslintTs) — the whole point: no bundled copy.
		// Regex (whole-match replacement) so EVERY specifier resolves to the shim: bare `typescript` AND subpaths
		// like `typescript/lib/tsserverlibrary` (what @typescript-eslint/project-service requires — and, in fact,
		// exactly what tsserver hands a plugin as `modules.typescript`). A plain string alias would rewrite the
		// subpath to `ts-external.js/lib/tsserverlibrary` (treating the shim file as a directory).
		"alias": [
			{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("./extensions/eslint/ts-external.js") },
			// esquery (eslint's AST-selector matcher) ships a `module` (ESM, default-export-only) build that the
			// browser/import conditions pick — but eslint does `require("esquery")` and then `esquery.parse(...)`,
			// so the ESM namespace (`{ default: fn }`) leaves `esquery.parse` undefined ("esquery.parse is not a
			// function"). Pin it to the CJS build so `module.exports = esquery` (the fn with .parse/.matches) is
			// what eslint's require receives.
			{ "find": /^esquery$/u, "replacement": resolvePath("./node_modules/esquery/dist/esquery.min.js") }
		],
		// Prefer browser builds (debug → its browser variant, no process/tty).
		"conditions": ["browser", "import", "default"]
	},
	// Handles the node-builtin surface (path/util/… → polyfills, fs/… → stubs) + process/Buffer globals.
	"plugins": [polyfillNode()],
	"build": {
		"target": "esnext",
		"outDir": "dist",
		"emptyOutDir": false,
		"minify": false,
		"sourcemap": true,
		"assetsInlineLimit": 0,
		"rollupOptions": {
			// Dynamic-imported leaf module (not a page script) — keep its exports (lintText) from being
			// tree-shaken away by an app build's preserveEntrySignatures:false.
			"preserveEntrySignatures": "strict",
			"input": { "lsp/eslint-engine": resolvePath("./extensions/eslint/engine.ts") },
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"chunkFileNames": "lsp/[name]-[hash].js",
				"assetFileNames": "lsp/[name]-[hash][extname]"
			}
		}
	}
});
