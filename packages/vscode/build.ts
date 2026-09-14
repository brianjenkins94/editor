import { builtinModules, createRequire } from "node:module";
// eslint-disable-next-line ts/no-restricted-imports -- build-time script; needs sync fs to read assets off disk
import * as nodeFs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as esbuild from "esbuild";
import { isCI, isEntry } from "@brianjenkins94/util/env";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { build, type Plugin, type RollupOutput } from "vite";
import { editorTypesPlugin, editorVersionsPlugin, editorWorkspacePlugin } from "./snapshot";
import { nodeModulesCdnPlugin, vscodePlugin } from "./vite";

/**
 * The whole packages/vscode build, in ONE file — the five vite passes that used to be separate `-c` configs
 * (entry / lsp / eslint.engine / host / sw). `preBuild()` runs the four that emit into dist/ + docs/ (workbench
 * entry, lsp workers, eslint engine, sw); `hostBuild()` is the host site that serves the accumulated dist/ +
 * component under /__vscode__/. Order is load-bearing: the workbench entry empties dist/ FIRST, every later
 * pass sets emptyOutDir:false. `build` runs both; `dev.ts` runs preBuild() then serves the host live with
 * `hostPlugins()`. No vite.config.ts — buildPackage passes an inline config; nothing to auto-load.
 */
export const root = url.fileURLToPath(new URL(".", import.meta.url));
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

// Every node builtin, bare (`fs`) and `node:`-prefixed — kept external so almostnode resolves them to its own
// shims at runtime instead of vite bundling/polyfilling them.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Virtual-module bundlers (extensions + almostnode node servers), formerly entry.config.ts helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bundle `extensions/<name>/<file>.ts` (deps inlined) into a virtual module `<name>:<id>` exposing the built
 *  code as a default-export string. `externals` stay unbundled. `configFile:false` isolates the nested build. */
function bundledModule(name: string, file: string, id: string, format: "cjs" | "es", externals: string[]): Plugin {
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
				"root": root,
				"build": {
					"write": false,
					"minify": isCI,
					"target": "esnext",
					"lib": { "entry": dir + file, "formats": [format], "fileName": id },
					// One self-contained chunk: large servers have dynamic imports that would otherwise code-split
					// into siblings we don't capture (we grab only the entry chunk as a string).
					"rollupOptions": { "external": externals, "output": { "inlineDynamicImports": true } }
				}
			}) as RollupOutput[];

			const code = output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";

			return `export default ${JSON.stringify(code)};`;
		}
	};
}

/** An extension's `extension.ts` → browser CJS string (`<name>:extension`), `vscode` external. */
function bundledExtension(name: string): Plugin {
	return bundledModule(name, "extension.ts", "extension", "cjs", ["vscode"]);
}

/** esbuild lib-mode bundle of a node server → one self-contained ESM string, node builtins external. eslint's
 *  typescript survives esbuild but not rolldown here; cspell is the reverse — so each server picks its bundler. */
async function esbuildNodeServer(entry: string): Promise<string> {
	const result = await esbuild.build({
		"entryPoints": [entry],
		"bundle": true,
		"format": "esm",
		"platform": "node",
		"conditions": ["browser", "import", "default"],
		"target": "esnext",
		// Identifiers only — whitespace/syntax minification breaks almostnode's regex ESM transform.
		"minifyIdentifiers": true,
		"external": [...nodeBuiltins, "jiti", "jiti/*"],
		"write": false,
		"logLevel": "silent"
	});

	return result.outputFiles[0].text;
}

/** A language server's `<file>` → ESM string (`<name>:<id>`) with ALL NODE BUILTINS EXTERNAL, run by almostnode
 *  in a worker host. `bundler` picks vite/rolldown or esbuild (not interchangeable — see esbuildNodeServer). */
function bundledNodeServer(name: string, file = "server-node.ts", id = "server-node", bundler: "vite" | "esbuild" = "vite"): Plugin {
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

/** Emit the cspell English dictionary (gzipped trie) at a fixed, unhashed URL server-host fetches at runtime. */
function cspellDict(): Plugin {
	return {
		"name": "cspell-dict",
		"generateBundle": function() {
			const dictDir = path.dirname(createRequire(import.meta.url).resolve("@cspell/dict-en_us/cspell-ext.json"));

			this.emitFile({ "type": "asset", "fileName": "lsp/dicts/en_US.trie.gz", "source": nodeFs.readFileSync(path.join(dictDir, "en_US.trie.gz")) });
		}
	};
}

/** Emit the eslint tsserver plugin VERBATIM next to the engine, so tsserver imports it from a served URL and
 *  its import.meta.url self-locates the sibling engine (copied byte-for-byte, not a vite input). */
function eslintTsPlugin(): Plugin {
	return {
		"name": "eslint-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "lsp/eslint-ts-plugin.js", "source": nodeFs.readFileSync(resolvePath("./extensions/eslint/ts-plugin.js")) });
		}
	};
}

