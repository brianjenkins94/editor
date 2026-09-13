import { defaults } from "@brianjenkins94/util/vite/defaults";
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
			// Stub VS Code's accessibility audio cues (~1.5MB of .mp3 across ~30 default extensions). The
			// @codingame source references each as `new URL("./<cue>.mp3", import.meta.url)`, which vite would
			// emit + ship. Rewrite each to an empty `data:audio/mpeg` URL BEFORE vite's asset-import-meta-url
			// transform runs (enforce: pre), so no .mp3 is emitted; the cue player gets a silent source. (Same
			// trick as the retired esbuild build's importMetaUrlPlugin.)
			"name": "stub-audio-cues",
			"enforce": "pre",
			"transform": function(code) {
				if (!code.includes(".mp3")) {
					return null;
				}

				const stubbed = code.replace(
					/new URL\(\s*(['"])[^'"]+\.mp3\1\s*,\s*import\.meta\.url\s*\)/gu,
					"new URL(\"data:audio/mpeg;base64,\")"
				);

				return stubbed === code ? null : { "code": stubbed, "map": null };
			}
		}
	],
	"resolve": {
		"dedupe": ["vscode", "monaco-editor", "@codingame/monaco-vscode-api"]
	}
});
