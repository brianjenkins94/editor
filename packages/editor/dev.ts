import { polyfillNodeRolldown } from "@brianjenkins94/util/vite/plugins/polyfillNode";
import { createServer } from "vite";
import { hostPlugins, logger, preBuild, root } from "./build";

await preBuild();

const brotliStub = {
	"name": "brotli-wasm-stub",
	"resolveId": (id: string) => (id === "brotli-wasm" ? "\0brotli-wasm-stub" : undefined),
	"load": (id: string) => (id === "\0brotli-wasm-stub" ? "export default undefined;" : undefined)
};

const server = await createServer({
	"customLogger": logger,
	"root": root,
	"base": "./",
	"configFile": false,
	"esbuild": { "jsx": "automatic", "jsxImportSource": "preact" },
	"resolve": { "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "@brianjenkins94/hub", "@brianjenkins94/observability", "@awesome.me/webawesome"] },
	"optimizeDeps": { "include": ["@brianjenkins94/editor-api/recorded"], "rolldownOptions": { "plugins": [polyfillNodeRolldown(["fs", "path", "url", "util"])] } },
	"plugins": [brotliStub, ...hostPlugins()],
	"server": process.env["PORT"] === undefined ? {} : { "port": Number(process.env["PORT"]), "strictPort": true }
});

await server.listen();

server.printUrls();
