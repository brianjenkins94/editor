import { defineConfig } from "vite";
import { deployment } from "./deployment";

// The admin app (README.md): Preact through esbuild's JSX, as the editor's shell; its own origin, 5174 in dev (the
// `admin` client's redirect page in packages/api's wrangler.jsonc). The deployment, as its wrangler configs say, is
// `virtual:deployment` (deployment.ts), for the architecture page.
export default defineConfig({
	"plugins": [deployment()],
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	// packages/account is linked (file:), and imports preact from where it is: one copy, the app's.
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime"] },
	"server": { "port": 5174, "strictPort": true },
	"build": { "target": "es2022" }
});
