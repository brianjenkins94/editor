import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { deployment } from "./deployment";

// COVERAGE=1 (the reach record: packages/editor/build/coverage.ts, as the editor's own build counts its modules): the app's
// modules counted, and the account and theme packages it links, so test/workbench/admin.mjs's tests say what they ran. By
// URL, so the config's bundle leaves it for Node to load.
const { coverage } = ["1", "full"].includes(process.env["COVERAGE"] ?? "") ? await import(new URL("../editor/build/coverage.ts", import.meta.url).href) as { "coverage": () => Plugin[] } : { "coverage": (): Plugin[] => [] };

// The admin app (packages/api/README.md, "Admin app"): Preact through esbuild's JSX, as the editor's shell; its own origin, 5174 in dev (the
// `admin` client's redirect page in packages/api's wrangler.jsonc). The deployment, as its wrangler configs say, is
// `virtual:deployment` (deployment.ts), for the architecture page.
export default defineConfig({
	"plugins": [...coverage(), deployment()],
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	// packages/account and packages/theme are linked (file:), and import preact and Web Awesome from where they are: one
	// copy, the app's.
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@awesome.me/webawesome"] },
	"server": { "port": 5174, "strictPort": true },
	"build": { "target": "es2022" }
});
