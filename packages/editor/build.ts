import type { Plugin, RollupOutput } from "vite";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import { unenvResolve } from "@brianjenkins94/almostnode/unenv-resolve";
import { isCI, isEntry } from "@brianjenkins94/util/env";
import * as fs from "@brianjenkins94/util/fs";
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { polyfillNode } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { build, createLogger } from "vite";
import { commandTap, TAPPED_VSCODE } from "./build/command-tap";
import { coveragePlugin } from "./build/coverage";
import { eslintToolchain } from "./build/eslint-toolchain";
import { buildCapabilities, CAPABILITIES_FILES } from "./build/capabilities";
import { buildHistory, HISTORY_FILES } from "./build/history";
import { editorTypesPlugin, editorVersionsPlugin, nodeModulesCdnPlugin } from "./build/package-types";
import { editorSettingsDefaultsPlugin, editorWorkspacePlugin } from "./build/snapshot";
import { buildServiceWorker, staticHostPlugin } from "./build/static-host";
import { vscodePlugin, workbenchPreloadPlugin } from "./build/vite";

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

/** Source maps: locally, every bundle of ours carries one, so a debugger and V8 coverage map back to the repo's files.
 *  In CI none, but production's deploy asks for hidden ones (SOURCE_MAPS=hidden: written, not referenced from the code),
 *  which it keeps per release outside the site for the admin app's stacks (packages/api/scripts/keep-source-maps.ts). */
const sourcemap: boolean | "hidden" = !isCI || (process.env["SOURCE_MAPS"] === "hidden" ? "hidden" : false);

/** COVERAGE=1 (off by default): our modules instrumented in every pass, so each architecture test's reach can be read
 *  (build/coverage.ts). */
const coverage = (): Plugin[] => (process.env["COVERAGE"] === "1" ? [coveragePlugin()] : []);

/** Packages every bundle takes the editor's one copy of, whichever linked package imports them. */
const SHARED_PACKAGES = ["@brianjenkins94/util", "@brianjenkins94/hub", "@brianjenkins94/observability", "@brianjenkins94/almostnode", "@awesome.me/webawesome"];

/** Warnings that are known, and so by design, that a build says over and over: util's node builtins (its env and fs work
 *  in Node or a browser, and its self-tests' `node:assert` is imported in blocks a browser never runs), and the direct `eval`
 *  of almostnode and vm-browserify (each emulates Node's vm). */
const KNOWN_WARNINGS = [/has been externalized for browser compatibility, imported by "[^"]*[\\/]@brianjenkins94[\\/]util[\\/]/u, /\[EVAL\][\s\S]*[\\/](?:almostnode|vm-browserify)[\\/]/u];

/** Vite's logger, less the known warnings: what's left is worth reading — in CI, where it's the log a failure is read in. */
export const logger = createLogger();

for (const level of ["warn", "warnOnce"] as const) {
	const say = logger[level].bind(logger);

	logger[level] = (message, options) => {
		if (!KNOWN_WARNINGS.some((known) => known.test(stripVTControlCharacters(message)))) {
			say(message, options);
		}
	};
}

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

/** Bundle `<folder>/<file>` (a folder of this package, e.g. `extensions/bridge`; deps inlined) into one chunk's code.
 *  `externals` stay unbundled. `configFile:false` isolates the nested build. */
async function bundleCode(folder: string, file: string, id: string, format: "cjs" | "es" | "iife", externals: string[] | ((source: string, importer: string | undefined) => boolean), plugins: Plugin[] = [], banner?: string): Promise<string> {
	const dir = url.fileURLToPath(new URL(`./${folder}/`, import.meta.url));
	const output = await build({
		"configFile": false,
		"logLevel": "silent",
		"root": root,
		// One util, hub and observability — the editor's: editor-api's modules, linked from its own folder, would find
		// the copies its dev dependencies installed beside it (a stale util once cost a rule its package).
		"resolve": { "dedupe": SHARED_PACKAGES },
		"plugins": [...coverage(), ...plugins],
		"build": {
			"write": false,
			"minify": isCI,
			// Script text, not a file: its map rides inline (locally only, as every pass's).
			"sourcemap": isCI ? false : "inline",
			"target": "esnext",
			"lib": { "entry": dir + file, "formats": [format], "fileName": id, ...format === "iife" ? { "name": id.replaceAll("-", "_") } : {} },
			// One self-contained chunk: large servers have dynamic imports that would otherwise code-split
			// into siblings we don't capture (we grab only the entry chunk as a string).
			"rollupOptions": { "external": externals, "output": { "codeSplitting": false, ...banner === undefined ? {} : { "banner": banner } } }
		}
	}) as RollupOutput[];

	return output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";
}

