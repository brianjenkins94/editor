import { createServer } from "vite";
import { hostPlugins, preBuild, root } from "./build";

/**
 * Dev server for packages/vscode. Mirrors what `vite` (CLI, with the old vite.config.ts) did: the workbench
 * entry, LSP workers, eslint engine and SW are pre-built into dist/ + docs/ (preBuild), then the HOST page
 * (main.tsx → index.html) is served live with HMR while vscodePlugin serves the pre-built dist/ + component
 * under /__vscode__/. Same preact JSX + hub dedupe as the host build (build.ts hostBuild).
 *
 * `configFile: false` — there is no vite.config.ts; the config is inline here. Run via `tsx dev.ts`.
 */
await preBuild();

const server = await createServer({
	"root": root,
	"base": "./",
	"configFile": false,
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@brianjenkins94/hub", "@brianjenkins94/observability"] },
	"plugins": hostPlugins()
});

await server.listen();

server.printUrls();
