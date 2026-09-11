import * as url from "node:url";
import { defineConfig } from "vite";
import { bundledNodeServer } from "./entry.config";

/**
 * Builds the LSP host's worker (extensions/lsp-host/server-host.ts → dist/lsp/server-host.js) — a normal
 * multi-chunk module graph, NOT a monolithic blob. server-host runs almostnode's in-realm Runtime inside
 * the worker and executes the node language server (server-node) through it; almostnode is bundled as an
 * ordinary dependency here (its lazy wasm / dynamic imports stay as separate emitted chunks — the thing a
 * single-file blob broke). bundledNodeServer supplies `lsp-host:server-node` (the node server as a CJS
 * string, node builtins external) that server-host hands to almostnode.
 *
 * Served under /__vscode__/lsp/ (vscodePlugin serves this package's dist/), with COEP from that route. The
 * lsp-host EXTENSION (data:-URL, ext host) can't emit/locate this itself, so it's built + served like the
 * preflight engine and spawned by URL (new Worker(new URL("./lsp/server-host.js", location.href))).
 *
 * Relative base (like the engine) so emitted asset URLs resolve under /__vscode__/lsp/. Runs after
 * entry.config (which empties dist/), so emptyOutDir is FALSE.
 */
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
	"base": "./",
	"plugins": [bundledNodeServer("lsp-host")],
	// oxc-style: if almostnode spawns a real (non-@vite-ignore'd) worker, build it as an ES module worker.
	"worker": { "format": "es" },
	"build": {
		"target": "esnext",
		"outDir": "dist",
		"emptyOutDir": false,
		"minify": false,
		"assetsInlineLimit": 0,
		"rollupOptions": {
			// Worker entry: imported by URL, not a page script — keep its side effects (it sets up the LSP
			// connection on load), so preserve the entry signature.
			"preserveEntrySignatures": "strict",
			"input": { "lsp/server-host": resolvePath("./extensions/lsp-host/server-host.ts") },
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"chunkFileNames": "lsp/[name]-[hash].js",
				"assetFileNames": "lsp/[name]-[hash][extname]"
			}
		}
	}
});
