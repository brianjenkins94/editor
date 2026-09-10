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
function helloExtension(): Plugin {
	const id = "hello:extension";
	const resolved = "\0" + id;
	const dir = url.fileURLToPath(new URL("./extensions/hello/", import.meta.url));

	return {
		"name": "hello-extension",
		"resolveId": (source) => (source === id ? resolved : undefined),
		"load": async (moduleId) => {
			if (moduleId !== resolved) {
				return undefined;
			}

			const output = await build({
				"configFile": false,
				"logLevel": "silent",
				"build": {
					"write": false,
					"minify": true,
					"target": "esnext",
					"lib": { "entry": dir + "extension.ts", "formats": ["cjs"], "fileName": "extension" },
					"rollupOptions": { "external": ["vscode"] }
				}
			}) as RollupOutput[];

			// One format → one bundle → one chunk; grab its code.
			const code = output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";

			return `export default ${JSON.stringify(code)};`;
		}
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
	"plugins": [helloExtension()],
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
