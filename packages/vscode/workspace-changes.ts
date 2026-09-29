/**
 * The workspace's ONE change stream. The workspace is a zen-fs store in shared memory that several realms write
 * (the editor through its FileSystemProvider, isomorphic-git and the terminal directly, node scripts and the preview
 * dev server in the node worker) — and shared memory tells nobody anything. So each realm watches the mutating
 * operations its own /workspace store performs and reports them, batched, as `workspace.changed` on the hub:
 *
 *   • the workbench (workspace-fs.ts) persists every change to IndexedDB and announces it to VS Code — whoever wrote;
 *   • the node worker's dev servers hot-reload from it.
 *
 * Watched at the StoreFS level (below `fs`, which is a frozen module namespace), so no writer can go around it.
 * A `touch` is a change only when it changes the size or the modification time — emptying a file is ONLY a touch
 * (size 0) in zen-fs — while a read's access-time touch stays quiet.
 */

/** Hub subject carrying `WorkspaceChange[]` batches. */
export const WORKSPACE_CHANGED = "workspace.changed";

export type WorkspaceChangeType = "added" | "changed" | "deleted";

export interface WorkspaceChange {
	/** Absolute path (under the mount point, e.g. "/workspace/src/App.tsx"). */
	"path": string;
	"type": WorkspaceChangeType;
}

/** StoreFS methods that change the tree, and what each means for the path(s) it's given. */
const MUTATIONS: Record<string, (args: unknown[]) => WorkspaceChange[]> = {};
const one = (type: WorkspaceChangeType) => (args: unknown[]): WorkspaceChange[] => [{ "path": String(args[0]), "type": type }];

for (const [method, describe] of Object.entries({
	"createFile": one("added"),
	"mkdir": one("added"),
	"write": one("changed"),
	"unlink": one("deleted"),
	"rmdir": one("deleted"),
	"rename": (args: unknown[]): WorkspaceChange[] => [{ "path": String(args[0]), "type": "deleted" }, { "path": String(args[1]), "type": "added" }],
	"link": (args: unknown[]): WorkspaceChange[] => [{ "path": String(args[1]), "type": "added" }]
})) {
	MUTATIONS[method] = describe;
	MUTATIONS[method + "Sync"] = describe;
}

const WATCHED = Symbol.for("workspace.changes.watched");

interface Inode { "size"?: number; "mtimeMs"?: number }

/** Did `touch(path, metadata)` change the content-relevant metadata of what `statSync` saw before it? */
function touchChanges(before: Inode | undefined, metadata: unknown): boolean {
	const next = (metadata ?? {}) as Inode;

	return before === undefined
		|| (next.size !== undefined && next.size !== before.size)
		|| (next.mtimeMs !== undefined && next.mtimeMs !== before.mtimeMs);
}

/** Fold `next` into a batch: an add followed by writes is still an add; otherwise the latest word wins. */
function coalesce(batch: Map<string, WorkspaceChangeType>, change: WorkspaceChange): void {
	const previous = batch.get(change.path);

	batch.set(change.path, previous === "added" && change.type === "changed" ? "added" : change.type);
}

/**
 * Watch every tree-changing operation `store` (a zen-fs FileSystem mounted at `mountPoint`, whose methods take
 * mount-relative paths) performs, and hand `onChanges` coalesced batches of absolute paths, `delayMs` after the
 * first change of a burst. A change is reported once its operation has completed. Idempotent per store.
 */
export function watchWorkspaceStore(store: object, mountPoint: string, onChanges: (changes: WorkspaceChange[]) => void, delayMs = 5): void {
	const target = store as Record<string | symbol, unknown>;

	if (target[WATCHED] === true) {
		return;
	}

	target[WATCHED] = true;
	const prefix = mountPoint.replace(/\/$/u, "");
	let batch = new Map<string, WorkspaceChangeType>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const note = (changes: WorkspaceChange[]): void => {
		for (const change of changes) {
			coalesce(batch, { "path": prefix + (change.path === "/" ? "" : change.path), "type": change.type });
		}

		timer ??= setTimeout(() => {
			timer = undefined;
			const flushed = [...batch].map(([path, type]) => ({ "path": path, "type": type }));

			batch = new Map();
			onChanges(flushed);
		}, delayMs);
	};
	const wrap = (original: (...parameters: unknown[]) => unknown, describe: (args: unknown[]) => WorkspaceChange[]) => function watched(this: unknown, ...args: unknown[]): unknown {
		const result = original.apply(this, args);

		if (result instanceof Promise) {
			return result.then((value: unknown) => {
				note(describe(args));

				return value;
			});
		}

		note(describe(args));

		return result;
	};

	for (const [method, describe] of Object.entries(MUTATIONS)) {
		const original = target[method];

		if (typeof original === "function") {
			target[method] = wrap(original as (...parameters: unknown[]) => unknown, describe);
		}
	}

	// The class's own statSync, not an instrumented copy on the instance (the architecture view counts operations).
	const statSync = ((Object.getPrototypeOf(store) as Record<string, unknown>)["statSync"] ?? target["statSync"]) as ((path: string) => Inode) | undefined;
	const statBefore = (path: unknown): Inode | undefined => {
		try {
			return statSync?.call(store, String(path));
		} catch {
			return undefined;
		}
	};

	for (const method of ["touch", "touchSync"]) {
		const original = target[method];

		if (typeof original === "function") {
			target[method] = function watchedTouch(this: unknown, ...args: unknown[]): unknown {
				const changed = touchChanges(statBefore(args[0]), args[1]);

				return wrap(original as (...parameters: unknown[]) => unknown, () => (changed ? one("changed")(args) : [])).apply(this, args);
			};
		}
	}
}
