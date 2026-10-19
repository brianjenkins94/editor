import { defineConfig } from "vite";
import { deployment } from "./deployment";

// The admin app (README.md): Preact through esbuild's JSX, as the editor's shell; its own origin, 5174 in dev (the
// `admin` client's redirect page in packages/api's wrangler.jsonc). The deployment, as its wrangler configs say, is
// `virtual:deployment` (deployment.ts), for the architecture page.
export default defineConfig({
	"plugins": [deployment()],
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	// packages/account and packages/theme are linked (file:), and import preact and Web Awesome from where they are: one
	// copy, the app's.
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@awesome.me/webawesome"] },
	"server": { "port": 5174, "strictPort": true },
	"build": { "target": "es2022" }
});
