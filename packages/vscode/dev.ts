import { polyfillNodeRolldown } from "@brianjenkins94/util/vite/plugins/polyfillNode";
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

// almostnode's zlib shim dynamically imports the optional `brotli-wasm` (with a @vite-ignore, since it's never
// reached — only pako gzip/deflate is used). The BUILD honors that @vite-ignore (rollup leaves it external), but
// vite's DEV pipeline transpiles the .ts with esbuild FIRST, which strips the comment, so vite:import-analysis
// then tries to resolve brotli-wasm, fails, and throws a page-blocking error overlay. Stub it to an empty module
// so the import resolves and degrades to a runtime no-op (brotliModule stays undefined, unused).
const brotliStub = {
	"name": "brotli-wasm-stub",
	"resolveId": (id: string) => (id === "brotli-wasm" ? "\0brotli-wasm-stub" : undefined),
	"load": (id: string) => (id === "\0brotli-wasm-stub" ? "export default undefined;" : undefined)
};

const server = await createServer({
	"root": root,
	"base": "./",
	"configFile": false,
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@brianjenkins94/hub", "@brianjenkins94/observability"] },
	// The dev dep-optimizer pre-bundles the browser GitHub client's deps (github.ts → fido → util/env, which calls
	// `path.dirname` at eval and reads `process`) and BYPASSES hostPlugins' `polyfillNode`. Vite 8 optimizes with
	// ROLLDOWN, not esbuild, so the fix is `rolldownOptions` + polyfillNodeRolldown (the esbuild variant throws
	// "Not implemented" and kills the optimizer): it resolves the four builtins and inlines a `process` shim.
	"optimizeDeps": { "rolldownOptions": { "plugins": [polyfillNodeRolldown(["fs", "path", "url", "util"])] } },
	"plugins": [brotliStub, ...hostPlugins()],
	// PORT lets a second checkout (a git worktree) run beside the main one; strict so a taken port fails loudly
	// instead of sliding to the next one, where a launch config pinned to the port would find the other server.
	"server": process.env["PORT"] === undefined ? {} : { "port": Number(process.env["PORT"]), "strictPort": true }
});

await server.listen();

server.printUrls();
