import type { Plugin, RollupOutput } from "vite";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import { isCI, isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import stdlib from "node-stdlib-browser";
import { build } from "vite";
import { editorSettingsDefaultsPlugin, editorTypesPlugin, editorVersionsPlugin, editorWorkspacePlugin } from "./build/snapshot";
import { nodeModulesCdnPlugin, vscodePlugin, workbenchPreloadPlugin } from "./build/vite";
import { eslintPresetPlugin } from "./extensions/eslint/preset-build";

/**
 * The whole packages/editor build, in ONE file — the five vite passes that used to be separate `-c` configs
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

/** A browser-flavored `process` (no `versions.node`), prepended to bundles that run where there is none: silo's reach chain
 *  and util's env read the global at module eval. (polyfillNode injects a `process`, but napi-rs's runtime detection must
 *  still pick its browser path.) */
const PROCESS_SHIM = "globalThis.process=globalThis.process||{\"env\":{},\"argv\":[],\"platform\":\"browser\",\"cwd\":function(){return \"/\";}};";

/** The same `process`, but the bundle's own: an extension's bundle runs as a CommonJS module in the extension host, a realm
 *  every extension shares, where a global `process` makes other extensions (VS Code's TypeScript) take it for Node. */
const MODULE_PROCESS_SHIM = "var process=globalThis.process||{\"env\":{},\"argv\":[],\"platform\":\"browser\",\"cwd\":function(){return \"/\";}};";

/** Bundle `<folder>/<file>.ts` (a folder of this package, e.g. `extensions/bridge`; deps inlined) into a virtual
 *  module `<name>:<id>`, named for the folder's last segment, exposing the built code as a default-export string.
 *  `externals` stay unbundled. `configFile:false` isolates the nested build. */
function bundledModule(folder: string, file: string, id: string, format: "cjs" | "es" | "iife", externals: string[] | ((source: string, importer: string | undefined) => boolean), served = false, plugins: Plugin[] = [], banner?: string): Plugin {
	const name = folder.split("/").at(-1);
	const virtual = `${name}:${id}`;
	const resolved = "\0" + virtual;
	const dir = url.fileURLToPath(new URL(`./${folder}/`, import.meta.url));

	return {
		"name": `${name}-${id}`,
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async function(moduleId) {
			if (moduleId !== resolved) {
				return undefined;
			}

			const output = await build({
				"configFile": false,
				"logLevel": "silent",
				"root": root,
				"plugins": plugins,
				"build": {
					"write": false,
					"minify": isCI,
					// Script text, not a file: its map rides inline (locally only, as every pass's).
					"sourcemap": isCI ? false : "inline",
					"target": "esnext",
					"lib": { "entry": dir + file, "formats": [format], "fileName": id, ...format === "iife" ? { "name": id.replaceAll("-", "_") } : {} },
					// One self-contained chunk: large servers have dynamic imports that would otherwise code-split
					// into siblings we don't capture (we grab only the entry chunk as a string).
					"rollupOptions": { "external": externals, "output": { "inlineDynamicImports": true, ...banner === undefined ? {} : { "banner": banner } } }
				}
			}) as RollupOutput[];

			const code = output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";

			if (served) {
				// Emitted beside the entry (content-hashed, so a deploy never pairs a new entry with a stale copy) and
				// exported as its path: the code stays out of workbench.js, and whoever runs it fetches it.
				const fileName = `extensions/${name}-${createHash("sha256").update(code).digest("hex").slice(0, 8)}.js`;

				this.emitFile({ "type": "asset", "fileName": fileName, "source": code });

				return `export default ${JSON.stringify("./" + fileName)};`;
			}

			return `export default ${JSON.stringify(code)};`;
		}
	};
}

/** The module an extension's `vscode` imports resolve to (commandTap). */
const TAPPED_VSCODE = "\0vscode-tapped";

/** An extension's `extension.ts` → a served browser CJS file (`<name>:extension` is its path), `vscode` external. The
 *  extension host fetches it on activation, so none of it is on the workbench's boot path. Its `vscode` is tapped
 *  (commandTap): the architecture view discovers its commands. */
function bundledExtension(name: string): Plugin {
	// `vscode` is external only from the tapped module: the extension's own imports of it go to that module first.
	// The extension host has no `process`; util reads it as it loads.
	return bundledModule("extensions/" + name, "extension.ts", "extension", "cjs", (source, importer) => source === "vscode" && importer === TAPPED_VSCODE, true, [commandTap(name)], MODULE_PROCESS_SHIM);
}

/** Hand extension `name` a `vscode` whose commands and file operations are counted (extensions/command-tap.ts;
 *  DISCOVERED-ARCHITECTURE.md): every `import … from "vscode"` in it resolves to a module that is the real `vscode` but
 *  for `commands` and `workspace.fs`. */
function commandTap(name: string): Plugin {
	const tapped = TAPPED_VSCODE;
	const tap = url.fileURLToPath(new URL("./extensions/command-tap.ts", import.meta.url));

	return {
		"name": "command-tap",
		"enforce": "pre",
		// The tapped module's own `vscode` is the real one (external).
		"resolveId": (source, importer) => (source === "vscode" && importer !== tapped ? tapped : undefined),
		"load": (id) => (id === tapped ? `import * as vscode from "vscode";\nimport { tappedCommands, tappedWorkspace } from ${JSON.stringify(tap)};\nexport * from "vscode";\nexport const commands = tappedCommands(vscode, ${JSON.stringify(name)});\nexport const workspace = tappedWorkspace(vscode, ${JSON.stringify(name)});\n` : undefined)
	};
}

/** A language server's `<file>` → ESM string (`<name>:<id>`) with ALL NODE BUILTINS EXTERNAL, run by almostnode
 *  in a worker host. */
function bundledNodeServer(name: string, file = "server-node.ts", id = "server-node"): Plugin {
	return bundledModule("extensions/" + name, file, id, "es", nodeBuiltins);
}

/** Emit the cspell English dictionary (gzipped trie) at a fixed, unhashed URL server-host fetches at runtime. */
function cspellDict(): Plugin {
	return {
		"name": "cspell-dict",
		"generateBundle": function() {
			const dictDir = path.dirname(createRequire(import.meta.url).resolve("@cspell/dict-en_us/cspell-ext.json"));

			this.emitFile({ "type": "asset", "fileName": "lsp/dicts/en_US.trie.gz", "source": fs.readFileSync(path.join(dictDir, "en_US.trie.gz"), { "encoding": null }) });
		}
	};
}

/** The eslint engine's `node:module` — no browser polyfill exists, so Node's "nothing installed" semantics (node-module.js)
 *  — and what that module's runtime `require` can hand out, resolved from eslint's own install so they're the SAME
 *  instances the bundle already carries: eslint-utils, and eslint's builtin rule registry (browser-safe; the rest of
 *  `eslint/use-at-your-own-risk` is its Node API). Aliases, which outrank polyfillNode's stub for `module`. */
function eslintNodeModule(): Plugin {
	const eslintPackageJson = createRequire(import.meta.url).resolve("eslint/package.json");

	return {
		"name": "eslint-node-module",
		"config": () => ({
			"resolve": {
				"alias": [
					{ "find": /^(node:)?module$/u, "replacement": resolvePath("./extensions/eslint/node-module.js") },
					{ "find": /^eslint-registry:eslint-utils$/u, "replacement": createRequire(eslintPackageJson).resolve("@eslint-community/eslint-utils") },
					{ "find": /^eslint-registry:builtin-rules$/u, "replacement": path.join(path.dirname(eslintPackageJson), "lib", "rules", "index.js") }
				]
			}
		})
	};
}

/** `buffer` → the node-stdlib-browser polyfill, for the SHELL: its repo load clones with isomorphic-git (git-clone.ts),
 *  which uses the `Buffer` global, and the shell's bundle otherwise has no `buffer` to resolve (the package isn't a
 *  direct dependency). As the workbench pass's alias does for git-engine.ts; in dev, Vite pre-bundles it (it resolves
 *  into node_modules) into ESM. */
function shellBuffer(): Plugin {
	return { "name": "shell-buffer", "config": () => ({ "resolve": { "alias": { "buffer": stdlib["buffer"] } } }) };
}

/** Plugin code that passes `require` around as a VALUE — `optionalRequire(require, "typescript")` — hides the module id
 *  from the bundler, which leaves its runtime `require` (it throws in a worker). Rewrite `require` in argument position
 *  to the engine's registry-backed require (`globalThis.__eslintRequire`, see engine.ts / node-module.js). */
function valueRequireToRegistry(): Plugin {
	return {
		"name": "value-require-to-registry",
		"enforce": "pre",
		"transform": (code, id) => {
			if (!id.includes("/node_modules/") || !code.includes("require")) {
				return undefined;
			}

			const rewritten = code.replace(/([(,]\s*)require(\s*[,)])/gu, "$1globalThis.__eslintRequire$2");

			return rewritten === code ? undefined : { "code": rewritten, "map": null };
		}
	};
}

/** Emit the eslint tsserver plugin VERBATIM next to the engine, so tsserver imports it from a served URL and
 *  its import.meta.url self-locates the sibling engine (copied byte-for-byte, not a vite input). */
function eslintTsPlugin(): Plugin {
	return {
		"name": "eslint-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "lsp/eslint-ts-plugin.js", "source": fs.readFileSync(resolvePath("./extensions/eslint/ts-plugin.js"), { "encoding": null }) });
		}
	};
}

