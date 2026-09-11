/**
 * `vfs` — a same-origin, SW-served view of the workspace filesystem, the persistent-backend half of the
 * in-browser module resolver (public/coi-serviceworker.js).
 *
 * Files live in IndexedDB at their REAL in-workspace paths (under "/workspace/…", including its node_modules).
 * The workbench populates the store from the host's file snapshot (workbench-entry). The service worker then
 * serves those paths — resolving bare/builtin imports in served modules, and on a node_modules store miss
 * falling back to the CDN same-origin (the fold-in that retired the old `__proxy__` route) — so node-only
 * tooling (eslint loading a flat config, importing plugins), the go-to-definition overlay, and later the
 * preview pane can read the workspace over ordinary same-origin fetch/import. The SW read + resolver logic is
 * inlined into coi-serviceworker.js (plain JS can't import this) with a keep-in-sync pointer; this module is
 * the canonical store writer + shared conventions.
 */

/** IndexedDB name/store for the workspace file view. Keys are absolute paths; values are {@link StoredFile}. */
export const VFS_DB = "vfs-store";
export const VFS_STORE = "files";

/** Path prefix the SW answers from the store (never outside it, so real app assets aren't shadowed). The
 *  workspace's node_modules lives under this root ("/workspace/node_modules/"), where bare specifiers resolve —
 *  there is no separate top-level root, and no magic namespaces (see coi-serviceworker.js). */
export const VFS_ROOT = "/workspace/";

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
