import { builtinModules } from "node:module";
import * as url from "node:url";
import * as esbuild from "esbuild";
import { build, defineConfig, type Plugin, type RollupOutput } from "vite";

// Every node builtin, in both bare (`fs`) and `node:`-prefixed (`node:fs`) forms — for keeping them external
// so almostnode resolves them to its own shims at runtime instead of vite bundling/polyfilling them.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/**
 * Bundles the hello extension (extensions/hello/extension.ts → browser CJS) into a string exposed as the
 * `hello:extension` virtual module; workbench-entry registers it via a data: URL. `vscode` stays
 * external (the host injects it).
 *
 * Uses vite's own programmatic `build()` (lib mode, in-memory) rather than a direct esbuild pass — vite
 * is the one bundler this repo depends on, so there's no extra dev dependency. `configFile: false`
 * isolates this nested build from the entry config so it doesn't recurse.
 */
/** Bundle `extensions/<name>/<file>.ts` (deps inlined) into a virtual module `<name>:<id>` exposing the
 *  built code as a default-export string. `externals` stay unbundled; `plugins` are handed to the nested
 *  build so it can resolve OTHER virtual modules (e.g. an extension that imports its worker's bundle). */
function bundledModule(name: string, file: string, id: string, format: "cjs" | "es", externals: string[], plugins: Plugin[] = [], alias: Record<string, string> = {}): Plugin {
	const virtual = `${name}:${id}`;
	const resolved = "\0" + virtual;
	const dir = url.fileURLToPath(new URL(`./extensions/${name}/`, import.meta.url));

	return {
		"name": `${name}-${id}`,
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async (moduleId) => {
			if (moduleId !== resolved) {
				return undefined;
			}

			const output = await build({
				"configFile": false,
				"logLevel": "silent",
				// Anchor node resolution at THIS package so a nested build can resolve deps; explicit aliases
				// (below) are what actually resolve bare deps like almostnode — configFile:false leaves the
				// double-nested resolver unable to walk node_modules for them on its own.
				"root": url.fileURLToPath(new URL(".", import.meta.url)),
				"resolve": { "alias": alias },
				"plugins": plugins,
				"build": {
					"write": false,
					"minify": true,
					"target": "esnext",
					"lib": { "entry": dir + file, "formats": [format], "fileName": id },
					// inlineDynamicImports: emit ONE self-contained chunk. Large servers (eslint + typescript)
					// have dynamic imports that otherwise get code-split into sibling chunks — but we capture only
					// the entry chunk as a string, so those siblings would be missing at runtime (almostnode:
					// "Cannot find module './…-<hash>.js'"). Inlining keeps the whole graph in the one string.
					"rollupOptions": { "external": externals, "output": { "inlineDynamicImports": true } }
				}
			}) as RollupOutput[];

			// One self-contained chunk (inlineDynamicImports); grab its code.
			const code = output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";

			return `export default ${JSON.stringify(code)};`;
		}
	};
}

/** An extension's `extension.ts` → browser CJS string (`<name>:extension`), `vscode` external. */
function bundledExtension(name: string, plugins: Plugin[] = []): Plugin {
	return bundledModule(name, "extension.ts", "extension", "cjs", ["vscode"], plugins);
}

/** esbuild's lib-mode bundle of a node server → one self-contained ESM string, node builtins external. Used
 *  for the eslint server: typescript (pulled in by @typescript-eslint/parser) does NOT survive rolldown's
 *  bundling here (its parser throws "n.parse is not a function" at runtime) whereas esbuild bundles it
 *  correctly. minifyIdentifiers ONLY: renaming locals keeps the code multi-line and standardly-spaced, which
 *  almostnode's (regex-based) ESM transform tolerates — whereas minifyWhitespace one-lines it and minifySyntax
 *  restructures statements, both of which break that transform at runtime ("Unexpected token"). So this is the
 *  safe minify level under almostnode (~15MB → ~10MB); a full shrink needs the native-ESM/SW-resolver path. */
