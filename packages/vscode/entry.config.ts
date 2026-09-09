import { defineConfig } from "vite";

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
