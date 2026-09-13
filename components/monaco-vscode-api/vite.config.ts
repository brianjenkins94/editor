import { defaults } from "@brianjenkins94/util/vite/defaults";
import { isCI } from "@brianjenkins94/util/env";
// eslint-disable-next-line ts/no-restricted-imports -- build-time plugin; needs sync fs to read the referenced asset
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { mergeConfig } from "vite";

// Inherits the repo's shared build defaults (esnext, [name].js, cleaned outDir) and bundles
// main.ts (the customized workbench) + all of its monaco-vscode-api dependencies into a
// self-contained, minified ES build under dist/, so consumers import the finished artifact
// rather than raw source.
export default mergeConfig(defaults, {
	// Relative base so emitted asset URLs (e.g. the codicon font, `url(./codicon.ttf)`) resolve
	// relative to wherever the bundle is served rather than the origin root. Consumers mount this
	// under a sub-path (the workbench iframe serves it at `/__vscode__/`); with the default base `/`,
	// `url(/codicon.ttf)` would escape that prefix and 404.
	"base": "./",
	"build": {
		// Minify with vite's own (oxc) minifier — fast and within the default node heap.
		"minify": true,
		// Sourcemaps for local debugging only — NEVER in CI (they're ~62MB of @codingame maps + our chunk maps,
		// debug-only and never fetched at runtime; drop-sourcemaps below strips the copied ones in CI too).
		"sourcemap": !isCI,
		"rollupOptions": {
			"input": { "main": "main.ts" },
			// Bundle everything; nothing is externalized. Output naming (deterministic content-hashed chunks +
			// assets, readable `main` entry) comes from the shared @brianjenkins94/util/vite/defaults.
			"preserveEntrySignatures": "strict"
		}
	},
	"plugins": [
		{
			// monaco-vscode-api ships CSS that must be loaded as inline strings, not injected stylesheets.
			"name": "load-vscode-css-as-string",
			"enforce": "pre",
			"resolveId": async function(source, importer, options) {
				const resolved = await this.resolve(source, importer, options);

				if (resolved !== null && resolved.id.match(/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/u) !== null) {
					return { ...resolved, "id": resolved.id + "?inline" };
				}

				return undefined;
			}
		},
		{
			// Stub VS Code's cosmetic default-extension assets — none of which the editor uses:
			//   • ~1.5MB of accessibility audio cues (.mp3) → silent `data:audio/mpeg`
			//   • ~2.3MB of Getting Started / walkthrough splash graphics + theme-preview / extension-icon
			//     images (.svg/.png) → a 1×1 transparent GIF (graceful, not a broken image)
			// Each is referenced as `new URL("./asset.<ext>", import.meta.url)`, which vite would otherwise emit
			// + ship. Rewrite them BEFORE vite's asset-import-meta-url transform (enforce: pre) so nothing is
			// emitted. Core UI is unaffected — codicons and the seti file-icons are FONTS, not these. (Same trick
			// as the retired esbuild build's importMetaUrlPlugin.)
			"name": "stub-cosmetic-assets",
			"enforce": "pre",
			"transform": function(code) {
				if (!(/\.(mp3|svg|png)\b/u).test(code)) {
					return null;
				}

				const stubbed = code
					.replace(
						/new URL\(\s*(['"])[^'"]+\.mp3\1\s*,\s*import\.meta\.url\s*\)/gu,
						"new URL(\"data:audio/mpeg;base64,\")"
					)
					.replace(
						/new URL\(\s*(['"])[^'"]+\.(?:svg|png)\1\s*,\s*import\.meta\.url\s*\)/gu,
						"new URL(\"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==\")"
					);

				return stubbed === code ? null : { "code": stubbed, "map": null };
			}
		},
		{
			// Inline the default extensions' .json / .code-snippets resources (language-configuration, package.nls,
			// grammars, snippets, …) INTO the bundle instead of emitting ~86 separate files each fetched at
			// runtime. @codingame registers them as `registerFileUrl(name, new URL("./x.json", import.meta.url)
			// .toString(), …)`; rewrite that `new URL(...)` to a `data:application/json,<url-encoded content>` URL
			// (read at build time), so registerFileUrl's RegisteredUriFile "fetches" it in-memory — no file, no
			// network. URL-encoded (not base64) per the data-URI form. Runs before vite's asset-import-meta-url
			// transform (enforce: pre) so nothing is emitted.
			"name": "inline-json",
			"enforce": "pre",
			"transform": function(code, id) {
				if (!(/\.(?:json|code-snippets)\b/u).test(code) || !code.includes("import.meta.url")) {
					return null;
				}

				const dir = path.dirname(id.split("?")[0]);
				let changed = false;

				const out = code.replace(
					/new URL\(\s*(['"])([^'"]+\.(?:json|code-snippets))\1\s*,\s*import\.meta\.url\s*\)/gu,
					function(match, _quote, relative) {
						try {
							const content = nodeFs.readFileSync(path.resolve(dir, relative), "utf8");

							changed = true;

							return "new URL(" + JSON.stringify("data:application/json," + encodeURIComponent(content)) + ")";
						} catch (error) {
							return match;
						}
					}
				);

				return changed ? { "code": out, "map": null } : null;
			}
		},
		{
			// Drop the ~62MB of sourcemaps @codingame ships alongside its prebuilt worker/server resources
			// (htmlServerMain.js.map 23MB, tsserver.web.js.map 15MB, extension/css server maps, …), which vite
			// emits as assets next to the .js. They're debug-only, never loaded at runtime — strip every emitted
			// .map from the bundle so they don't bloat dist/ (and, downstream, docs/). CI ONLY: kept locally for
			// debugging (a local build has sourcemap:true and keeps the copied maps).
			"name": "drop-sourcemaps",
			"generateBundle": function(_options, bundle) {
				if (!isCI) {
					return;
				}

				for (const fileName of Object.keys(bundle)) {
					if (fileName.endsWith(".map")) {
						delete bundle[fileName];
					}
				}
			}
		}
	],
	"resolve": {
		"dedupe": ["vscode", "monaco-editor", "@codingame/monaco-vscode-api"]
	}
});
