import type { Plugin, RollupOutput } from "vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
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
import { DICTIONARIES, servedName } from "./extensions/cspell/dictionaries";
import { editorTypesPlugin, editorVersionsPlugin, nodeModulesCdnPlugin } from "./build/package-types";
import { editorSettingsDefaultsPlugin, editorWorkspacePlugin } from "./build/snapshot";
import { buildServiceWorker, staticHostPlugin } from "./build/static-host";
import { vscodePlugin, workbenchPreloadPlugin } from "./build/vite";

export const root = url.fileURLToPath(new URL(".", import.meta.url));
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

const sourcemap: boolean | "hidden" = !isCI || (process.env["SOURCE_MAPS"] === "hidden" ? "hidden" : false);

const coverage = (): Plugin[] => (process.env["COVERAGE"] === "1" ? [coveragePlugin()] : []);

const SHARED_PACKAGES = ["@brianjenkins94/util", "@brianjenkins94/hub", "@brianjenkins94/observability", "@brianjenkins94/almostnode", "@awesome.me/webawesome"];

const KNOWN_WARNINGS = [/has been externalized for browser compatibility, imported by "[^"]*[\\/]@brianjenkins94[\\/]util[\\/]/u, /\[EVAL\][\s\S]*[\\/](?:almostnode|vm-browserify)[\\/]/u];

export const logger = createLogger();

for (const level of ["warn", "warnOnce"] as const) {
	const say = logger[level].bind(logger);

	logger[level] = (message, options) => {
		if (!KNOWN_WARNINGS.some((known) => known.test(stripVTControlCharacters(message)))) {
			say(message, options);
		}
	};
}

const PROCESS_SHIM = "globalThis.process=globalThis.process||{\"env\":{},\"argv\":[],\"platform\":\"browser\",\"cwd\":function(){return \"/\";}};";

const MODULE_PROCESS_SHIM = "var process=globalThis.process||{\"env\":{},\"argv\":[],\"platform\":\"browser\",\"cwd\":function(){return \"/\";}};";

async function bundleCode(folder: string, file: string, id: string, format: "cjs" | "es" | "iife", externals: string[] | ((source: string, importer: string | undefined) => boolean), plugins: Plugin[] = [], banner?: string): Promise<string> {
	const dir = url.fileURLToPath(new URL(`./${folder}/`, import.meta.url));
	const output = await build({
		"configFile": false,
		"logLevel": "silent",
		"root": root,
		"resolve": { "dedupe": SHARED_PACKAGES },
		"plugins": [...coverage(), ...plugins],
		"build": {
			"write": false,
			"minify": isCI,
			"sourcemap": isCI ? false : "inline",
			"target": "esnext",
			"lib": { "entry": dir + file, "formats": [format], "fileName": id, ...format === "iife" ? { "name": id.replaceAll("-", "_") } : {} },
			"rollupOptions": { "external": externals, "output": { "codeSplitting": false, "keepNames": true, ...banner === undefined ? {} : { "banner": banner } } }
		}
	}) as RollupOutput[];

	return output[0].output.find((chunk) => chunk.type === "chunk")?.code ?? "";
}

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

function bundledNodeServer(name: string, file = "server-node.ts", id = "server-node"): Plugin {
	return bundledModule("extensions/" + name, file, id, "es", nodeBuiltins);
}

function cspellDict(): Plugin {
	return {
		"name": "cspell-dict",
		"generateBundle": function() {
			for (const dictionary of DICTIONARIES) {
				const packageDir = path.dirname(createRequire(import.meta.url).resolve(dictionary.package + "/cspell-ext.json"));

				this.emitFile({ "type": "asset", "fileName": "lsp/dicts/" + servedName(dictionary), "source": fs.readFileSync(path.join(packageDir, dictionary.file), { "encoding": null }) });
			}
		}
	};
}

function bundledModule(folder: string, file: string, id: string, format: "cjs" | "es" | "iife", externals: string[] | ((source: string, importer: string | undefined) => boolean), plugins: Plugin[] = [], banner?: string): Plugin {
	const virtual = `${folder.split("/").at(-1)}:${id}`;
	const resolved = "\0" + virtual;

	return {
		"name": virtual.replace(":", "-"),
		"resolveId": (source) => (source === virtual ? resolved : undefined),
		"load": async (moduleId) => (moduleId === resolved ? `export default ${JSON.stringify(await bundleCode(folder, file, id, format, externals, plugins, banner))};` : undefined)
	};
}

type ExtensionFile = { "worker": string; "hold"?: boolean } | { "script": string; "format": "es" | "iife" } | { "json": unknown };

function workerBootstrapSource(file: string, depth: number, hold: boolean): string {
	const target = JSON.stringify("../".repeat(depth) + "lsp/" + file);
	const failed = "(error) => { postMessage({ \"failed\": String(error && error.stack || error) }); }";

	return hold
		? `const held = []; const hold = (event) => { held.push(event.data); }; addEventListener("message", hold); import(${target}).then(() => { removeEventListener("message", hold); for (const data of held) { dispatchEvent(new MessageEvent("message", { "data": data })); } }, ${failed});\n`
		: `import(${target}).catch(${failed});\n`;
}

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

			const code = await bundleCode(folder, "extension.ts", "extension", "cjs", (source, importer) => source === "vscode" && importer === TAPPED_VSCODE, [commandTap(name)], MODULE_PROCESS_SHIM);
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