/** `<folder>/<file>` bundled (bundleCode) as a virtual module `<name>:<id>`, named for the folder's last segment, whose
 *  default export is the code, a string. */
function bundledModule(folder: string, file: string, id: string, format: "cjs" | "es" | "iife", externals: string[] | ((source: string, importer: string | undefined) => boolean), plugins: Plugin[] = [], banner?: string): Plugin {
	const virtual = `${folder.split("/").at(-1)}:${id}`;
	const resolved = "\0" + virtual;

	return {
		"name": virtual.replace(":", "-"),
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async (moduleId) => (moduleId === resolved ? `export default ${JSON.stringify(await bundleCode(folder, file, id, format, externals, plugins, banner))};` : undefined)
	};
}

/** What goes in an extension's folder beside its entry, by the path its manifest's `files` lists it at: a classic
 *  bootstrap for one of its workers (a module worker built with the LSP workers, in lsp/, sharing their chunks — an
 *  extension's workers start classic; `hold` keeps the messages that come before the module has loaded), a script
 *  bundled from its folder, or JSON. A file the manifest lists that's none of these is another pass's (a tsserver
 *  plugin and its engine). */
type ExtensionFile = { "worker": string; "hold"?: boolean } | { "script": string; "format": "es" | "iife" } | { "json": unknown };

/** A classic worker script that imports module worker `file` (lsp/'s) from `depth` folders below the site, telling the
 *  worker's starter if it couldn't (watchWorker reads `failed`). */
function workerBootstrapSource(file: string, depth: number, hold: boolean): string {
	const target = JSON.stringify("../".repeat(depth) + "lsp/" + file);
	const failed = "(error) => { postMessage({ \"failed\": String(error && error.stack || error) }); }";

	return hold
		? `const held = []; const hold = (event) => { held.push(event.data); }; addEventListener("message", hold); import(${target}).then(() => { removeEventListener("message", hold); for (const data of held) { dispatchEvent(new MessageEvent("message", { "data": data })); } }, ${failed});\n`
		: `import(${target}).catch(${failed});\n`;
}

/**
 * An extension, as a folder the editor loads it from — the way an extension from outside the editor is loaded
 * (workbench/extensions.ts): `extensions/<name>/` holds its package.json (its manifest, `browser` its content-hashed
 * entry), the entry (`extension.ts`, browser CJS, `vscode` external, its `vscode` tapped — commandTap — so the
 * architecture view discovers its commands) and `files`' files. `<name>:extension` is `{ base, manifest }`. The
 * extension host fetches the entry on activation, so none of it is on the workbench's boot path.
 */
function bundledExtension(name: string, files: Record<string, ExtensionFile> = {}): Plugin {
	const virtual = `${name}:extension`;
	const resolved = "\0" + virtual;
	const folder = `extensions/${name}`;

	return {
		"name": `${name}-extension`,
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async function(moduleId) {
			if (moduleId !== resolved) {
				return undefined;
			}

			// `vscode` is external only from the tapped module: the extension's own imports of it go to that module first.
			// The extension host has no `process`; util reads it as it loads.
			const code = await bundleCode(folder, "extension.ts", "extension", "cjs", (source, importer) => source === "vscode" && importer === TAPPED_VSCODE, [commandTap(name)], MODULE_PROCESS_SHIM);
			// (content-hashed, so a deploy never pairs a new manifest with a stale entry)
			const entry = `extension-${createHash("sha256").update(code).digest("hex").slice(0, 8)}.js`;
			const manifest = { ...JSON.parse(fs.readFileSync(resolvePath(`./${folder}/package.json`), "utf8")) as Record<string, unknown>, "browser": entry };

			this.emitFile({ "type": "asset", "fileName": `${folder}/${entry}`, "source": code });
			this.emitFile({ "type": "asset", "fileName": `${folder}/package.json`, "source": JSON.stringify(manifest, null, "\t") + "\n" });

			for (const [path, made] of Object.entries(files)) {
				let source: string;

				if ("worker" in made) {
					source = workerBootstrapSource(made.worker, `${folder}/${path}`.split("/").length - 1, made.hold === true);
				} else if ("script" in made) {
					source = await bundleCode(folder, made.script, path.replace(/\.js$/u, ""), made.format, [], []);
				} else {
					source = JSON.stringify(made.json, null, "\t") + "\n";
				}

				this.emitFile({ "type": "asset", "fileName": `${folder}/${path}`, "source": source });
			}

			return `export default ${JSON.stringify({ "base": `./${folder}/`, "manifest": manifest })};`;
		}
	};
}

