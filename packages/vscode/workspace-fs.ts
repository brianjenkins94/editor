/**
 * A writable, zen-fs-backed vscode FileSystemProvider for the workspace — the zen-fs unification.
 *
 * Why: the in-browser tsserver reads on-disk / .d.ts / dependency files by PULLING them through
 * `vscode.workspace.fs` on demand (bridged to sync by VS Code's own @vscode/sync-api SAB), NOT by having content
 * pushed to it. So the type-checker resolves against whatever FileSystemProvider answers — and it only needs that
 * provider to answer promptly, completely, and locally (which is why the async CDN overlay can't feed it, but a
 * local store can). This makes the workspace filesystem a real, editable store we own — a single zen-fs — that
 * the type-checker reads from directly.
 *
 * M0 registered it as a higher-priority overlay than boot's seed (proving the type-checker reads through it).
 * M1 (this): PERSIST it to IndexedDB, so acquired types (from ata.ts) and edits survive a reload — which lets
 * ATA drop its own bespoke cache and write once, here. The baked seed is NOT persisted (only post-boot writes
 * are), so a rebuilt demo file still shows through while a user edit or an acquired type overrides it on restore.
 *
 * M3 swapped the backend to a SharedArrayBuffer (SingleBuffer) so the LSP workers attach to this SAME filesystem
 * (see the zenfs-vfs.ts seam). The service worker deliberately does NOT serve from it: the SW can't be
 * cross-origin isolated on a static host (its own script load isn't stampable with COEP), so a SharedArrayBuffer
 * sent to it degrades to a non-shared copy — the preview instead runs its own in-page dev server, and the SW only
 * folds node_modules in from the CDN. See coi-serviceworker.js.
 */
import type { IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import { FileChangeType, FileSystemProviderCapabilities, FileType, registerFileSystemOverlay } from "@brianjenkins94/monaco-vscode-api/main";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { Logger } from "@brianjenkins94/util/logger";
import { configure, fs, InMemory, SingleBuffer } from "@zenfs/core";

import { createChangeEvent, notFound } from "./provider-base";

/** Handle returned to callers: an existence probe (so ata.ts can skip files already in the store, its
 *  cross-reload dedup), M0 instrumentation counters, and — when the store is SharedArrayBuffer-backed — the
 *  `buffer` itself, so other realms (the LSP workers, M3b) can attach to the SAME filesystem. Also on
 *  `globalThis.__workspaceFs`. */
export interface WorkspaceFs { "reads": number; "writes": number; "has": (path: string) => boolean; "buffer"?: SharedArrayBuffer }

const PERSIST_DB = "workspace-fs";
const PERSIST_STORE = "files";
const FLUSH_MS = 500;
/** Fixed size of the shared filesystem buffer (SingleBuffer can't grow). 64 MB: headroom for a real project's
 *  type surface + sources; tunable. Overflow handling (evict / realloc) is a later concern. */
const BUFFER_BYTES = 64 * 1024 * 1024;

/** Ensure the parent directory of `path` exists in zen-fs (recursive mkdir). */
function ensureParent(path: string): void {
	const dir = path.slice(0, path.lastIndexOf("/"));

	if (dir !== "" && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { "recursive": true });
	}
}

/** Map a zen-fs stat to a vscode FileType. */
function fileType(stat: { "isDirectory": () => boolean; "isSymbolicLink": () => boolean }): FileType {
	if (stat.isSymbolicLink()) {
		return FileType.SymbolicLink;
	}

	return stat.isDirectory() ? FileType.Directory : FileType.File;
}

// ── IndexedDB persistence: post-boot writes (acquired types + edits), keyed by absolute path. ──
function openPersist(): Promise<IDBDatabase | undefined> {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(PERSIST_DB, 1);

			request.onupgradeneeded = () => { request.result.createObjectStore(PERSIST_STORE); };
			request.onsuccess = () => { resolve(request.result); };
			request.onerror = () => { resolve(undefined); };
		} catch {
			resolve(undefined); // private mode / blocked — the store just runs without persistence
		}
	});
}

/** All persisted [path, contents] pairs (for restore on boot). */
function persistLoadAll(db: IDBDatabase): Promise<[string, Uint8Array][]> {
	return new Promise((resolve) => {
		try {
			const store = db.transaction(PERSIST_STORE, "readonly").objectStore(PERSIST_STORE);
			const keys = store.getAllKeys();
			const values = store.getAll();

			store.transaction.oncomplete = () => {
				resolve((keys.result as string[]).map((key, index) => [key, (values.result as Uint8Array[])[index]]));
			};
			store.transaction.onerror = () => resolve([]);
		} catch {
			resolve([]);
		}
	});
}

