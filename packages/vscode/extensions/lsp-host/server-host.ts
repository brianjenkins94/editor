/**
 * Spine B worker host — runs almostnode's main-thread Runtime INSIDE this plain worker (no WorkerRuntime,
 * so no nested worker, no Comlink on the channel, no /assets worker asset), then runs the cspell language
 * server (server-node) through it. almostnode gives the server its node runtime (`fs`, `zlib`, dynamic
 * `require`); because almostnode-run code shares this worker's real globalThis (verified), the server's LSP
 * transport (`BrowserMessageReader(globalThis)`) reads/writes the worker's own message channel — which the
 * client connects to directly. So the client sees an ordinary worker server; almostnode is invisible to it.
 *
 * almostnode runs on a zen-fs-backed VFS (zenfs-vfs.ts) rather than its own in-memory tree — so one
 * filesystem backs the runtime's module loads AND the server's dictionary I/O, and later the same zen-fs can
 * be shared (SharedArrayBuffer) with the main thread and bound to a vscode FileSystemProvider. Both the
 * server bundle and the dictionary (a gzipped trie, too big to bundle — served next to this worker under
 * /__vscode__/lsp/, resolved relative to this module's URL) are written into zen-fs before the server runs.
 */
import { createRuntime } from "almostnode";
// The cspell server (with cspell-lib + the LSP lib), bundled to an ESM string by entry.config.ts; run below.
import serverNodeCode from "lsp-host:server-node";
import { createZenfsVFS } from "./zenfs-vfs.js";

// Kept in one place, matched by server-node's DICT_PATH.
const DICT_PATH = "/dicts/en_US.trie.gz";

async function main(): Promise<void> {
	const vfs = await createZenfsVFS();

	// Resolve the dict relative to this served worker's URL. `import.meta.url` is the real worker URL here (a
	// served module, not a data: URL like the manager extension), so a relative asset resolves correctly. Held
	// in a variable so vite treats it as a runtime fetch, not a `new URL(literal, import.meta.url)` asset import.
	const here = import.meta.url;
	const dictUrl = new URL("./dicts/en_US.trie.gz", here);
	const trie = await fetch(dictUrl).then((response) => {
		if (!response.ok) {
			throw new Error(`dict fetch ${response.status} ${dictUrl.href}`);
		}

		return response.arrayBuffer();
	});

	vfs.mkdirSync("/dicts", { "recursive": true });
	vfs.writeFileSync(DICT_PATH, new Uint8Array(trie));
	vfs.writeFileSync("/server-node.ts", serverNodeCode);

	// No `useWorker` → the in-realm Runtime (this worker IS the realm). dangerouslyAllowSameOrigin is required
	// for same-origin execution; the code is our own bundled server, so that's intended. `base` is the deploy
	// base (this worker's served URL minus the "/__vscode__/…" tail) so any `file://` dynamic import resolves
	// under the base-scoped service worker (see createDynamicImport in almostnode/runtime.ts).
	const hereUrl = new URL(here);
	const vscodeCut = hereUrl.pathname.indexOf("/__vscode__/");
	const base = hereUrl.origin + (vscodeCut === -1 ? "/" : hereUrl.pathname.slice(0, vscodeCut + 1));
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "base": base });

	// almostnode runs the ESM bundle as a module (and injects `require` so cspell's CJS deps' dynamic requires
	// resolve). This sets up the server's LSP connection on this worker's globalThis and returns; its listeners
	// keep the worker alive to serve the client.
	await runtime.runFile("/server-node.ts");
}

main().catch((error: unknown) => {
	console.error("[lsp-host/server-host] failed to start cspell server under almostnode", error);
});
