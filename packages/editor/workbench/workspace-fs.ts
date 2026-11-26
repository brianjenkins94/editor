import type { Hub } from "@brianjenkins94/hub";
import type { IFileSystemProviderWithFileReadWriteCapability, IStat, WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { ArchSink } from "@brianjenkins94/observability";
import type { Logger } from "@brianjenkins94/util/logger";
import type { WorkspaceChange } from "../shared/workspace-changes";
import { FileChangeType, FileSystemProviderCapabilities, FileType, registerFileSystemOverlay, Uri } from "@brianjenkins94/monaco-vscode-api/main";
import { LOCAL_DIR } from "@brianjenkins94/util/silo/layout";
import { configure, defaultContext, fs, InMemory, resolveMountConfig, SingleBuffer } from "@zenfs/core";
import { IndexedDB } from "@zenfs/dom";

import { observeStores, ZENFS_NODE } from "../shared/architecture-zenfs";
import { countCall, timeCall } from "../shared/fs-boundaries";
import { fsCaller, vscodeCaller } from "../shared/fs-caller";
import { watchWorkspaceStore, WORKSPACE_CHANGED } from "../shared/workspace-changes";
import { createChangeEvent, notFound, readOnly } from "./provider-base";
import { statCache } from "./stat-cache";

const FILE_PERMISSION_READONLY = 1 as unknown as NonNullable<IStat["permissions"]>;

export interface WorkspaceFs {
	"provider": IFileSystemProviderWithFileReadWriteCapability;
	"reads": number;
	"writes": number;
	"stats": number;
	"statsCached": number;
	"has": (path: string) => boolean;
	"isReadonly": (path: string) => boolean;
	"buffer"?: SharedArrayBuffer;
	"announce": (resources: FileResource[]) => void;
}

type FileResource = Parameters<IFileSystemProviderWithFileReadWriteCapability["writeFile"]>[0];

const PERSIST_DB = "workspace-fs";
const PERSIST_STORE = "files";
const FLUSH_MS = 500;
const BUFFER_BYTES = 128 * 1024 * 1024;

export const LOCAL_MOUNT = `/workspace/${LOCAL_DIR}`;
const LOCAL_DB = "silo-local";
const inLocal = (path: string): boolean => path === LOCAL_MOUNT || path.startsWith(LOCAL_MOUNT + "/");

const RETIRED = new Set(["/workspace/ata-ambient.d.ts"]);

function ensureParent(path: string): void {
	const dir = path.slice(0, path.lastIndexOf("/"));

	if (dir !== "" && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { "recursive": true });
	}
}

function orNotFound<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		const { code } = error as { "code"?: string };

		if (code === "ENOENT" || code === "ENOTDIR") {
			throw notFound();
		}

		throw error;
	}
}

function fileType(stat: { "isDirectory": () => boolean; "isSymbolicLink": () => boolean }): FileType {
	if (stat.isSymbolicLink()) {
		return FileType.SymbolicLink;
	}

	return stat.isDirectory() ? FileType.Directory : FileType.File;
}

function openPersist(): Promise<IDBDatabase | undefined> {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(PERSIST_DB, 1);

			request.onupgradeneeded = () => {
				request.result.createObjectStore(PERSIST_STORE);
			};

			request.onsuccess = () => {
				resolve(request.result);
			};

			request.onerror = () => {
				resolve(undefined);
			};
		} catch {
			resolve(undefined);
		}
	});
}

function persistLoadAll(db: IDBDatabase): Promise<[string, Uint8Array | null][]> {
	return new Promise((resolve) => {
		try {
			const store = db.transaction(PERSIST_STORE, "readonly").objectStore(PERSIST_STORE);
			const keys = store.getAllKeys();
			const values = store.getAll();

			store.transaction.oncomplete = () => {
				resolve((keys.result as string[]).map((key, index) => [key, (values.result as (Uint8Array | null)[])[index]]));
			};

			store.transaction.onerror = () => {
				resolve([]);
			};
		} catch {
			resolve([]);
		}
	});
}

