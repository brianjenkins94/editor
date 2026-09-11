import * as url from "node:url";
import { build, defineConfig, type Plugin, type RollupOutput } from "vite";

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
					"rollupOptions": { "external": externals }
				}
			}) as RollupOutput[];

			// One format → one bundle → one chunk; grab its code.
			const code = output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";

			return `export default ${JSON.stringify(code)};`;
		}
	};
}

/** An extension's `extension.ts` → browser CJS string (`<name>:extension`), `vscode` external. */
function bundledExtension(name: string, plugins: Plugin[] = []): Plugin {
	return bundledModule(name, "extension.ts", "extension", "cjs", ["vscode"], plugins);
}

/** An extension's `server-node.ts` → ESM string (`<name>:server-node`) with NODE BUILTINS EXTERNAL, so
 *  `import … from "fs"`/`"path"` survive for almostnode to resolve; the LSP lib is inlined. Written to the
 *  VFS and run by almostnode inside the worker host (server-host.ts, built separately by lsp.config.ts).
 *  MUST be ESM: almostnode detects module type by content, so the `import`/`export` statements are what make
 *  it run as a module (and vite has already stripped the TS types almostnode won't). Exported so that build
 *  can resolve `<name>:server-node`. */
export function bundledNodeServer(name: string): Plugin {
	return bundledModule(name, "server-node.ts", "server-node", "es", ["fs", "path", "node:fs", "node:path"]);
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
