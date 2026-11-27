import type { Logger, Plugin } from "vite";
import * as url from "node:url";
import { POLICY_SCHEMA } from "@brianjenkins94/util/silo/policy";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { coverage, emittedAsIs } from "./coverage";

const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));
const PLUGIN_FOLDER = "extensions/capabilities/node_modules/capabilities-ts-plugin";

export const CAPABILITIES_FILES = { "policy.schema.json": { "json": POLICY_SCHEMA }, "node_modules/capabilities-ts-plugin/package.json": { "json": { "name": "capabilities-ts-plugin", "version": "0.0.1", "browser": "index.js" } }, "packages.js": { "worker": "packages-worker.js" } };

function capabilitiesTsPlugin(): Plugin {
	return {
		"name": "capabilities-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": `${PLUGIN_FOLDER}/index.js`, "source": emittedAsIs(resolvePath("../extensions/capabilities/ts-plugin.js")) });
		}
	};
}

export async function buildCapabilities(root: string, { logger, sourcemap, banner }: { "logger": Logger; "sourcemap": boolean | "hidden"; "banner": string }): Promise<void> {
	const output = { "banner": banner, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" };
	const shared = { "outDir": "dist", "emptyOutDir": false, "minify": false, "sourcemap": sourcemap, "assetsInlineLimit": 0 };

	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": { "conditions": ["browser", "import", "default"] },
		"plugins": [...coverage(), polyfillNode(), capabilitiesTsPlugin()],
		"build": { ...shared, "rollupOptions": { "preserveEntrySignatures": "strict", "input": { [`${PLUGIN_FOLDER}/capabilities-engine`]: resolvePath("../extensions/capabilities/engine.ts") }, "output": output } }
	});
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": {
			"alias": [{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("../extensions/capabilities/ts-external.js") }],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [...coverage(), polyfillNode()],
		"build": { ...shared, "rollupOptions": { "preserveEntrySignatures": "strict", "input": { [`${PLUGIN_FOLDER}/capabilities-canary`]: resolvePath("../extensions/tsval/canary.ts") }, "output": output } }
	});
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"plugins": coverage(),
		"build": { ...shared, "modulePreload": false, "rollupOptions": { "preserveEntrySignatures": "strict", "input": { "lsp/packages-worker": resolvePath("../extensions/capabilities/packages-worker.ts") }, "output": { "banner": banner, "chunkFileNames": "lsp/packages-worker-[name]-[hash].js", "assetFileNames": "lsp/packages-worker-[name]-[hash][extname]" } } }
	});
}