/** Same, for the capabilities tsserver plugin — emitted next to capabilities-engine.js so its import.meta.url
 *  self-locates the sibling engine. */
function capabilitiesTsPlugin(): Plugin {
	return {
		"name": "capabilities-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "lsp/capabilities-ts-plugin.js", "source": fs.readFileSync(resolvePath("./extensions/capabilities/ts-plugin.js"), { "encoding": null }) });
		}
	};
}

/** Same, for the history tsserver plugin — emitted next to history-engine.js so its import.meta.url self-locates it. */
function historyTsPlugin(): Plugin {
	return {
		"name": "history-ts-plugin-asset",
		"generateBundle": function() {
			this.emitFile({ "type": "asset", "fileName": "lsp/history-ts-plugin.js", "source": fs.readFileSync(resolvePath("./extensions/history/ts-plugin.js"), { "encoding": null }) });
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
		// The SHELL (main.tsx → shell.tsx) is built here, and it lazily imports the browser GitHub client
		// (github.ts → fido → util/env, util/store), which pulls in node builtins: `env.ts` reads `process`/`path`/`url`
		// at eval and `store.ts` (dynamic, browser-guarded) touches `fs`. `polyfillNode([...])` resolves these four AND
		// injects the `process`/`Buffer` globals env.ts needs. Scoped to this list so it can't stub a builtin another
		// chunk resolves itself. github.ts is dynamically imported, so fido + these polyfills land in a lazy chunk
		// (docs/github-*.js), off the shell's cold-start path.
		polyfillNode(["fs", "path", "url", "util"]),
		shellBuffer(),
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
		vscodePlugin(),
		workbenchPreloadPlugin(),
		dockviewCssPlugin()
	];
}

/**
 * `dockview:css` — dockview's stylesheet, as a string. dockview-core publishes none (its UMD bundle injects the sheet
 * as a `<style>`, and the ESM build we import has nothing), but the `dockview` package publishes that same sheet as a
 * file, `dist/styles/dockview.css` — so it's read from there, never lifted out of a bundle's code. The two packages are
 * pinned to one version (package.json), and the build checks that they are: the sheet must match the code it styles.
 */
function dockviewCssPlugin(): Plugin {
	const id = "dockview:css";

	return {
		"name": "dockview-css",
		"resolveId": (source) => (source === id ? "\0" + id : undefined),
		"load": (resolved) => {
			if (resolved !== "\0" + id) {
				return undefined;
			}

			const require = createRequire(import.meta.url);
			const version = (name: string): string => (JSON.parse(fs.readFileSync(require.resolve(name + "/package.json"))) as { "version": string }).version;

			if (version("dockview") !== version("dockview-core")) {
				throw new Error(`dockview-css: dockview ${version("dockview")} and dockview-core ${version("dockview-core")} must be one version — the stylesheet comes from the first, the code it styles from the second`);
			}

			return "export default " + JSON.stringify(fs.readFileSync(require.resolve("dockview/dist/styles/dockview.css"))) + ";";
		}
	};
}

/**
 * The passes that emit into dist/ (+ docs/coi-serviceworker.js) — everything the host build/dev server then
 * SERVES. Run before hostBuild() (full build) or before starting the dev server (dev.ts). Order matters: the
 * workbench entry empties dist/ first; the rest set emptyOutDir:false.
 */
export async function preBuild(): Promise<void> {
	// 1. Workbench iframe entry (workbench-entry.tsx → dist/workbench.js). monaco kept external → ./main.js.
	await buildPackage(root, {
		// Relative, like every other build here: the workbench is served under /__vscode__/, and with the default "/"
		// Vite's dynamic-import preload helper asked for a lazy chunk's dependencies at the SITE root (the terminal's
		// just-bash chunk as /browser.js → index.html, "Failed to load module script") — the import itself, relative,
		// still worked.
		"base": "./",
		"plugins": [bundledExtension("bridge"), bundledExtension("tsval"), bundledExtension("eslint"), bundledExtension("capabilities"), bundledExtension("history"), bundledExtension("insights"), bundledExtension("running"), bundledExtension("type-queries"), bundledExtension("notes"), bundledExtension("event-sheet"), bundledExtension("cspell"), bundledModule("extensions/event-sheet", "view.ts", "view", "iife", [], true), editorSettingsDefaultsPlugin(), polyfillNode(["path", "url"])],
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		// One @brianjenkins94/hub / observability instance — CI's pnpm workspace double-instances `file:../hub`.
		// `buffer` → the node-stdlib-browser polyfill: isomorphic-git (the git SCM engine) uses the `Buffer` global,
		// which the browser lacks and this bundle otherwise doesn't polyfill; the alias makes the import resolve to
		// the real polyfill (git-engine.ts then assigns it to globalThis) instead of vite's empty browser stub.
		// `@automerge/automerge` → its base64-INLINED-WASM entry (fullfat_base64): the default browser condition wants a
		// bundler to serve a separate `automerge.wasm`, which our static Pages deploy can't; the base64 build carries the
		// wasm inline, so the lazily-imported edit-history chunk is self-contained. Resolve via package.json → sibling.
		// The terminal's commands run on juvy, which parses with node:util's parseArgs: @pkgjs/parseargs (Node's own, as a
		// package). polyfillNode(["path", "url"]) is for util/env, which juvy imports (it reads node:path/url at load), and
		// gives the bundle `global`/`process` where they're read.
		"resolve": { "dedupe": ["@brianjenkins94/hub", "@brianjenkins94/observability"], "alias": { "buffer": stdlib["buffer"], "node:util": "@pkgjs/parseargs", "@automerge/automerge": resolvePath("./node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js") } },
		"build": {
			"outDir": "dist",
			"minify": isCI,
			// Locally, every bundle of ours carries a source map — so a debugger, and V8 coverage from a session, map back to
			// the repo's files; never in CI.
			"sourcemap": !isCI,
			"rollupOptions": {
				"input": { "workbench": "workbench/workbench-entry.tsx" },
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
		// `@brianjenkins94/bablr` → its BUILT, browser-safe dist (the BABLR worker's CST engine): the alias uses
		// the fresh dist directly, sidestepping the pnpm file:-dep store staleness that bites workspace packages.
		// (and hub/observability to the editor's own: a debugger's worker connects through run-contract's runtime helper,
		// whose own copies are only its dev dependencies — one hub, one set of log sinks)
		"resolve": { "alias": { "@brianjenkins94/bablr": resolvePath("../bablr/dist/index.js") }, "dedupe": ["typescript", "@brianjenkins94/hub", "@brianjenkins94/observability"] },
		// The preview taps, as script text the node worker's dev server puts into the app's pages and workers.
		"plugins": [bundledNodeServer("cspell"), bundledModule("previews", "page-tap.ts", "page-tap", "iife", []), bundledModule("previews", "worker-tap.ts", "worker-tap", "iife", []), cspellDict()],
		"worker": { "rollupOptions": { "output": { "sourcemap": !isCI } } },
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			// These run as Web Workers (no DOM). Vite's default dynamic-import preload helper injects a
			// <link rel=modulepreload> via `document`, which throws in a worker — so the node worker's lazy
			// `import()` of the ViteDevServer (ts) chunk crashes. Disable the polyfill; workers just fetch chunks.
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": {
					"lsp/server-host": resolvePath("./extensions/cspell/server-host.ts"),
					"lsp/debug-worker": resolvePath("./extensions/tsval/debug-worker.ts"),
					"lsp/node-worker": resolvePath("./workers/node-worker.ts"),
					// provoke child worker (debug affordance): node-worker spawns it per hardReset round to get a cold
					// almostnode + ts realm. Served at lsp/provoke-worker.js so node-worker's `new URL` resolves it.
					"lsp/provoke-worker": resolvePath("./workers/provoke-worker.ts"),
					// The editor's BABLR worker (core's, not the bridge's), served from lsp/ like the other worker chunks.
					// Started and queued by bablr.ts.
					"lsp/bablr-worker": resolvePath("./workers/bablr-worker.ts"),
					// The event sheet's recognizer worker — built HERE so its `typescript` shares the deduped ts chunk above
					// (no second copy); the event-sheet extension starts it (extensions/event-sheet/extension.ts).
					"lsp/recognizer-worker": resolvePath("./extensions/event-sheet/recognizer-worker.ts")
				},
				"output": {
					"chunkFileNames": "lsp/[name]-[hash].js",
					"assetFileNames": "lsp/[name]-[hash][extname]",
					// The debug worker bundles util (silo's policy, and util's env with it), which reads `process` as it
					// loads; it's a realm of its own, with none. Not the almostnode workers: they emulate Node's own.
					"banner": (chunk) => (chunk.name === "lsp/debug-worker" ? PROCESS_SHIM : ""),
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
		// The user's preset (@brianjenkins94/util/eslint) as data + one chunk per plugin, loaded independently (see
		// extensions/eslint/preset-build.ts). Plugins written for Node degrade PER PLUGIN rather than breaking the build or
		// the engine: builtin subpaths map onto the parent polyfill (polyfillNode), `node:module` gets Node's "nothing installed" semantics,
		// missing named exports shim to undefined — a plugin that really needs something absent fails at load and is skipped.
		"plugins": [polyfillNode(), eslintNodeModule(), valueRequireToRegistry(), eslintTsPlugin(), eslintPresetPlugin()],
		// CJS plugin builds compute `import.meta.url` from `__filename` when there's no `document` (a worker), and some
		// call `require.resolve` at load (only ever to name files) — give both inert values rather than a ReferenceError.
		// And vite's dynamic-import error handler announces a failed import with `window.dispatchEvent(...)` before
		// rethrowing — in a worker that throws "window is not defined" and MASKS the plugin's real load error.
		"define": { "__filename": JSON.stringify("/lsp/eslint-engine.js"), "__dirname": JSON.stringify("/lsp"), "require.resolve": "((id) => id)", "window.dispatchEvent": "(() => true)" },
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			// Sourcemap locally only (the ~7MB .map is debug-only, never fetched at runtime) — never in CI.
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			// The plugin chunks are dynamic imports; vite's preload helper injects <link rel=modulepreload> via `document`,
			// which the tsserver worker doesn't have ("document is not defined").
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"shimMissingExports": true,
				"input": { "lsp/eslint-engine": resolvePath("./extensions/eslint/engine.ts") },
				"output": { "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});

	// 2b. The capabilities extension's package worker (dist/lsp/packages-worker.js): what each dependency's tarball says it
	// can do, and the joins (rolldown's browser build, loaded on the first slice), for the baseline — read off the extension
	// host; the extension starts it for a sync and ends it after (baseline.ts). A build of its own: it reads util (and
	// util's env, which reads `process` as it loads), so every chunk carries the shim — shared with the debug worker, a
	// chunk of util would load before the shim on either's entry.
	await buildPackage(root, {
		"base": "./",
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			// (a worker: no `document` for the preload helper)
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "lsp/packages-worker": resolvePath("./extensions/capabilities/packages-worker.ts") },
				"output": { "banner": PROCESS_SHIM, "chunkFileNames": "lsp/packages-worker-[name]-[hash].js", "assetFileNames": "lsp/packages-worker-[name]-[hash][extname]" }
			}
		}
	});

	// 3b. capabilities engine (dist/lsp/capabilities-engine.js) — the STATIC capability analysis (util/silo's reach +
	// policy), run INSIDE the capabilities tsserver plugin, which hands it tsserver's own `ts` and SourceFile: it reads
	// TypeScript's tree and parses nothing itself, so no parser is bundled (no typescript, no oxc).
	await buildPackage(root, {
		"base": "./",
		"resolve": { "conditions": ["browser", "import", "default"] },
		"plugins": [polyfillNode(), capabilitiesTsPlugin()],
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
	// the ~7MB bundled copy (16.7MB → a few hundred KB). The canary classifies by injected-stand-in identity: it sees
	// calls as they're made, aliases included, not by their shape in the tree.
	await buildPackage(root, {
		"base": "./",
		"resolve": {
			"alias": [
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
				"input": { "lsp/capabilities-canary": resolvePath("./shared/capabilities/canary.ts") },
				"output": { "banner": PROCESS_SHIM, "chunkFileNames": "lsp/[name]-[hash].js", "assetFileNames": "lsp/[name]-[hash][extname]" }
			}
		}
	});

	// 3d. history engine (dist/lsp/history-engine.js) — util/silo's reading over TypeScript's tree (ts-analysis), run
	// INSIDE the history tsserver plugin with tsserver's own `ts`: `typescript` is EXTERNALIZED to the ts-external shim
	// (the plugin sets globalThis.__historyTs first), and no oxc — ts-analysis loads only silo's pure model and graph.
	await buildPackage(root, {
		"base": "./",
		"resolve": {
			"alias": [{ "find": /^typescript(\/.*)?$/u, "replacement": resolvePath("./extensions/history/ts-external.js") }],
			"conditions": ["browser", "import", "default"]
		},
		"plugins": [polyfillNode(), historyTsPlugin()],
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"minify": false,
			"sourcemap": !isCI,
			"assetsInlineLimit": 0,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": { "lsp/history-engine": resolvePath("./extensions/history/engine.ts") },
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

/** Preload the shell's chunk (and its imports + CSS) from index.html. main.tsx imports it dynamically (so its
 *  WebAwesome chrome stays out of the app iframe), which otherwise starts the fetch only once index.js has run —
 *  and the app iframe, and so the workbench iframe, waits on the shell rendering. Fetch only (`preload`, not
 *  `modulepreload`): the app iframe loads this same index.html and never runs the shell. */
function shellPreloadPlugin(): Plugin {
	return {
		"name": "shell-preload",
		"apply": "build",
		"transformIndexHtml": {
			"order": "post",
			"handler": (_html, context) => {
				const shell = Object.values(context.bundle ?? {}).find((chunk) => chunk.type === "chunk" && chunk.facadeModuleId?.endsWith("/shell.tsx") === true);

				if (shell?.type !== "chunk") {
					return [];
				}

				const css = [...shell.viteMetadata?.importedCss ?? []];

				return [
					...[shell.fileName, ...shell.imports].map((file) => ({ "tag": "link", "attrs": { "rel": "preload", "as": "script", "crossorigin": "", "href": file }, "injectTo": "head" as const })),
					...css.map((file) => ({ "tag": "link", "attrs": { "rel": "preload", "as": "style", "href": file }, "injectTo": "head" as const }))
				];
			}
		}
	};
}

/** The host site (→ repo docs/), serving the pre-built dist/ + component under /__vscode__/. emptyOutDir FALSE
 *  so it lays down alongside the published package tarballs (docs/*.tgz). */
async function hostBuild(): Promise<void> {
	await buildPackage(root, {
		"base": "./",
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@brianjenkins94/hub", "@brianjenkins94/observability"] },
		"build": { "outDir": "../../docs", "emptyOutDir": false },
		"plugins": [...hostPlugins(), shellPreloadPlugin()]
	});
}

// `tsx build.ts` → the full build. Imported by dev.ts (for preBuild/hostPlugins), where this guard stays false.
if (isEntry(import.meta)) {
	await preBuild();
	await hostBuild();
}