/** The host site's plugins — shared by the host BUILD (hostBuild) and the DEV server (dev.ts): cross-origin
 *  isolation headers, the baked workspace/types/versions snapshots, the CDN node_modules dev mirror, and
 *  vscodePlugin (serves the entry dist/ + component under /__vscode__/). */
export function hostPlugins(): Plugin[] {
	return [
		...coverage(),
		// The SHELL (main.tsx → shell.tsx) is built here, and it lazily imports the browser GitHub client
		// (github.ts → fido → util/env, util/store), which pulls in node builtins: `env.ts` reads `process`/`path`/`url`
		// at eval and `store.ts` (dynamic, browser-guarded) touches `fs`. `polyfillNode([...])` resolves these to unenv's
		// AND injects the `process`/`Buffer` globals env.ts needs; `buffer` too, for the repo load's clone (isomorphic-git, in
		// git-clone.ts, uses `Buffer`). Scoped to this list so it can't stub a builtin another chunk resolves itself.
		// github.ts is dynamically imported, so fido + these polyfills land in a lazy chunk (docs/github-*.js), off the
		// shell's cold-start path.
		polyfillNode(["fs", "path", "url", "util", "buffer"]),
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
		workbenchPreloadPlugin()
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
		"customLogger": logger,
		// Relative, like every other build here: the workbench is served under /__vscode__/, and with the default "/"
		// Vite's dynamic-import preload helper asked for a lazy chunk's dependencies at the SITE root (the terminal's
		// just-bash chunk as /browser.js → index.html, "Failed to load module script") — the import itself, relative,
		// still worked.
		"base": "./",
		"plugins": [
			...coverage(),
			bundledExtension("bridge"),
			bundledExtension("tsval"),
			// (its worker: ESLint and the preset under almostnode, from the toolchain built beside it — build/eslint-toolchain.ts)
			bundledExtension("eslint", { "worker.js": { "worker": "eslint-worker.js" } }),
			// (its tsserver plugin, as the package the TypeScript extension loads it from)
			bundledExtension("change-problems", { "node_modules/change-problems-ts-plugin/package.json": { "json": { "name": "change-problems-ts-plugin", "version": "0.0.1", "browser": "index.js" } }, "node_modules/change-problems-ts-plugin/index.js": { "script": "ts-plugin.js", "format": "es" } }),
			bundledExtension("history", HISTORY_FILES),
			bundledExtension("capabilities", CAPABILITIES_FILES),
			bundledExtension("source-control"),
			bundledExtension("margin"),
			bundledExtension("notes"),
			bundledExtension("insights"),
			bundledExtension("type-queries"),
			editorSettingsDefaultsPlugin(),
			polyfillNode(["path", "url", "buffer"])
		],
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		// One @brianjenkins94/hub / observability instance — CI's pnpm workspace double-instances `file:../hub`.
		// `@automerge/automerge` → its base64-INLINED-WASM entry (fullfat_base64): the default browser condition wants a
		// bundler to serve a separate `automerge.wasm`, which our static Pages deploy can't; the base64 build carries the
		// wasm inline, so the lazily-imported edit-history chunk is self-contained. Resolve via package.json → sibling.
		// The terminal's commands run on juvy, which parses with node:util's parseArgs: @pkgjs/parseargs (Node's own, as a
		// package). polyfillNode(["path", "url", "buffer"]) is for util/env, which juvy imports (it reads node:path/url at
		// load), and for isomorphic-git (the git SCM engine), which uses `Buffer` — unenv's, injected where it's read (and
		// git-engine.ts sets the global, for the dev optimizer's copy) — and gives the bundle `global`/`process` too.
		"resolve": { "dedupe": SHARED_PACKAGES, "alias": { "node:util": "@pkgjs/parseargs", "@automerge/automerge": resolvePath("./node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js") } },
		"build": {
			"outDir": "dist",
			"minify": isCI,
			"sourcemap": sourcemap,
			"rollupOptions": {
				"input": { "workbench": "workbench/workbench-entry.tsx" },
				"external": ["@brianjenkins94/monaco-vscode-api/main"],
				"output": { "chunkFileNames": "[name].js", "paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" } }
			}
		}
	});

	// 2. LSP host + tsval debug workers (dist/lsp/), almostnode-hosted — node builtins external.
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		// `dedupe` collapses the two physical typescript installs (almostnode's own dep + tsval's) to ONE, so the
		// manualChunks below emits a single ~7MB ts chunk both workers share, not two copies in one 14MB chunk.
		// (and hub/observability to the editor's own: a debugger's worker connects through editor-api's runtime helper,
		// whose own copies are only its dev dependencies — one hub, one set of log sinks)
		// (`@brianjenkins94/bablr`, the BABLR worker's: its built, browser-safe dist — the fresh one, not the store's copy)
		"resolve": { "alias": { "@brianjenkins94/bablr": resolvePath("../bablr/dist/index.js") }, "dedupe": ["typescript", ...SHARED_PACKAGES] },
		// (almostnode's built-ins are unenv's modules, which import each other by Node's names: unenvResolve makes those
		// unenv's own)
		// (and the page runtime a dev server puts in its pages, as a script: runtime evidence)
		"plugins": [...coverage(), unenvResolve(), bundledModule("previews", "page-script.ts", "page-evidence", "iife", [])],
		"worker": { "plugins": coverage, "rollupOptions": { "output": { "sourcemap": sourcemap } } },
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"sourcemap": sourcemap,
			"assetsInlineLimit": 0,
			// These run as Web Workers (no DOM). Vite's default dynamic-import preload helper injects a
			// <link rel=modulepreload> via `document`, which throws in a worker — so the node worker's lazy
			// `import()` of the ViteDevServer (ts) chunk crashes. Disable the polyfill; workers just fetch chunks.
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": {
					"lsp/debug-worker": resolvePath("./extensions/tsval/debug-worker.ts"),
					// ESLint's worker: real ESLint and the preset under almostnode (the eslint extension starts it), from the
					// toolchain beside it
					"lsp/eslint-worker": resolvePath("./extensions/eslint/worker.ts"),
					// BABLR's worker (workbench/bablr.ts starts it): which files its grammar takes
					"lsp/bablr-worker": resolvePath("./workers/bablr-worker.ts"),
					// (the dev servers' worker, started for the first one)
					"lsp/node-worker": resolvePath("./workers/node-worker.ts")
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

	// 2b. ESLint's toolchain (dist/lsp/eslint-toolchain.tgz): ESLint, the preset and what they load, traced from a real lint
	// and packed for the eslint worker to unpack (build/eslint-toolchain.ts).
	const toolchain = await eslintToolchain(path.join(root, "dist/lsp/eslint-toolchain.tgz"));

	logger.info(`eslint toolchain: ${toolchain.packages} packages, ${toolchain.files} files, ${(toolchain.bytes / 1048576).toFixed(1)} MB`);

	// 3. The history extension's tsserver plugin and its engine (build/history.ts).
	await buildHistory(root, { "logger": logger, "sourcemap": sourcemap, "banner": PROCESS_SHIM });

	// The capabilities extension's: its plugin, engine and canary (build/capabilities.ts).
	await buildCapabilities(root, { "logger": logger, "sourcemap": sourcemap, "banner": PROCESS_SHIM });

	// 4. The service worker a static host serves the editor with (build/static-host.ts).
	await buildServiceWorker(root, logger);

	checkExtensionFolders(path.join(root, "dist"));
}

