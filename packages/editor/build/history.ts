/**
 * The history extension's build (extensions/history/): its folder's tsserver plugin, as the package tsserver loads
 * (node_modules/history-ts-plugin/), and the engine that plugin runs — util/silo's reading over TypeScript's tree.
 */
import type { Logger, Plugin } from "vite";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";

const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

/** What goes in the extension's folder beside its entry (build.ts' bundledExtension): the plugin's package.json. */
export const HISTORY_FILES = { "node_modules/history-ts-plugin/package.json": { "json": { "name": "history-ts-plugin", "version": "0.0.1", "browser": "index.js" } } };

/** Emit the history tsserver plugin VERBATIM into its extension's folder, as the package tsserver loads
 *  (node_modules/history-ts-plugin/index.js), beside history-engine.js — its import.meta.url finds it (copied
 *  byte-for-byte, not a vite input). */
function historyTsPlugin(): Plugin {
	return {
		"name": "history-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "extensions/history/node_modules/history-ts-plugin/index.js", "source": fs.readFileSync(resolvePath("../extensions/history/ts-plugin.js"), { "encoding": null }) });
		}
	};
}

/** The history engine (dist/extensions/history/…/history-engine.js), run INSIDE the history tsserver plugin with
 *  tsserver's own `ts`: `typescript` is EXTERNALIZED to the ts-external shim (the plugin sets globalThis.__historyTs
 *  first), and no oxc — ts-analysis loads only silo's pure model and graph. `banner` gives it a `process`. */
export async function buildHistory(root: string, { logger, sourcemap, banner }: { "logger": Logger; "sourcemap": boolean | "hidden"; "banner": string }): Promise<void> {
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": {
			"alias": [{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("../extensions/history/ts-external.js") }],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [polyfillNode(), historyTsPlugin()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"minify": false,
			"sourcemap": sourcemap,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "extensions/history/node_modules/history-ts-plugin/history-engine": resolvePath("../extensions/history/engine.ts") },
				"output": { "banner": banner, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});
}