export async function installWorkspaceFs(files: WorkbenchFile[], log: Logger): Promise<WorkspaceFs> {
	// A SharedArrayBuffer-backed store (zen-fs SingleBuffer) when cross-origin isolation is available — so the LSP
	// workers + preview can later attach to the SAME filesystem via this buffer (M3b). Falls back to InMemory
	// (single-realm) otherwise. COI is required for SharedArrayBuffer and is what the coi service worker provides.
	const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
	const buffer = shared ? new SharedArrayBuffer(BUFFER_BYTES) : undefined;

	// Mount the shared buffer AT /workspace (a clean mount point the LSP workers mount the same buffer at in M3b),
	// with a plain InMemory root for anything outside the workspace. Without a buffer, everything is InMemory.
	// Two separate calls (not a ternary): the branches have different mount keys, so a single call would hand
	// `configure` a UNION of mount shapes it can't infer one `ConfigMounts` type from — each call infers its own.
	if (buffer !== undefined) {
		await configure({ "mounts": { "/": InMemory, "/workspace": { "backend": SingleBuffer, "buffer": buffer } } });
	} else {
		await configure({ "mounts": { "/": InMemory } });
	}

	// Seed the baked snapshot (not persisted — a rebuilt demo file stays fresh), then restore persisted writes
	// (acquired types + edits) on top, so those override the seed for any overlapping path.
	for (const file of files) {
		ensureParent(file.path);
		fs.writeFileSync(file.path, file.contents);
	}

	const db = await openPersist();
	let restored = 0;

	if (db !== undefined) {
		for (const [path, contents] of await persistLoadAll(db)) {
			ensureParent(path);
			fs.writeFileSync(path, contents);
			restored += 1;
		}
	}

	// Debounced write-back: batch dirty paths and flush in one transaction (null = delete).
	const pending = new Map<string, Uint8Array | null>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const flush = (): void => {
		flushTimer = undefined;

		if (db === undefined || pending.size === 0) {
			return;
		}

		const batch = [...pending];
		pending.clear();

		try {
			const store = db.transaction(PERSIST_STORE, "readwrite").objectStore(PERSIST_STORE);

			for (const [path, contents] of batch) {
				if (contents === null) {
					store.delete(path);
				} else {
					store.put(contents, path);
				}
			}
		} catch { /* best-effort persistence */ }
	};
	const persist = (path: string, contents: Uint8Array | null): void => {
		pending.set(path, contents);

		if (flushTimer === undefined) {
			flushTimer = setTimeout(flush, FLUSH_MS);
		}
	};

	const { listeners, onDidChangeFile } = createChangeEvent();
	// Emit change events the way a real vscode provider does: fire the REAL URI (not a `{ path }` stand-in —
	// the Explorer's file-change reaction calls `dirname(resource)` → `resource.with(...)`, which throws
	// `e.with is not a function` on a plain object), and fire it BATCHED + DEFERRED off the write's call stack.
	// Notifying synchronously inside `writeFile` deadlocks first-load type acquisition: the notification makes
	// tsserver (a worker) request a SYNCHRONOUS file read over the @vscode/sync-api SAB, which blocks its thread
	// on the MAIN thread — but the main thread is still inside this listener chain and can't service the read.
	// A short debounce (VS Code's own `fireSoon` pattern) returns control to the event loop and coalesces bursts.
	type Change = { "resource": Parameters<IFileSystemProviderWithFileReadWriteCapability["writeFile"]>[0]; "type": FileChangeType };
	let changeBatch: Change[] = [];
	let changeTimer: ReturnType<typeof setTimeout> | undefined;
	const fire = (resource: Change["resource"], type: FileChangeType): void => {
		changeBatch.push({ "resource": resource, "type": type });

		if (changeTimer === undefined) {
			changeTimer = setTimeout(() => {
				changeTimer = undefined;
				const batch = changeBatch;
				changeBatch = [];

				for (const listener of listeners) {
					listener(batch);
				}
			}, 5);
		}
	};

	const handle: WorkspaceFs = { "reads": 0, "writes": 0, "has": (path) => fs.existsSync(path), "buffer": buffer };

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": () => undefined })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": () => undefined }),

		"stat": async (resource): Promise<IStat> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound(); // fall through to a lower overlay (the CDN node_modules provider)
			}

			const stat = fs.statSync(resource.path);

			return { "type": fileType(stat), "ctime": stat.ctimeMs, "mtime": stat.mtimeMs, "size": stat.size };
		},

		"readFile": async (resource): Promise<Uint8Array> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound();
			}

			handle.reads += 1;
			const data = fs.readFileSync(resource.path);

			return typeof data === "string" ? new TextEncoder().encode(data) : data;
		},

		"readdir": async (resource): Promise<[string, FileType][]> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound();
			}

			return fs.readdirSync(resource.path).map((name) => {
				const child = resource.path.replace(/\/$/u, "") + "/" + name;

				return [name, fileType(fs.statSync(child))];
			});
		},

		"writeFile": async (resource, content): Promise<void> => {
			const existed = fs.existsSync(resource.path);

			ensureParent(resource.path);
			fs.writeFileSync(resource.path, content);
			handle.writes += 1;
			persist(resource.path, content);
			fire(resource, existed ? FileChangeType.UPDATED : FileChangeType.ADDED);
		},

		"mkdir": async (resource): Promise<void> => {
			fs.mkdirSync(resource.path, { "recursive": true });
		},

		"delete": async (resource, options): Promise<void> => {
			fs.rmSync(resource.path, { "recursive": options.recursive, "force": true });
			persist(resource.path, null);
			fire(resource, FileChangeType.DELETED);
		},

		"rename": async (from, to): Promise<void> => {
			ensureParent(to.path);
			const data = fs.readFileSync(from.path);

			fs.renameSync(from.path, to.path);
			persist(from.path, null);
			persist(to.path, typeof data === "string" ? new TextEncoder().encode(data) : data);
			fire(from, FileChangeType.DELETED);
			fire(to, FileChangeType.ADDED);
		}
	};

	// Priority 2 — above boot's in-memory seed (1) and the CDN node_modules overlay (0). Reads for a path zen-fs
	// holds are served here; genuine misses (a CDN dep) fall through to the lower overlays.
	registerFileSystemOverlay(2, provider);

	(globalThis as unknown as { "__workspaceFs": WorkspaceFs }).__workspaceFs = handle;
	log.info("workspace zen-fs mounted", { "backend": buffer !== undefined ? "SingleBuffer" : "InMemory", "mb": Math.round(BUFFER_BYTES / 1048576), "seeded": files.length, "restored": restored });

	return handle;
}
