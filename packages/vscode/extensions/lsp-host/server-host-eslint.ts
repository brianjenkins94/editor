/**
 * eslint worker host — runs almostnode's in-realm Runtime inside this plain worker on a zen-fs VFS, then runs
 * the eslint language server (server-node-eslint) through it. Same shape as the cspell host (server-host.ts):
 * almostnode gives the server its node runtime; the server's LSP transport (BrowserMessageReader(globalThis))
 * is this worker's own message channel, which the client connects to directly.
 *
 * No assets to seed: this eslint server lints with an inline flat config, so nothing is written to the VFS
 * beyond the server bundle itself. (When we load the workspace's eslint.config.js, this is where we'd seed /
 * bridge the workspace files into zen-fs first — the file:// import patch + zen-fs VFS already support it.)
 */
import { createRuntime } from "almostnode";
// The eslint server (eslint-lib + @typescript-eslint/parser + the LSP lib), bundled to an ESM string.
import serverNodeCode from "lsp-host:server-node-eslint";
import { createZenfsVFS } from "./zenfs-vfs.js";

async function main(): Promise<void> {
	const vfs = await createZenfsVFS();

	vfs.writeFileSync("/server-node-eslint.ts", serverNodeCode);

	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true });

	await runtime.runFile("/server-node-eslint.ts");
}

main().catch((error: unknown) => {
	console.error("[lsp-host/server-host-eslint] failed to start eslint server under almostnode", error);
});
