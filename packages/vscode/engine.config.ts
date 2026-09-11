import * as url from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the preflight ENGINE (extensions/preflight/engine.ts → dist/preflight/engine.js) — the ESM/wasm
 * half of the capability overlay, kept OUT of the VS Code extension host (see workbench-entry.tsx +
 * CodinGame/monaco-vscode-api#818). It bundles the capability kernel (../../src/*) with oxc-parser
 * (browser field → wasm), tsval (raw TS source), the self-contained bablr dist, and typescript.
 *
 * Output lands in this package's `dist/` (served at /__vscode__/ by vite.ts, with COEP so the engine's
 * wasm + WASI worker get SharedArrayBuffer). It runs AFTER entry.config.ts (which empties dist/), so
 * `emptyOutDir` is FALSE here — it lays the engine down next to workbench.js.
 *
 * Nothing is external: the engine is a leaf module loaded by dynamic import(), so it carries its own deps.
 */
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

/**
 * The engine build, parameterised so two variants share one config:
 *   • default (`engine.js`) — bundles `typescript`; loaded by the extension host for the step-1 output.
 *   • plugin (`engine.plugin.js`, `typescriptExternal`) — aliases `typescript` to the ts-external shim so it
 *     uses tsserver's already-loaded `ts` (route 3 B: shed the ~7MB copy). Run INSIDE the tsserver plugin.
 */
export function engineConfig(options: { "entryName": string; "typescriptExternal"?: boolean }) {
	const alias: Record<string, string> = {
		"@brianjenkins94/tsval/typed": resolvePath("../tsval/src/typed.ts"),
		"@brianjenkins94/tsval": resolvePath("../tsval/src/index.ts"),
		"@brianjenkins94/bablr": resolvePath("../bablr/dist/index.js")
	};

	if (options.typescriptExternal === true) {
		// Resolve every `import ts from "typescript"` to the shim (tsserver's ts via globalThis), not a copy.
		alias.typescript = resolvePath("./extensions/preflight/ts-external.js");
	}

	return defineConfig({
		// Relative base (like the host build) so the engine's emitted asset URLs — the oxc `.wasm` and its WASI
		// worker — are RELATIVE to import.meta.url. Served under /__vscode__/preflight/, an absolute-from-root
		// base would point the wasm fetch at /preflight/… (unserved → the SPA index.html, breaking wasm compile).
		"base": "./",
		// The @brianjenkins94/* workspace packages aren't symlinked into node_modules; mirror the root tsconfig
		// `paths`. bablr → its self-contained dist (no @bablr/* graph).
		"resolve": { "alias": alias },
		// oxc's nested WASI worker must be an ES module worker (it uses import + top-level await).
		"worker": { "format": "es" },
		"build": {
			"target": "esnext",
			"outDir": "dist",
			"emptyOutDir": false,
			"minify": false,
			"sourcemap": true,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				// This entry is IMPORTED (by dynamic import), not a page script, so its exports must survive —
				// vite's app build otherwise drops them (preserveEntrySignatures: false) and tree-shakes
				// `runPreflight` away.
				"preserveEntrySignatures": "strict",
				"input": { [options.entryName]: resolvePath("./extensions/preflight/engine.ts") },
				"output": {
					"format": "es",
					"entryFileNames": "[name].js",
					"chunkFileNames": "preflight/[name]-[hash].js",
					"assetFileNames": "preflight/[name]-[hash][extname]"
				}
			}
		}
	});
}

// Only the typescript-external plugin engine is built (engine.plugin.config.ts). A default export is still
// required for a vite config module, but it is not used to produce output.
export default engineConfig({ "entryName": "preflight/engine" });
