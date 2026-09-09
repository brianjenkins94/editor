import { defineConfig } from "vite";
import { editorTypesPlugin, editorVersionsPlugin, editorWorkspacePlugin } from "./snapshot";
import { vscodePlugin } from "./vite";

/**
 * Host app for the editor workbench — index.html + main.tsx mount the monaco workbench
 * (createVscodeWindow from ./vscode.tsx). `vite build` → the repo `docs/` (relative base, so it works at
 * any Pages subpath), which cd.yml deploys to Pages; `vite` serves it in dev. The workbench iframe entry
 * is a SEPARATE build (entry.config.ts → dist/), which vscodePlugin serves at /__vscode__/ alongside the
 * monaco component's own dist. No almostnode, no harness, no external-assets: editor is a
 * type-resolver/viewer.
 *
 * `docs/` is shared: cd's util-publish also writes the package tarballs (docs/*.tgz) there, so
 * emptyOutDir is FALSE — the host build lays its site down alongside them rather than wiping them.
 */
export default defineConfig({
	"base": "./",
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	// One Preact instance across chunks (the lazily-imported workbench chunk shares hooks state).
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime"] },
	"build": { "outDir": "../../docs", "emptyOutDir": false },
	"plugins": [
		// Cross-origin-isolate the host page so the workbench iframe can use SharedArrayBuffer (confirmed
		// required). The iframe inherits isolation from the (isolated) host only if its own responses carry
		// COEP — vscodePlugin sets that on /__vscode__/ responses. `credentialless` keeps cross-origin
		// subresources (CDN/fonts) working without requiring CORP on them.
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
		// Bakes the bundled demo/ in as `editor:workspace`, its dependency type surface as `editor:types`,
		// and the CDN version map as `editor:versions` (see main.tsx) — so the hosted page opens on a real
		// sample project with working type resolution.
		editorWorkspacePlugin(),
		editorTypesPlugin(),
		editorVersionsPlugin(),
		// MUST be last: its generateBundle emits the component dist's wasm/font assets, and this reads the
		// entry build's dist/ — neither should be disturbed by earlier plugins.
		vscodePlugin()
	]
});
