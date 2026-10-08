import { defaults } from "@brianjenkins94/util/vite/defaults";
import { mergeConfig } from "vite";

// The extension, as the editor loads it: one CommonJS file (its package.json's `browser` entry), `vscode` its host's.
export default mergeConfig(defaults, {
	"build": {
		"lib": {
			"entry": "src/extension.ts",
			"formats": ["cjs"],
			"fileName": () => "extension.js"
		},
		"outDir": "dist",
		"rollupOptions": {
			"external": ["vscode"]
		}
	}
});
