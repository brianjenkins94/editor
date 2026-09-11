/**
 * `vfs` — a same-origin, SW-served view of the workspace filesystem, the persistent-backend half of the
 * in-browser module resolver (the cousin of {@link ./proxy proxy.ts}'s `__proxy__` CDN convention).
 *
 * Files live in IndexedDB at their REAL in-workspace paths ("/workspace/…", "/node_modules/…"). The workbench
 * populates the store from the host's file snapshot (workbench-entry). A service worker then serves those
 * paths — and resolves bare/builtin imports in served modules — so node-only tooling (eslint loading a flat
 * config, importing plugins) and, later, the preview pane can read the workspace over ordinary same-origin
 * fetch/import. The SW read + resolver logic is inlined into public/coi-serviceworker.js (plain JS can't
 * import this) with a keep-in-sync pointer; this module is the canonical store writer + shared conventions.
 *
 * This file is only the STORE + conventions (used now, by the populate path). The SW-side resolver tiers
 * (node_modules resolution, CDN fallback, builtin shims) are spiked (packages/almostnode-spike) and land with
 * the coi-serviceworker fold-in.
 */

/** IndexedDB name/store for the workspace file view. Keys are absolute paths; values are {@link StoredFile}. */
export const VFS_DB = "vfs-store";
export const VFS_STORE = "files";

/** Path prefixes the SW answers from the store (never outside these, so real app assets aren't shadowed). */
export const VFS_ROOTS = ["/workspace/", "/node_modules/"];

export interface StoredFile {
	"body": string;
	"type": string;
}

const TYPES: Record<string, string> = {
	"js": "text/javascript",
	"mjs": "text/javascript",
	"cjs": "text/javascript",
	"ts": "text/javascript",
	"mts": "text/javascript",
	"cts": "text/javascript",
	"jsx": "text/javascript",
	"tsx": "text/javascript",
	"json": "application/json",
	"css": "text/css",
	"html": "text/html",
	"map": "application/json",
	"wasm": "application/wasm"
};

/** Best-effort content type from a path's extension (defaults to text/plain). */
export function contentTypeFor(path: string): string {
	const dot = path.lastIndexOf(".");

	return (dot === -1 ? undefined : TYPES[path.slice(dot + 1).toLowerCase()]) ?? "text/plain";
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(VFS_DB, 1);

		request.onupgradeneeded = () => { request.result.createObjectStore(VFS_STORE); };
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(request.error); };
	});
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
	return db.transaction(VFS_STORE, mode).objectStore(VFS_STORE);
}

/** Read one file from the store, or undefined if absent. */
export async function vfsGet(path: string): Promise<StoredFile | undefined> {
	const db = await open();

	return new Promise((resolve, reject) => {
		const request = tx(db, "readonly").get(path);

		request.onsuccess = () => { resolve(request.result as StoredFile | undefined); };
		request.onerror = () => { reject(request.error); };
	});
}

/** Write many files in one transaction. `body` is the file text; type is inferred from the path. */
export async function vfsPutAll(files: { "path": string; "contents": string }[]): Promise<void> {
	const db = await open();

	return new Promise((resolve, reject) => {
		const store = tx(db, "readwrite");

		for (const file of files) {
			store.put({ "body": file.contents, "type": contentTypeFor(file.path) } satisfies StoredFile, file.path);
		}

		store.transaction.oncomplete = () => { resolve(); };
		store.transaction.onerror = () => { reject(store.transaction.error); };
	});
}
