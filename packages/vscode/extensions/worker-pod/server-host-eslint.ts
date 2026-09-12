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
import { createRuntime } from "@brianjenkins94/almostnode";
// The eslint server (eslint-lib + @typescript-eslint/parser + the LSP lib), bundled to an ESM string.
import serverNodeCode from "worker-pod:server-node-eslint";
import { createZenfsVFS } from "./zenfs-vfs.js";

/** The deploy base URL ("https://host/editor/" on Pages, "https://host/" locally), derived from this worker's
 *  own served URL by stripping the "/__vscode__/…" tail. Handed to almostnode so a `file://` dynamic import
 *  (eslint's flat-config loader) resolves UNDER the base — inside the base-scoped service worker's reach. */
function deployBase(): string {
	const here = new URL(import.meta.url);
	const cut = here.pathname.indexOf("/__vscode__/");

	return here.origin + (cut === -1 ? "/" : here.pathname.slice(0, cut + 1));
}

async function main(): Promise<void> {
	const vfs = await createZenfsVFS();

	vfs.writeFileSync("/server-node-eslint.ts", serverNodeCode);

	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "base": deployBase() });

	await runtime.runFile("/server-node-eslint.ts");
}

main().catch((error: unknown) => {
	console.error("[worker-pod/server-host-eslint] failed to start eslint server under almostnode", error);
});