function releasePlugin(): Plugin {
	const id = "editor:release";
	let release = "dev";

	try {
		release = execFileSync("git", ["rev-parse", "--short", "HEAD"], { "encoding": "utf8" }).trim();
	} catch {
	}

	return {
		"name": "editor-release",
		"resolveId": (source) => (source === id ? `\0${id}` : undefined),
		"load": (moduleId) => (moduleId === `\0${id}` ? `export default ${JSON.stringify(release)};` : undefined)
	};
}

export function hostPlugins(): Plugin[] {
	return [
		releasePlugin(),
		...coverage(),
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

export async function preBuild(): Promise<void> {
	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"plugins": [
			...coverage(),
			bundledExtension("bridge"),
			bundledExtension("tsval"),
			bundledExtension("eslint", { "worker.js": { "worker": "eslint-worker.js" } }),
			bundledExtension("change-problems", { "node_modules/change-problems-ts-plugin/package.json": { "json": { "name": "change-problems-ts-plugin", "version": "0.0.1", "browser": "index.js" } }, "node_modules/change-problems-ts-plugin/index.js": { "script": "ts-plugin.js", "format": "es" } }),
			bundledExtension("history", HISTORY_FILES),
			bundledExtension("capabilities", CAPABILITIES_FILES),
			bundledExtension("source-control"),
			bundledExtension("margin"),
			bundledExtension("notes"),
			bundledExtension("insights"),
			bundledExtension("type-queries"),
			bundledExtension("cosmetic"),
			bundledExtension("cspell", { "server.js": { "worker": "server-host.js", "hold": true } }),
			editorSettingsDefaultsPlugin(),
			polyfillNode(["path", "url", "buffer"])
		],
		"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
		"resolve": { "dedupe": SHARED_PACKAGES, "alias": { "node:util": "@pkgjs/parseargs", "@automerge/automerge": resolvePath("./node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js") } },
		"build": {
			"outDir": "dist",
			"minify": isCI,
			"sourcemap": sourcemap,
			"rollupOptions": {
				"input": { "workbench": "workbench/workbench-entry.tsx" },
				"external": ["@brianjenkins94/monaco-vscode-api/main"],
				"output": { "chunkFileNames": "[name].js", "keepNames": true, "paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" } }
			}
		}
	});

	await buildPackage(root, {
		"customLogger": logger,
		"base": "./",
		"resolve": { "alias": { "@brianjenkins94/bablr": resolvePath("../bablr/dist/index.js") }, "dedupe": ["typescript", ...SHARED_PACKAGES] },
		"plugins": [...coverage(), unenvResolve(), bundledModule("previews", "page-script.ts", "page-evidence", "iife", []), bundledNodeServer("cspell"), cspellDict()],
		"worker": { "plugins": coverage, "rollupOptions": { "output": { "sourcemap": sourcemap } } },
		"build": {
			"outDir": "dist",
			"emptyOutDir": false,
			"sourcemap": sourcemap,
			"assetsInlineLimit": 0,
			"modulePreload": false,
			"rollupOptions": {
				"preserveEntrySignatures": "strict",
				"input": {
					"lsp/debug-worker": resolvePath("./extensions/tsval/debug-worker.ts"),
					"lsp/server-host": resolvePath("./extensions/cspell/server-host.ts"),
					"lsp/eslint-worker": resolvePath("./extensions/eslint/worker.ts"),
					"lsp/bablr-worker": resolvePath("./workers/bablr-worker.ts"),
					"lsp/node-worker": resolvePath("./workers/node-worker.ts")
				},
				"output": {
					"chunkFileNames": "lsp/[name]-[hash].js",
					"assetFileNames": "lsp/[name]-[hash][extname]",
					"banner": (chunk) => (chunk.name === "lsp/debug-worker" ? PROCESS_SHIM : ""),
					"manualChunks": (id) => (/[\\/]node_modules[\\/]typescript[\\/]/u.test(id) ? "typescript" : undefined)
				}
			}
		}
	});

	const toolchain = await eslintToolchain(path.join(root, "dist/lsp/eslint-toolchain.tgz"));

	logger.info(`eslint toolchain: ${toolchain.packages} packages, ${toolchain.files} files, ${(toolchain.bytes / 1048576).toFixed(1)} MB`);

	await buildHistory(root, { "logger": logger, "sourcemap": sourcemap, "banner": PROCESS_SHIM });

	await buildCapabilities(root, { "logger": logger, "sourcemap": sourcemap, "banner": PROCESS_SHIM });

	await buildServiceWorker(root, logger);

	checkExtensionFolders(path.join(root, "dist"));
}

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

if (isEntry(import.meta)) {
	await preBuild();
	await hostBuild();
}