export interface WorkspaceFsOptions {
	"hub"?: Hub;
	"architecture"?: ArchSink;
}

const OVERRIDABLE_DEFAULTS = new Set(["tsconfig.json", "jsconfig.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".gitignore"]);
const relative = (path: string): string => path.replace(/^\/workspace\//u, "");

function seedFiles(files: WorkbenchFile[], readonlyPaths: Set<string>): Set<string> {
	const seeded = new Set<string>();
	const made = new Set<string>();

	for (const file of files) {
		const dir = file.path.slice(0, file.path.lastIndexOf("/"));

		if (!made.has(dir)) {
			made.add(dir);
			ensureParent(file.path);
		}

		fs.writeFileSync(file.path, file.contents);

		for (let { path } = file; path.startsWith("/workspace/"); path = path.slice(0, path.lastIndexOf("/"))) {
			seeded.add(path);
		}

		if (file.readonly === true && !OVERRIDABLE_DEFAULTS.has(relative(file.path))) {
			readonlyPaths.add(file.path);
		}
	}

	return seeded;
}

function restorePersisted(persisted: [string, Uint8Array | null][], localMounted: boolean, folders: Set<string>, mkdir: (path: string) => void, create: (path: string, contents: Uint8Array) => void): { "restored": number; "tombstoned": number; "retired": string[]; "moved": string[] } {
	const made = new Set(folders);
	let restored = 0;
	let tombstoned = 0;
	const retired: string[] = [];
	const moved: string[] = [];

	for (const [path, contents] of persisted) {
		if (RETIRED.has(path)) {
			retired.push(path);
		} else if (localMounted && inLocal(path)) {
			if (contents !== null && !fs.existsSync(path)) {
				ensureParent(path);
				fs.writeFileSync(path, contents);
			}

			moved.push(path);
		} else if (contents === null) {
			try {
				fs.rmSync(path, { "recursive": true, "force": true });
				tombstoned += 1;
			} catch { /* a file stands where its folder was: already gone */ }

			for (const folder of made) {
				if (folder === path || folder.startsWith(path + "/")) {
					made.delete(folder);
				}
			}
		} else {
			const missing: string[] = [];

			for (let dir = path.slice(0, path.lastIndexOf("/")); dir !== "" && !made.has(dir); dir = dir.slice(0, dir.lastIndexOf("/"))) {
				missing.push(dir);
			}

			for (const dir of missing.reverse()) {
				mkdir(dir);
				made.add(dir);
			}

			create(path, contents);
			restored += 1;
		}
	}

	return { "restored": restored, "tombstoned": tombstoned, "retired": retired, "moved": moved };
}

function forgetPersisted(db: IDBDatabase | undefined, paths: string[]): void {
	if (db !== undefined && paths.length > 0) {
		const objects = db.transaction(PERSIST_STORE, "readwrite").objectStore(PERSIST_STORE);

		for (const path of paths) {
			objects.delete(path);
		}
	}
}

const HELD_RETRY_MS = 5;
const HELD_FOR_MS = 2000;

function settled<T>(body: () => T): Promise<T> {
	const until = Date.now() + HELD_FOR_MS;

	return new Promise((resolve, reject) => {
		const attempt = (): void => {
			try {
				resolve(body());
			} catch (error) {
				if ((error as { "code"?: string }).code === "EAGAIN" && Date.now() < until) {
					setTimeout(attempt, HELD_RETRY_MS);
				} else {
					reject(error);
				}
			}
		};

		attempt();
	});
}

export function holdFiles(mounting: Promise<WorkspaceFs | undefined>, root: string): void {
	const held = async <T>({ path }: { "path": string }, call: (store: IFileSystemProviderWithFileReadWriteCapability) => Promise<T>): Promise<T> => {
		const store = path === root || path === `${root}/.vscode` || path.startsWith(`${root}/.vscode/`) ? undefined : await mounting;

		if (store === undefined) {
			throw notFound();
		}

		return call(store.provider);
	};
	const hold = registerFileSystemOverlay(3, {
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": () => undefined })) as never,
		"onDidChangeFile": (() => ({ "dispose": () => undefined })) as never,
		"watch": () => ({ "dispose": () => undefined }),
		"stat": async (resource) => held(resource, async (store) => store.stat(resource)),
		"readFile": async (resource) => held(resource, async (store) => store.readFile(resource)),
		"readdir": async (resource) => held(resource, async (store) => store.readdir(resource)),
		"writeFile": async (resource, content, options) => held(resource, async (store) => store.writeFile(resource, content, options)),
		"mkdir": async (resource) => held(resource, async (store) => store.mkdir(resource)),
		"delete": async (resource, options) => held(resource, async (store) => store.delete(resource, options)),
		"rename": async (from, to, options) => held(from, async (store) => store.rename(from, to, options))
	});

	void mounting.finally(() => {
		hold.dispose();
	});
}

export async function installWorkspaceFs(files: WorkbenchFile[], log: Logger, options: WorkspaceFsOptions = {}): Promise<WorkspaceFs> {
	const { "architecture": sink, hub } = options;
	const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
	const buffer = shared ? new SharedArrayBuffer(BUFFER_BYTES) : undefined;

	if (buffer !== undefined) {
		await configure({ "mounts": { "/": InMemory, "/workspace": { "backend": SingleBuffer, "buffer": buffer } } });
	} else {
		await configure({ "mounts": { "/": InMemory } });
	}

	let localStore: object | undefined;

	try {
		const local = await resolveMountConfig({ "backend": IndexedDB, "storeName": LOCAL_DB });

		fs.mount(LOCAL_MOUNT, local);
		localStore = local;
	} catch (error) {
		log.warn("silo's local/ isn't mounted from IndexedDB — it stays in the workspace store", { "error": String(error) });
	}

	let caller: string | undefined;
	const as = <Args extends unknown[], Result>(name: string, method: (...args: Args) => Result) => (...args: Args): Result => {
		caller = name;

		try {
			return method(...args);
		} finally {
			caller = undefined;
		}
	};

	const store = defaultContext.mounts.get(buffer !== undefined ? "/workspace" : "/");

	for (const each of [store, localStore]) {
		(each as { "attributes"?: Map<string, unknown> } | undefined)?.attributes?.set("no_atime", undefined);
	}

	observeStores(sink, store, { "store": localStore, "at": LOCAL_DIR }, buffer !== undefined, () => caller ?? fsCaller());

	const readonlyPaths = new Set<string>();

	caller = "seed";

	const seeded = seedFiles(files, readonlyPaths);
	const seededFolders = new Set([...seeded].flatMap((path) => {
		const folders: string[] = [];

		for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
			folders.push(path.slice(0, at));
		}

		return folders;
	}));

	caller = undefined;
	const db = await openPersist();
	let restored = 0;
	let tombstoned = 0;

	let retired: string[] = [];
	let moved: string[] = [];

	if (db !== undefined) {
		const persisted = await persistLoadAll(db);

		const mountedAt = buffer !== undefined ? "/workspace" : "";
		const create = (path: string, contents: Uint8Array): void => {
			const inStore = path.slice(mountedAt.length);

			try {
				if (store === undefined) {
					throw new Error("no store");
				}

				store.createFileSync(inStore, { "mode": 0o644, "uid": 0, "gid": 0 });
			} catch {
				fs.writeFileSync(path, contents);

				return;
			}

			store.writeSync(inStore, contents, 0);
		};

		let made = 0;
		const mkdir = (path: string): void => {
			made += 1;

			try {
				if (store === undefined) {
					throw new Error("no store");
				}

				store.mkdirSync(path.slice(mountedAt.length), { "mode": 0o755, "uid": 0, "gid": 0 });
			} catch {
				if (!fs.existsSync(path)) {
					fs.mkdirSync(path, { "recursive": true });
				}
			}
		};

		caller = "restore";
		const folders = new Set([...seeded].map((path) => path.slice(0, path.lastIndexOf("/"))));

		folders.add("/workspace");

		const span = log.span("editor.workbench.workspace-fs.restore", { "count": persisted.length });

		({ restored, tombstoned, retired, moved } = restorePersisted(persisted, localStore !== undefined, folders, mkdir, create));
		span.end({ "restored": restored, "tombstoned": tombstoned, "folders": made });
		caller = undefined;
	}

	const dirty = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const linked = (path: string): boolean => fs.lstatSync(path).isSymbolicLink();
	const filesUnder = (path: string): string[] => {
		const stats = fs.lstatSync(path);

		if (stats.isSymbolicLink()) {
			return [];
		}

		if (!stats.isDirectory()) {
			return [path];
		}

		return fs.readdirSync(path).flatMap((name) => filesUnder(path + "/" + name));
	};

	const flush = (): void => {
		clearTimeout(flushTimer);
		flushTimer = undefined;

		if (db === undefined || dirty.size === 0) {
			dirty.clear();

			return;
		}

		const present = new Map<string, boolean>();
		const walked = (folder: string): boolean => {
			let is = present.get(folder);

			if (is === undefined) {
				is = fs.existsSync(folder) && !linked(folder);
				present.set(folder, is);
			}

			return is;
		};

		const batch = [...dirty].filter((path) => {
			for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
				const folder = path.slice(0, at);

				if (dirty.has(folder) && walked(folder)) {
					return false;
				}
			}

			return true;
		});
		const started = performance.now();
		const span = log.span("editor.workbench.workspace-fs.flush", { "count": batch.length });
		let written = 0;
		let bytes = 0;

		dirty.clear();
		caller = "persist";

		try {
			const transaction = db.transaction(PERSIST_STORE, "readwrite");
			const objects = transaction.objectStore(PERSIST_STORE);

			const seededGoneUnder = (folder: string): void => {
				if (!seededFolders.has(folder)) {
					return;
				}

				for (const each of seeded) {
					if (each.startsWith(folder + "/") && !fs.existsSync(each)) {
						objects.put(null, each);
					}
				}
			};

			for (const path of batch) {
				objects.delete(IDBKeyRange.bound(path + "/", path + "/\uFFFF"));

				if (fs.existsSync(path) && !linked(path)) {
					for (const file of filesUnder(path)) {
						const contents = fs.readFileSync(file);
						const encoded = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;

						objects.put(encoded, file);
						written += 1;
						bytes += encoded.byteLength;
					}
				} else if (seeded.has(path)) {
					objects.put(null, path);
				} else {
					objects.delete(path);
				}

				seededGoneUnder(path);
			}

			transaction.commit();
		} catch (error) {
			log.warn("workspace persistence failed", { "error": String(error) });
		} finally {
			caller = undefined;
			countCall("indexeddb", "flush", "persist", performance.now() - started, undefined, bytes);
			span.end({ "files": written, "bytes": bytes });
		}
	};

	const persist = (path: string): void => {
		dirty.add(path);
		flushTimer ??= setTimeout(flush, FLUSH_MS);
	};

	window.addEventListener("pagehide", flush);

	for (const path of retired) {
		persist(path);
	}

	forgetPersisted(db, moved);

	const { listeners, onDidChangeFile } = createChangeEvent();

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
		"provider": undefined as unknown as IFileSystemProviderWithFileReadWriteCapability,
		"reads": 0,
		"writes": 0,
		"stats": 0,
		"statsCached": 0,
		"has": as("has", (path: string) => fs.existsSync(path)),
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

	const CHANGE_TYPES: Record<WorkspaceChange["type"], FileChangeType> = { "added": FileChangeType.ADDED, "changed": FileChangeType.UPDATED, "deleted": FileChangeType.DELETED };
	const inGit = (path: string): boolean => /\/\.git(?:\/|$)/u.test(path);
	const found = statCache<IStat>();
	const forget = found.forget;
	const apply = (changes: WorkspaceChange[]): void => {
		forget(changes);

		for (const change of changes) {
			if ((change.path === "/workspace" || change.path.startsWith("/workspace/")) && !(localStore !== undefined && inLocal(change.path))) {
				persist(change.path);

				if (!inGit(change.path)) {
					fire(Uri.file(change.path), CHANGE_TYPES[change.type]);
				}
			}
		}
	};

	if (store !== undefined) {
		watchWorkspaceStore(store, buffer !== undefined ? "/workspace" : "", hub === undefined ? apply : (changes) => {
			hub.publish(WORKSPACE_CHANGED, changes);
		}, undefined, forget);
	}

	if (localStore !== undefined) {
		watchWorkspaceStore(localStore, LOCAL_MOUNT, (changes) => {
			for (const change of changes) {
				fire(Uri.file(change.path), CHANGE_TYPES[change.type]);
			}
		}, undefined, forget);
	}

	hub?.subscribe(WORKSPACE_CHANGED, (data) => {
		apply(data as WorkspaceChange[]);
	});

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": () => undefined })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": () => undefined }),

		"stat": (resource): Promise<IStat> => settled(() => {
			let result = found.get(resource.path);

			handle.stats += 1;

			if (result === undefined) {
				try {
					const stat = fs.statSync(resource.path);

					result = { "type": fileType(stat), "ctime": stat.ctimeMs, "mtime": stat.mtimeMs, "size": stat.size };
				} catch (error) {
					const { code } = error as { "code"?: string };

					if (code !== "ENOENT" && code !== "ENOTDIR") {
						throw error;
					}

					result = null;
				}

				found.remember(resource.path, result);
			} else {
				handle.statsCached += 1;
			}

			if (result === null) {
				throw notFound();
			}

			return readonlyPaths.has(resource.path) ? { ...result, "permissions": FILE_PERMISSION_READONLY } : result;
		}),

		"readFile": (resource): Promise<Uint8Array> => settled(() => {
			const data = orNotFound(() => fs.readFileSync(resource.path));

			handle.reads += 1;

			return typeof data === "string" ? new TextEncoder().encode(data) : data;
		}),

		"readdir": (resource): Promise<[string, FileType][]> => settled(() => {
			return orNotFound(() => fs.readdirSync(resource.path, { "withFileTypes": true })).map((entry): [string, FileType] => [entry.name, fileType(entry.isSymbolicLink() ? fs.statSync(resource.path.replace(/\/$/u, "") + "/" + entry.name) : entry)]);
		}),

		"writeFile": (resource, content): Promise<void> => settled(() => {
			if (readonlyPaths.has(resource.path)) {
				throw readOnly();
			}

			ensureParent(resource.path);
			fs.writeFileSync(resource.path, content);
			handle.writes += 1;
		}),

		"mkdir": (resource): Promise<void> => settled(() => {
			fs.mkdirSync(resource.path, { "recursive": true });
		}),

		"delete": (resource, options): Promise<void> => settled(() => {
			if (readonlyPaths.has(resource.path)) {
				throw readOnly();
			}

			fs.rmSync(resource.path, { "recursive": options.recursive, "force": true });
		}),

		"rename": (from, to): Promise<void> => settled(() => {
			if (readonlyPaths.has(from.path) || readonlyPaths.has(to.path)) {
				throw readOnly();
			}

			ensureParent(to.path);
			fs.renameSync(from.path, to.path);
		})
	};

	for (const method of ["stat", "readFile", "readdir", "writeFile", "mkdir", "delete", "rename"] as const) {
		const original = provider[method].bind(provider) as (...args: unknown[]) => unknown;

		(provider as unknown as Record<string, unknown>)[method] = (...args: unknown[]): unknown => {
			const who = vscodeCaller();

			return timeCall("provider", method, who, (args[0] as { "path"?: string } | undefined)?.path, () => as(who, original)(...args));
		};
	}

	registerFileSystemOverlay(2, provider);
	handle.provider = provider;

	// eslint-disable-next-line ts/naming-convention -- the global other realms find the workspace fs handle by
	(globalThis as unknown as { "__workspaceFs": WorkspaceFs }).__workspaceFs = handle;
	log.info("workspace zen-fs mounted", { "backend": buffer !== undefined ? "SingleBuffer" : "InMemory", "mb": Math.round(BUFFER_BYTES / 1048576), "seeded": files.length, "restored": restored, "tombstoned": tombstoned });

	return handle;
}
