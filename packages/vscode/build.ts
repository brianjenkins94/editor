import type { Plugin, RollupOutput } from "vite";
// eslint-disable-next-line ts/no-restricted-imports -- build-time script; needs sync fs to read assets off disk
import * as nodeFs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import { isCI, isEntry } from "@brianjenkins94/util/env";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import * as esbuild from "esbuild";
import stdlib from "node-stdlib-browser";
import { build } from "vite";
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

/** Same, for the capabilities tsserver plugin — emitted next to capabilities-engine.js so its import.meta.url
 *  self-locates the sibling engine. */
function capabilitiesTsPlugin(): Plugin {
	return {
		"name": "capabilities-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "lsp/capabilities-ts-plugin.js", "source": nodeFs.readFileSync(resolvePath("./extensions/capabilities/ts-plugin.js")) });
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
		"plugins": [bundledExtension("hello"), bundledExtension("worker-pod"), bundledExtension("eslint"), bundledExtension("capabilities")],
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		// One @brianjenkins94/hub / observability instance — CI's pnpm workspace double-instances `file:../hub`.
		// `buffer` → the node-stdlib-browser polyfill: isomorphic-git (the git SCM engine) uses the `Buffer` global,
		// which the browser lacks and this bundle otherwise doesn't polyfill; the alias makes the import resolve to
		// the real polyfill (git-engine.ts then assigns it to globalThis) instead of vite's empty browser stub.
		"resolve": { "dedupe": ["@brianjenkins94/hub", "@brianjenkins94/observability"], "alias": { "buffer": stdlib["buffer"] as string } },
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
		// `dedupe` collapses the two physical typescript installs (almostnode's own dep + tsval's) to ONE, so the
		// manualChunks below emits a single ~7MB ts chunk both workers share, not two copies in one 14MB chunk.
		// `@brianjenkins94/bablr` → its BUILT, browser-safe dist (the classify worker's CST engine): the alias uses
		// the fresh dist directly, sidestepping the pnpm file:-dep store staleness that bites workspace packages.
		"resolve": { "alias": { "@brianjenkins94/tsval": resolvePath("../tsval/src/index.ts"), "@brianjenkins94/bablr": resolvePath("../bablr/dist/index.js") }, "dedupe": ["typescript"] },
		"plugins": [bundledNodeServer("worker-pod"), cspellDict()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"assetsInlineLimit": 0,
			// These run as Web Workers (no DOM). Vite's default dynamic-import preload helper injects a
			// <link rel=modulepreload> via `document`, which throws in a worker — so the node worker's lazy
			// `import()` of the ViteDevServer (ts) chunk crashes. Disable the polyfill; workers just fetch chunks.
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": {
					"lsp/server-host": resolvePath("./extensions/worker-pod/server-host.ts"),
					"lsp/debug-worker": resolvePath("./extensions/worker-pod/debug-worker.ts"),
					"lsp/node-worker": resolvePath("./extensions/worker-pod/node-worker.ts"),
					// A git/SCM worker (not part of the LSP pod), but served from lsp/ like the other worker chunks.
					"lsp/git-classify-worker": resolvePath("./git-classify-worker.ts")
				},
				"output": {
					"chunkFileNames": "lsp/[name]-[hash].js",
					"assetFileNames": "lsp/[name]-[hash][extname]",
					// Force `typescript` into ONE shared chunk. The node worker (ViteDevServer transpile) loads it
					// lazily; the debug worker (tsval) would otherwise INLINE its own ~7MB copy — this makes both
					// reference the same lsp/typescript-*.js instead of shipping ts twice.
					"manualChunks": (id) => (/[\\/]node_modules[\\/]typescript[\\/]/u.test(id) ? "typescript" : undefined)
				}
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

	// 3b. capabilities engine (dist/lsp/capabilities-engine.js) — the STATIC capability analysis (util/silo's
	// reach + policy), run INSIDE the capabilities tsserver plugin (which anchors spans + enriches types). Pure
	// oxc + AST logic — no typescript, tsval, or bablr (the root `src/` kernel is superseded) — so the only alias
	// is oxc's wasm binding; oxc's wasm + its ES-module WASI worker emit alongside under lsp/ (worker output
	// co-located there, else the relative refs split dirs and 404).
	//
	// oxc's WASI runtime (@napi-rs/wasm-runtime) drives the wasm parser through node builtins (`node:path`,
	// `node:fs`, …), so those must be polyfilled for the browser. We pass ONLY the builtins that have a real browser
	// polyfill (a node-stdlib-browser entry) — never the stub-only ones. That deliberately excludes `node:wasi` (no
	// polyfill): polyfillNode would otherwise stub it to an empty module (→ "__nodeWASI is not a constructor"),
	// clobbering oxc's own browser WASI. An empty stub set also avoids polyfillNode's stub-loader syntax errors.
	const oxcPolyfills = polyfillNode(builtinModules.filter((builtin) => stdlib[builtin] !== undefined));

	// silo's reach chain also reads the `process.env` global at module eval. polyfillNode injects a `process`, but we
	// prepend a browser-flavored one (no `versions.node`) so napi-rs's runtime detection still picks its browser path.
	const PROCESS_SHIM = "globalThis.process=globalThis.process||{\"env\":{},\"argv\":[],\"platform\":\"browser\",\"cwd\":function(){return \"/\";}};";

	await buildPackage(root, {
		"base": "./",
		"resolve": {
			"alias": [
				// oxc's browser entry bare-imports its wasm binding, which pnpm only links into THIS package (a direct
				// devDep) — not into oxc-parser's own store dir, where the bundler resolves the import from. Point it at
				// the resolved entry so rolldown can bundle it (+ emit the .wasm / WASI worker) under lsp/. Crucially,
				// resolve to the package's BROWSER entry (parser.wasi-browser.js) — createRequire.resolve picks node's
				// `main` (parser.wasi.cjs), which imports `node:wasi`/`node:worker_threads` and drives @napi-rs down its
				// node WASI path (→ "__nodeWASI is not a constructor" in the browser). The browser entry uses @napi-rs's
				// own browser WASI runtime + the emitted wasi-worker-browser instead.
				{ "find": /^@oxc-parser\/binding-wasm32-wasi$/u, "replacement": createRequire(import.meta.url).resolve("@oxc-parser/binding-wasm32-wasi").replace(/parser\.wasi\.cjs$/u, "parser.wasi-browser.js") }
			]
		},
		"worker": { "format": "es", "rollupOptions": { "output": { "banner": PROCESS_SHIM, "entryFileNames": "lsp/[name]-[hash].js", "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" } } },
		"plugins": [oxcPolyfills, capabilitiesTsPlugin()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"minify": false,
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "lsp/capabilities-engine": resolvePath("./extensions/capabilities/engine.ts") },
				"output": { "banner": PROCESS_SHIM, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});

	// 3c. capabilities canary engine (dist/lsp/capabilities-canary.js) — the DYNAMIC half: runs the module in the
	// tsval interpreter and observes the concrete pre-call resource at each capability call (the middle column).
	// It runs INSIDE the tsserver plugin, so `typescript` is EXTERNALIZED to the ts-external shim (the plugin sets
	// globalThis.__capabilitiesTs = modules.typescript before loading it) — reusing tsserver's own ts and dropping
	// the ~7MB bundled copy (16.7MB → a few hundred KB). No oxc here either: the canary classifies by injected-
	// stand-in identity, not silo/reach's AST matchers, precisely to keep oxc out of this bundle.
	await buildPackage(root, {
		"base": "./",
		"resolve": {
			"alias": [
				{ "find": /^@brianjenkins94\/tsval$/u, "replacement": resolvePath("../tsval/src/index.ts") },
				{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("./extensions/capabilities/ts-external.js") }
			],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [polyfillNode()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"minify": false,
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "lsp/capabilities-canary": resolvePath("./extensions/capabilities/canary.ts") },
				"output": { "banner": PROCESS_SHIM, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
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