/** Every extension's folder holds what its manifest says it does — its entry and each of `files` — and each worker
 *  bootstrap in it names a module that was built: a file missing fails the build, not a worker that never starts. */
function checkExtensionFolders(dist: string): void {
	const missing: string[] = [];

	for (const name of fs.readdirSync(path.join(dist, "extensions"))) {
		const folder = path.join(dist, "extensions", name);
		const manifest = path.join(folder, "package.json");

		if (fs.existsSync(manifest)) {
			const { browser, files = [] } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { "browser": string; "files"?: string[] };

			for (const file of [browser, ...files]) {
				const at = path.join(folder, file);

				if (fs.existsSync(at)) {
					const target = /^(?:const held[^\n]*)?import\("([^"]+)"\)/u.exec(fs.readFileSync(at, "utf8"))?.[1] ?? /import\("([^"]+)"\)\.(?:then|catch)/u.exec(fs.readFileSync(at, "utf8"))?.[1];

					if (target !== undefined && !fs.existsSync(path.resolve(path.dirname(at), target))) {
						missing.push(`${name}/${file} imports ${target}, which wasn't built`);
					}
				} else {
					missing.push(`${name}/${file}`);
				}
			}
		}
	}

	if (missing.length > 0) {
		throw new Error("the extensions' folders lack what their manifests list: " + missing.join("; "));
	}
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
		"customLogger": logger,
		"base": "./",
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", ...SHARED_PACKAGES] },
		"build": { "outDir": "../../docs", "emptyOutDir": false },
		"plugins": [...hostPlugins(), shellPreloadPlugin(), staticHostPlugin()]
	});
}

// `tsx build.ts` → the full build. Imported by dev.ts (for preBuild/hostPlugins), where this guard stays false.
if (isEntry(import.meta)) {
	await preBuild();
	await hostBuild();
}
