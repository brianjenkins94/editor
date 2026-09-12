import * as url from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the cross-origin-isolation service worker (coi-serviceworker.js) as a SINGLE-FILE ES MODULE bundle to
 * docs/coi-serviceworker.js. It used to be a plain classic script served verbatim from public/, but it now
 * `import`s @brianjenkins94/hub so the SW is a first-class hub node (it publishes `$sys.sw.*` telemetry and can
 * federate to the page's root hub) — which requires bundling and a `{ type: "module" }` registration
 * (coi.ts / server-bridge.ts). inlineDynamicImports keeps it one file so a SW (which can't rely on sibling
 * chunks resolving under every deploy base) stays self-contained. Runs after the default vite build; docs is
 * not emptied (emptyOutDir false), so it just adds/overwrites coi-serviceworker.js.
 */
const resolvePath = (relative: string): string => url.fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
	"base": "./",
	"build": {
		"target": "esnext",
		"outDir": "../../docs",
		"emptyOutDir": false,
		"minify": false,
		"rollupOptions": {
			// Side-effect entry (registers install/activate/fetch/message handlers on load) — keep it intact.
			"preserveEntrySignatures": "strict",
			"input": { "coi-serviceworker": resolvePath("./coi-serviceworker.js") },
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"inlineDynamicImports": true
			}
		}
	}
});