// esquery's CJS build, resolved through eslint so it's found under npm's flat tree AND CI's pnpm workspace.
const esqueryCjs = createRequire(createRequire(import.meta.url).resolve("eslint")).resolve("esquery");

/** The host site's plugins — shared by the host BUILD (hostBuild) and the DEV server (dev.ts): cross-origin
 *  isolation headers, the baked workspace/types/versions snapshots, the CDN node_modules dev mirror, and
 *  vscodePlugin (serves the entry dist/ + component under /__vscode__/). */
export function hostPlugins(): Plugin[] {
	return [
		{
			"name": "coi-headers",
			"configureServer": function(server) {
				server.middlewares.use(function(_req, res, next) {
					res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
					res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
					next();
				});
			}
		},
		editorWorkspacePlugin(),
		editorTypesPlugin(),
		editorVersionsPlugin(),
		nodeModulesCdnPlugin(),
		vscodePlugin()
	];
}

/**
 * The passes that emit into dist/ (+ docs/coi-serviceworker.js) — everything the host build/dev server then
 * SERVES. Run before hostBuild() (full build) or before starting the dev server (dev.ts). Order matters: the
 * workbench entry empties dist/ first; the rest set emptyOutDir:false.
 */
export async function preBuild(): Promise<void> {
	// 1. Workbench iframe entry (workbench-entry.tsx → dist/workbench.js). monaco kept external → ./main.js.
	await buildPackage(root, {
		"plugins": [bundledExtension("hello"), bundledExtension("worker-pod"), bundledExtension("eslint")],
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		// One @brianjenkins94/hub / observability instance — CI's pnpm workspace double-instances `file:../hub`.
		"resolve": { "dedupe": ["@brianjenkins94/hub", "@brianjenkins94/observability"] },
		"build": {
			"outDir": "dist",
			"minify": isCI,
			"rollupOptions": {
				"input": { "workbench": "workbench-entry.tsx" },
				"external": ["@brianjenkins94/monaco-vscode-api/main"],
				"output": { "chunkFileNames": "[name].js", "paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" } }
			}
		}
	});

	// 2. LSP host + tsval debug workers (dist/lsp/), almostnode-hosted — node builtins external.
	await buildPackage(root, {
		"base": "./",
		"resolve": { "alias": { "@brianjenkins94/tsval": resolvePath("../tsval/src/index.ts") } },
		"plugins": [bundledNodeServer("worker-pod"), cspellDict()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": {
					"lsp/server-host": resolvePath("./extensions/worker-pod/server-host.ts"),
					"lsp/debug-worker": resolvePath("./extensions/worker-pod/debug-worker.ts")
				},
				"output": { "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});

	// 3. eslint engine (dist/lsp/eslint-engine.js) — typescript externalized to the shim, node builtins polyfilled.
	await buildPackage(root, {
		"base": "./",
		"resolve": {
			"alias": [
				{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("./extensions/eslint/ts-external.js") },
				{ "find": /^esquery$/u, "replacement": esqueryCjs }
			],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [polyfillNode(), eslintTsPlugin()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			// Sourcemap locally only (the ~7MB .map is debug-only, never fetched at runtime) — never in CI.
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "lsp/eslint-engine": resolvePath("./extensions/eslint/engine.ts") },
				"output": { "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});

	// 4. COI service worker (→ docs/coi-serviceworker.js), single-file ES module.
	await buildPackage(root, {
		"base": "./",
		"build": {
			"outDir": "../../docs",
			"emptyOutDir": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "coi-serviceworker": resolvePath("./coi-serviceworker.js") },
				"output": { "inlineDynamicImports": true }
			}
		}
	});
}

/** The host site (→ repo docs/), serving the pre-built dist/ + component under /__vscode__/. emptyOutDir FALSE
 *  so it lays down alongside the published package tarballs (docs/*.tgz). */
async function hostBuild(): Promise<void> {
	await buildPackage(root, {
		"base": "./",
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@brianjenkins94/hub", "@brianjenkins94/observability"] },
		"build": { "outDir": "../../docs", "emptyOutDir": false },
		"plugins": hostPlugins()
	});
}

// `tsx build.ts` → the full build. Imported by dev.ts (for preBuild/hostPlugins), where this guard stays false.
if (isEntry(import.meta)) {
	await preBuild();
	await hostBuild();
}