async function esbuildNodeServer(entry: string): Promise<string> {
	const result = await esbuild.build({
		"entryPoints": [entry],
		"bundle": true,
		"format": "esm",
		"platform": "node",
		// The "browser" export condition so vscode-languageserver/browser (its ./browser subpath is
		// browser-condition-only) resolves; node builtins stay external for almostnode either way.
		"conditions": ["browser", "import", "default"],
		"target": "esnext",
		// Identifiers only — see the note above; whitespace/syntax minification breaks almostnode's transform.
		"minifyIdentifiers": true,
		// jiti is eslint's config-loader's lazy `import("jiti")`; the Linter path we use never reaches it, so
		// leave it external (unresolved) rather than pulling it in. Revisit when we load config FILES.
		"external": [...nodeBuiltins, "jiti", "jiti/*"],
		"write": false,
		"logLevel": "silent"
	});

	return result.outputFiles[0].text;
}

/** A language server's `<file>` → ESM string (`<name>:<id>`) with ALL NODE BUILTINS EXTERNAL, so
 *  `import … from "fs"`/`"zlib"`/… survive for almostnode to resolve to its shims; the engine (cspell-lib /
 *  eslint + @typescript-eslint/parser + typescript) and the LSP lib are inlined. Written to the VFS and run by
 *  almostnode inside a worker host (built separately by lsp.config.ts). MUST be ESM: almostnode detects module
 *  type by content, so the `import`/`export` statements are what make it run as a module (the bundler strips
 *  the TS types almostnode won't; almostnode also injects `require`, so CJS deps' dynamic requires resolve).
 *
 *  `bundler` chooses vite/rolldown or esbuild — they are NOT interchangeable here: cspell bundles cleanly with
 *  rolldown but esbuild's output trips almostnode's transform ("Unexpected token 'var'"), while eslint's
 *  typescript needs esbuild (rolldown mis-bundles it). So each server uses the bundler that runs under
 *  almostnode. `id` defaults to "server-node". Exported so lsp.config's build can resolve `<name>:<id>`. */
export function bundledNodeServer(name: string, file = "server-node.ts", id = "server-node", bundler: "vite" | "esbuild" = "vite"): Plugin {
	if (bundler === "vite") {
		return bundledModule(name, file, id, "es", nodeBuiltins);
	}

	const virtual = `${name}:${id}`;
	const resolved = "\0" + virtual;
	const entry = url.fileURLToPath(new URL(`./extensions/${name}/${file}`, import.meta.url));

	return {
		"name": `${name}-${id}`,
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async (moduleId) => (moduleId === resolved ? `export default ${JSON.stringify(await esbuildNodeServer(entry))};` : undefined)
	};
}

/**
 * Builds the iframe entry (workbench-entry.tsx → dist/workbench.js) that renders the composed
 * <Workbench/> and boots monaco. The monaco-vscode-api bundle is kept EXTERNAL and mapped to the
 * sibling `./main.js` (served alongside by vite.ts from the local component's dist), so it isn't
 * re-bundled into this small entry.
 *
 * Two-pass build: this runs FIRST (→ dist/), then the host build (vite.config.ts) serves dist/ +
 * the component dist under /__vscode__/.
 */
export default defineConfig({
	"plugins": [bundledExtension("hello"), bundledExtension("preflight"), bundledExtension("lsp-host")],
	"esbuild": {
		"jsx": "automatic",
		"jsxImportSource": "preact"
	},
	"build": {
		"target": "esnext",
		"outDir": "dist",
		"emptyOutDir": true,
		"minify": true,
		"rollupOptions": {
			"input": { "workbench": "workbench-entry.tsx" },
			"external": ["@brianjenkins94/monaco-vscode-api/main"],
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"chunkFileNames": "[name].js",
				"paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" }
			}
		}
	}
});
