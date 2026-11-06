/**
 * The capabilities extension's build (extensions/capabilities/): its folder's tsserver plugin, as the package tsserver loads
 * (node_modules/capabilities-ts-plugin/), and what that plugin runs: the engine (util/silo's reading of TypeScript's tree) and
 * the canary (tsval's sandboxed background run). Both run inside the plugin, so neither bundles a TypeScript.
 */
import type { Logger, Plugin } from "vite";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { POLICY_SCHEMA } from "@brianjenkins94/util/silo/policy";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";

const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));
const PLUGIN_FOLDER = "extensions/capabilities/node_modules/capabilities-ts-plugin";

/** What goes in the extension's folder beside its entry (build.ts' bundledExtension): the plugin's package.json. */
export const CAPABILITIES_FILES = { "policy.schema.json": { "json": POLICY_SCHEMA }, "node_modules/capabilities-ts-plugin/package.json": { "json": { "name": "capabilities-ts-plugin", "version": "0.0.1", "browser": "index.js" } } };

/** Emit the tsserver plugin VERBATIM into its extension's folder, beside the engine and the canary: its import.meta.url finds
 *  them (copied byte-for-byte, not a vite input). */
function capabilitiesTsPlugin(): Plugin {
	return {
		"name": "capabilities-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": `${PLUGIN_FOLDER}/index.js`, "source": fs.readFileSync(resolvePath("../extensions/capabilities/ts-plugin.js"), "utf8") });
		}
	};
}

/** The engine, reading the tree tsserver hands it and parsing nothing; and the canary, with `typescript` EXTERNALIZED to the
 *  ts-external shim (the plugin sets globalThis.__capabilitiesTs first). `banner` gives each a `process`. */
export async function buildCapabilities(root: string, { logger, sourcemap, banner }: { "logger": Logger; "sourcemap": boolean | "hidden"; "banner": string }): Promise<void> {
	const output = { "banner": banner, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" };
	const shared = { "outDir": "dist", "emptyOutDir": false, "minify": false, "sourcemap": sourcemap, "assetsInlineLimit": 0 };

	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": { "conditions": ["browser", "import", "default"] },
		"plugins": [polyfillNode(), capabilitiesTsPlugin()],
		"build": { ...shared, "rollupOptions": { "preserveEntrySignatures": "strict", "input": { [`${PLUGIN_FOLDER}/capabilities-engine`]: resolvePath("../extensions/capabilities/engine.ts") }, "output": output } }
	});
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": {
			"alias": [{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("../extensions/capabilities/ts-external.js") }],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [polyfillNode()],
		"build": { ...shared, "rollupOptions": { "preserveEntrySignatures": "strict", "input": { [`${PLUGIN_FOLDER}/capabilities-canary`]: resolvePath("../extensions/tsval/canary.ts") }, "output": output } }
	});
}
