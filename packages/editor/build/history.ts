import type { Logger, Plugin } from "vite";
import * as url from "node:url";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { coverage, emittedAsIs } from "./coverage";

const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

export const HISTORY_FILES = { "node_modules/history-ts-plugin/package.json": { "json": { "name": "history-ts-plugin", "version": "0.0.1", "browser": "index.js" } } };

function historyTsPlugin(): Plugin {
	return {
		"name": "history-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "extensions/history/node_modules/history-ts-plugin/index.js", "source": emittedAsIs(resolvePath("../extensions/history/ts-plugin.js")) });
		}
	};
}

export async function buildHistory(root: string, { logger, sourcemap, banner }: { "logger": Logger; "sourcemap": boolean | "hidden"; "banner": string }): Promise<void> {
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": {
			"alias": [{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("../extensions/history/ts-external.js") }],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [...coverage(), polyfillNode(), historyTsPlugin()],
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
