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
 * Deleting a seeded path persists a TOMBSTONE (a `null` entry), so it stays deleted rather than reseeded — a replaced
 * workspace (a repo, a playground link) reloads as itself, not with the demo back beside it.
 *
 * M3 swapped the backend to a SharedArrayBuffer (SingleBuffer) so the LSP workers attach to this SAME filesystem
 * (see the zenfs-vfs.ts seam). The service worker deliberately does NOT serve from it: the SW can't be
 * cross-origin isolated on a static host (its own script load isn't stampable with COEP), so a SharedArrayBuffer
 * sent to it degrades to a non-shared copy — the preview instead runs its own in-page dev server, and the SW only
 * folds node_modules in from the CDN. See coi-serviceworker.js.
 */
import type { IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { Hub } from "@brianjenkins94/hub";
import type { ArchSink } from "@brianjenkins94/observability";
import type { Logger } from "@brianjenkins94/util/logger";
import type { WorkspaceChange } from "./workspace-changes";
import { FileChangeType, FileSystemProviderCapabilities, FileType, registerFileSystemOverlay, Uri } from "@brianjenkins94/monaco-vscode-api/main";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/evidence";
import { configure, fs, InMemory, mounts, resolveMountConfig, SingleBuffer } from "@zenfs/core";
import { IndexedDB } from "@zenfs/dom";

import { observeZenfs, reportZenfsUsage, ZENFS_NODE } from "./architecture-zenfs";
import { createChangeEvent, notFound, readOnly } from "./provider-base";
import { WORKSPACE_CHANGED, watchWorkspaceStore } from "./workspace-changes";

/** VS Code's platform `FilePermission.Readonly` bit (vs/platform/files/common/files: `Readonly = 1 << 0`). Set in
 *  a file's `stat`, it makes the editor render the read-only lock, disable editing the buffer, and block Save. The
 *  platform enum isn't re-exported by the api surface, so use the constant; `writeFile` enforces the block for real
 *  (the permission is only the UI hint — a provider that answered writes anyway would silently accept them). */
const FILE_PERMISSION_READONLY = 1 as unknown as NonNullable<IStat["permissions"]>;

/** Handle returned to callers: an existence probe (so ata.ts can skip files already in the store, its
 *  cross-reload dedup), a read-only probe (so a client filesystem — e.g. the just-bash terminal adapter — can
 *  reflect managed configs as un-writable), M0 instrumentation counters, and — when the store is
 *  SharedArrayBuffer-backed — the `buffer` itself, so other realms (the LSP workers, M3b) can attach to the SAME
 *  filesystem. Also on `globalThis.__workspaceFs`. */
export interface WorkspaceFs {
	"reads": number;
	"writes": number;
	"has": (path: string) => boolean;
	"isReadonly": (path: string) => boolean;
	"buffer"?: SharedArrayBuffer;
	/** Fire a change event for files that are already in the store, so services that read them once at startup —
	 *  before this overlay was mounted — re-read them (the configuration service and `.vscode/settings.json`). */
	"announce": (resources: FileResource[]) => void;
}

/** The URI type the provider's methods take (vscode's own URI; the extension API's `Uri.file` produces one). */
type FileResource = Parameters<IFileSystemProviderWithFileReadWriteCapability["writeFile"]>[0];

const PERSIST_DB = "workspace-fs";
const PERSIST_STORE = "files";
const FLUSH_MS = 500;
/** Fixed size of the shared filesystem buffer (SingleBuffer can't grow). 64 MB: headroom for a real project's
 *  type surface + sources; tunable. Overflow handling (evict / realloc) is a later concern. */
const BUFFER_BYTES = 64 * 1024 * 1024;
/**
 * Silo's `local/` — what stays on this machine (the edit history, raw profiles, BABLR's verdicts): files like any other
 * under `/workspace`, but mounted from an IndexedDB store of its own (`silo-local`), not kept in the shared buffer —
 * whose fixed size the whole project shares, and which it would otherwise eat. Only this realm mounts it (nothing the
 * workers run needs it), and only this realm writes it. zen-fs keeps a copy of the store in memory, for the provider's
 * synchronous reads, so what's kept here stays small: each user of it caps what it keeps.
 */
export const LOCAL_MOUNT = `/workspace/${LOCAL_DIR}`;
const LOCAL_DB = "silo-local";
const inLocal = (path: string): boolean => path === LOCAL_MOUNT || path.startsWith(LOCAL_MOUNT + "/");

/** Persisted paths an older build wrote that no longer exist (ATA's retired force-reference file). */
const RETIRED = new Set(["/workspace/ata-ambient.d.ts"]);

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

/** All persisted [path, contents] pairs (for restore on boot), in path order: a folder before what's in it. `null`
 *  contents are a tombstone — a seeded path deleted since. */
function persistLoadAll(db: IDBDatabase): Promise<[string, Uint8Array | null][]> {
	return new Promise((resolve) => {
		try {
			const store = db.transaction(PERSIST_STORE, "readonly").objectStore(PERSIST_STORE);
			const keys = store.getAllKeys();
			const values = store.getAll();

			store.transaction.oncomplete = () => {
				resolve((keys.result as string[]).map((key, index) => [key, (values.result as (Uint8Array | null)[])[index]]));
			};

			store.transaction.onerror = () => { resolve([]); };
		} catch {
			resolve([]);
		}
	});
}

export interface WorkspaceFsOptions {
	/** The workbench hub: every realm reports its writes to the workspace as `workspace.changed` on it (see
	 *  workspace-changes.ts), and they're all persisted and announced here. Without one, only this realm's are. */
	"hub"?: Hub;
	/** Puts the workspace on the live architecture diagram: every store operation, by caller (the vscode provider,
	 *  the boot seed, persistence, or a direct zen-fs user), and every change batch announced to VS Code. */
	"architecture"?: ArchSink;
}

export async function installWorkspaceFs(files: WorkbenchFile[], log: Logger, options: WorkspaceFsOptions = {}): Promise<WorkspaceFs> {
	const { architecture: sink, hub } = options;
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

	// Silo's local/, from its own IndexedDB store (LOCAL_MOUNT) — before the seed and the restore, which may write there.
	// Without IndexedDB (a private window), it stays in the workspace store like any folder.
	let localStore: object | undefined;

	try {
		const local = await resolveMountConfig({ "backend": IndexedDB, "storeName": LOCAL_DB });

		fs.mount(LOCAL_MOUNT, local);
		localStore = local;
	} catch (error) {
		log.warn("silo's local/ isn't mounted from IndexedDB — it stays in the workspace store", { "error": String(error) });
	}

	// Who is calling the store right now: the provider and the boot seed say so; anyone else is a direct caller.
	// Provider methods do all their zen-fs work synchronously (no await before it), so a plain variable is enough.
	let caller: string | undefined;
	const as = <Args extends unknown[], Result>(name: string, method: (...args: Args) => Result) => (...args: Args): Result => {
		caller = name;

		try {
			return method(...args);
		} finally {
			caller = undefined;
		}
	};
	const store = mounts.get(buffer !== undefined ? "/workspace" : "/");

	if (sink !== undefined && store !== undefined) {
		sink.declare({ "id": ZENFS_NODE, "meta": { "backend": buffer !== undefined ? "SingleBuffer (SharedArrayBuffer)" : "InMemory (this realm only)" } });
		observeZenfs(sink, store, { "caller": () => caller });
		reportZenfsUsage(sink, store);
	}

	// Paths seeded read-only (managed configs like tsconfig.json, the baked type surface, ambient files). The
	// snapshot carries the `readonly` flag; we enforce it here — boot's own seed marks them read-only too, but this
	// overlay sits ABOVE it and would otherwise answer their stats/writes as writable, shadowing that. A `Set`
	// (not a per-file bit) so a future "unlock to customize" can just drop the entry. Seeded files only: a file the
	// user later creates is never in here, so it stays writable.
	const readonlyPaths = new Set<string>();

	// Managed configs are OVERRIDABLE DEFAULTS, not locked files: they're seeded into zen-fs like everything else
	// but left WRITABLE so a repo load can clear/overwrite them. On replace (see workbench-entry.tsx) the TS project
	// configs then fall through to boot's read-only priority-1 base when a repo omits them (tsserver reads via the
	// composite file service), while the worker-consumed ones (eslint.config, .gitignore — read straight off THIS
	// zen-fs by the LSP pod / isomorphic-git, so a priority-1 base is invisible) get the base default MATERIALIZED
	// back into zen-fs. Only the type surface stays locked. Match by workspace-relative path (the snapshot marks
	// root-level configs readonly). Keep in sync with workbench-entry.tsx OVERRIDABLE_DEFAULTS.
	const OVERRIDABLE_DEFAULTS = new Set(["tsconfig.json", "jsconfig.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".gitignore"]);
	const relative = (path: string): string => path.replace(/^\/workspace\//u, "");

	// Seed the baked snapshot (not persisted — a rebuilt demo file stays fresh), then restore persisted writes
	// (acquired types + edits) on top, so those override the seed for any overlapping path.
	caller = "seed";

	// Every path the seed makes, its folders included: deleting one of these needs a tombstone to stay deleted.
	const seeded = new Set<string>();

	for (const file of files) {
		ensureParent(file.path);
		fs.writeFileSync(file.path, file.contents);

		for (let path = file.path; path.startsWith("/workspace/"); path = path.slice(0, path.lastIndexOf("/"))) {
			seeded.add(path);
		}

		if (file.readonly === true && !OVERRIDABLE_DEFAULTS.has(relative(file.path))) {
			readonlyPaths.add(file.path);
		}
	}

	caller = undefined;
	const db = await openPersist();
	let restored = 0;
	let tombstoned = 0;

	const retired: string[] = [];
	const moved: string[] = [];

	if (db !== undefined) {
		const persisted = await persistLoadAll(db);

		caller = "restore";

		for (const [path, contents] of persisted) {
			if (RETIRED.has(path)) {
				retired.push(path); // written by an older build; dropped below rather than brought back
			} else if (localStore !== undefined && inLocal(path)) {
				// An older build kept silo's local/ in the workspace store: move it into its own (once), and out of here.
				if (contents !== null && !fs.existsSync(path)) {
					ensureParent(path);
					fs.writeFileSync(path, contents);
				}

				moved.push(path);
			} else if (contents === null) {
				try {
					fs.rmSync(path, { "recursive": true, "force": true }); // seeded, deleted since: it stays deleted
					tombstoned += 1;
				} catch { /* a file stands where its folder was: already gone */ }
			} else {
				ensureParent(path);
				fs.writeFileSync(path, contents);
				restored += 1;
			}
		}

		caller = undefined;
	}

	// Write-back, from the change stream: batch the paths that changed and, per flush, copy each one's CURRENT state
	// from zen-fs into IndexedDB in one transaction — a file is put, a directory's files are put (a renamed or copied
	// tree), and a missing path is deleted along with everything that was under it (a recursive delete, a renamed-away
	// tree). Reading the state at flush time rather than capturing it per write means a burst of writes to one file
	// costs one put, and it doesn't matter which realm wrote.
	const dirty = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const filesUnder = (path: string): string[] => {
		if (!fs.statSync(path).isDirectory()) {
			return [path];
		}

		return fs.readdirSync(path).flatMap((name) => filesUnder(path + "/" + name));
	};
	const flush = (): void => {
		flushTimer = undefined;

		if (db === undefined || dirty.size === 0) {
			dirty.clear();

			return;
		}

		const batch = [...dirty];

		dirty.clear();
		caller = "persist";

		try {
			const objects = db.transaction(PERSIST_STORE, "readwrite").objectStore(PERSIST_STORE);

			for (const path of batch) {
				if (fs.existsSync(path)) {
					for (const file of filesUnder(path)) {
						const contents = fs.readFileSync(file);

						objects.put(typeof contents === "string" ? new TextEncoder().encode(contents) : contents, file);
					}
				} else {
					objects.delete(IDBKeyRange.bound(path + "/", path + "/\uffff"));

					// The seed would bring a path it has back on the next boot, so that one gets a tombstone (a later
					// write replaces it); anything else just goes.
					if (seeded.has(path)) {
						objects.put(null, path);
					} else {
						objects.delete(path);
					}
				}
			}
		} catch (error) {
			log.warn("workspace persistence failed", { "error": String(error) }); // best-effort: the store still has it
		} finally {
			caller = undefined;
		}
	};

	const persist = (path: string): void => {
		dirty.add(path);
		flushTimer ??= setTimeout(flush, FLUSH_MS);
	};

	for (const path of retired) {
		persist(path); // gone from zen-fs, so the flush deletes it
	}

	// What moved into silo's local/ lives in its own store now: out of this one's persistence.
	if (db !== undefined && moved.length > 0) {
		const objects = db.transaction(PERSIST_STORE, "readwrite").objectStore(PERSIST_STORE);

		for (const path of moved) {
			objects.delete(path);
		}
	}

	const { listeners, onDidChangeFile } = createChangeEvent();

	// Emit change events the way a real vscode provider does: fire the REAL URI (not a `{ path }` stand-in —
	// the Explorer's file-change reaction calls `dirname(resource)` → `resource.with(...)`, which throws
	// `e.with is not a function` on a plain object), and fire it BATCHED + DEFERRED off the write's call stack.
	// Notifying synchronously inside `writeFile` deadlocks first-load type acquisition: the notification makes
	// tsserver (a worker) request a SYNCHRONOUS file read over the @vscode/sync-api SAB, which blocks its thread
	// on the MAIN thread — but the main thread is still inside this listener chain and can't service the read.
	// A short debounce (VS Code's own `fireSoon` pattern) returns control to the event loop and coalesces bursts.
	interface Change { "resource": Parameters<IFileSystemProviderWithFileReadWriteCapability["writeFile"]>[0]; "type": FileChangeType }
	let changeBatch: Change[] = [];
	let changeTimer: ReturnType<typeof setTimeout> | undefined;
	const fire = (resource: Change["resource"], type: FileChangeType): void => {
		changeBatch.push({ "resource": resource, "type": type });

		if (changeTimer === undefined) {
			changeTimer = setTimeout(() => {
				changeTimer = undefined;
				const batch = changeBatch;

				changeBatch = [];
				sink?.record(ZENFS_NODE, sink.self, "event", "onDidChangeFile", batch.length);

				for (const listener of listeners) {
					listener(batch);
				}
			}, 5);
		}
	};

	const handle: WorkspaceFs = {
		"reads": 0,
		"writes": 0,
		"has": (path) => fs.existsSync(path),
		"isReadonly": (path) => readonlyPaths.has(path),
		"buffer": buffer,
		"announce": (resources) => {
			for (const resource of resources) {
				if (fs.existsSync(resource.path)) {
					fire(resource, FileChangeType.UPDATED);
				}
			}
		}
	};

	// THE change path: every write to the workspace, from any realm, arrives here once — persisted, and announced to
	// VS Code (the explorer, tsserver, open editors) as if the provider had made it. Registered after the seed and the
	// restore, which are neither.
	const CHANGE_TYPES: Record<WorkspaceChange["type"], FileChangeType> = { "added": FileChangeType.ADDED, "changed": FileChangeType.UPDATED, "deleted": FileChangeType.DELETED };
	// `.git/**` is persisted but not announced: the git SCM + service watch `**/*` and refresh, and a refresh writes
	// .git (the index's stat cache, verdict caches) — announcing those would loop. (VS Code's own watcherExclude
	// leaves .git out for the same reason.)
	const inGit = (path: string): boolean => /\/\.git(?:\/|$)/u.test(path);
	const apply = (changes: WorkspaceChange[]): void => {
		for (const change of changes) {
			if ((change.path === "/workspace" || change.path.startsWith("/workspace/")) && !(localStore !== undefined && inLocal(change.path))) {
				persist(change.path);

				if (!inGit(change.path)) {
					fire(Uri.file(change.path) as unknown as Change["resource"], CHANGE_TYPES[change.type]);
				}
			}
		}
	};

	if (store !== undefined) {
		watchWorkspaceStore(store, buffer !== undefined ? "/workspace" : "", hub === undefined ? apply : (changes) => { hub.publish(WORKSPACE_CHANGED, changes); });
	}

	// Silo's local/ changes too: announced to VS Code (a saved profile, say), but neither persisted (its store is its
	// own) nor told to the other realms (they don't mount it).
	if (localStore !== undefined) {
		watchWorkspaceStore(localStore, LOCAL_MOUNT, (changes) => {
			for (const change of changes) {
				fire(Uri.file(change.path) as unknown as Change["resource"], CHANGE_TYPES[change.type]);
			}
		});
	}

	hub?.subscribe(WORKSPACE_CHANGED, (data) => { apply(data as WorkspaceChange[]); });

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
			const result: IStat = { "type": fileType(stat), "ctime": stat.ctimeMs, "mtime": stat.mtimeMs, "size": stat.size };

			return readonlyPaths.has(resource.path) ? { ...result, "permissions": FILE_PERMISSION_READONLY } : result;
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
			if (readonlyPaths.has(resource.path)) {
				throw readOnly(); // managed/read-only — reject EVERY write path (editor Save, the vscode API, the terminal)
			}

			ensureParent(resource.path);
			fs.writeFileSync(resource.path, content); // persisted + announced by the change stream (apply)
			handle.writes += 1;
		},

		"mkdir": async (resource): Promise<void> => {
			fs.mkdirSync(resource.path, { "recursive": true });
		},

		"delete": async (resource, options): Promise<void> => {
			if (readonlyPaths.has(resource.path)) {
				throw readOnly(); // a managed config can't be deleted out from under the tooling that owns it
			}

			fs.rmSync(resource.path, { "recursive": options.recursive, "force": true });
		},

		"rename": async (from, to): Promise<void> => {
			if (readonlyPaths.has(from.path) || readonlyPaths.has(to.path)) {
				throw readOnly(); // can't rename a managed file away, nor clobber one by renaming onto it
			}

			ensureParent(to.path);
			fs.renameSync(from.path, to.path); // a file or a whole directory — the change stream persists what moved
		}
	};

	// Priority 2 — above boot's in-memory seed (1) and the CDN node_modules overlay (0). Reads for a path zen-fs
	// holds are served here; genuine misses (a CDN dep) fall through to the lower overlays.
	for (const method of ["stat", "readFile", "readdir", "writeFile", "mkdir", "delete", "rename"] as const) {
		(provider as unknown as Record<string, unknown>)[method] = as("vscode", provider[method] as (...args: unknown[]) => unknown);
	}

	registerFileSystemOverlay(2, provider);

	(globalThis as unknown as { "__workspaceFs": WorkspaceFs }).__workspaceFs = handle;
	log.info("workspace zen-fs mounted", { "backend": buffer !== undefined ? "SingleBuffer" : "InMemory", "mb": Math.round(BUFFER_BYTES / 1048576), "seeded": files.length, "restored": restored, "tombstoned": tombstoned });

	return handle;
}
