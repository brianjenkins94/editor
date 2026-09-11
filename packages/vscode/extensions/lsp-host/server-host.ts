/**
 * Spine B worker host — runs almostnode's main-thread Runtime INSIDE this plain worker (no WorkerRuntime,
 * so no nested worker, no Comlink on the channel, no /assets worker asset), then runs the node language
 * server (server-node) through it. almostnode gives the server its node runtime (`require("fs")` etc.);
 * because almostnode-run code shares this worker's real globalThis (verified), the server's LSP transport
 * (`BrowserMessageReader(globalThis)`) reads/writes the worker's own message channel — which the client
 * connects to directly. So the client sees an ordinary worker server; almostnode is invisible to it.
 *
 * The server is an ESM bundle (node builtins external). almostnode detects ESM by CONTENT, not extension
 * (verified: identical transpiled-ESM content runs the same under `.ts`, `.mjs`, and `.js`) — what it does NOT
 * do is transpile TypeScript type syntax, which fails the ESM parse and falls back to CJS. So we bundle to ESM
 * JS first (types stripped by vite), then write it to the VFS as `.ts` (matching the source) and `runFile` it.
 */
import { createRuntime, VirtualFS } from "almostnode";
// The node server, bundled to an ESM string (node builtins external) by entry.config.ts; run via almostnode below.
import serverNodeCode from "lsp-host:server-node";

async function main(): Promise<void> {
	const vfs = new VirtualFS();

	vfs.writeFileSync("/server-node.ts", serverNodeCode);

	// No `useWorker` → the in-realm Runtime (this worker IS the realm). dangerouslyAllowSameOrigin is required
	// for same-origin execution; the code is our own bundled server, so that's intended.
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true });

	// The bundle is ESM, so almostnode runs it as an ES module and the server's `import` statements work. This
	// sets up the server's LSP connection on this worker's globalThis and returns; its listeners keep it alive.
	await runtime.runFile("/server-node.ts");
}

main().catch((error: unknown) => {
	console.error("[lsp-host/server-host] failed to start node server under almostnode", error);
});
