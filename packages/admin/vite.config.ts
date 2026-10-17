import { defineConfig } from "vite";

// The admin app (README.md): Preact through esbuild's JSX, as the editor's shell; its own origin, 5174 in dev (the
// `admin` client's redirect page in packages/api's wrangler.jsonc).
export default defineConfig({
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	"server": { "port": 5174, "strictPort": true },
	"build": { "target": "es2022" }
});
