import { countCall, timeCall } from "./fs-boundaries";

export const WORKSPACE_CHANGED = "workspace.changed";

export type WorkspaceChangeType = "added" | "changed" | "deleted";

export interface WorkspaceChange {
	"path": string;
	"type": WorkspaceChangeType;
}

const MUTATIONS: Record<string, (args: unknown[]) => WorkspaceChange[]> = {};
const one = (type: WorkspaceChangeType) => (args: unknown[]): WorkspaceChange[] => [{ "path": args[0] as string, "type": type }];

for (const [method, describe] of Object.entries({
	"createFile": one("added"),
	"mkdir": one("added"),
	"write": one("changed"),
	"unlink": one("deleted"),
	"rmdir": one("deleted"),
	"rename": (args: unknown[]): WorkspaceChange[] => [{ "path": args[0] as string, "type": "deleted" }, { "path": args[1] as string, "type": "added" }],
	"link": (args: unknown[]): WorkspaceChange[] => [{ "path": args[1] as string, "type": "added" }]
})) {
	MUTATIONS[method] = describe;
	MUTATIONS[method + "Sync"] = describe;
}

const WATCHED = Symbol.for("workspace.changes.watched");

interface Inode { "size"?: number; "mtimeMs"?: number }

function touchChanges(before: Inode | undefined, metadata: unknown): boolean {
	const next = (metadata ?? {}) as Inode;

	return before === undefined
		|| (next.size !== undefined && next.size !== before.size)
		|| (next.mtimeMs !== undefined && next.mtimeMs !== before.mtimeMs);
}

function coalesce(batch: Map<string, WorkspaceChangeType>, change: WorkspaceChange): void {
	const previous = batch.get(change.path);

	batch.set(change.path, previous === "added" && change.type === "changed" ? "added" : change.type);
}

export function watchWorkspaceStore(store: object, mountPoint: string, onChanges: (changes: WorkspaceChange[]) => void, delayMs = 5, onNow?: (changes: WorkspaceChange[]) => void): void {
	const target = store as Record<string | symbol, unknown>;

	if (target[WATCHED] === true) {
		return;
	}

	target[WATCHED] = true;
	const prefix = mountPoint.replace(/\/$/u, "");
	let batch = new Map<string, WorkspaceChangeType>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const note = (changes: WorkspaceChange[]): void => {
		if (changes.length === 0) {
			return;
		}

		const absolute = changes.map((change) => ({ "path": prefix + (change.path === "/" ? "" : change.path), "type": change.type }));

		onNow?.(absolute);

		for (const change of absolute) {
			coalesce(batch, change);
		}

		timer ??= setTimeout(() => {
			timer = undefined;
			const flushed = [...batch].map(([path, type]) => ({ "path": path, "type": type }));

			batch = new Map();
			timeCall("changes", "batch", "watcher", undefined, () => {
				onChanges(flushed);
			});

			for (const { path } of flushed) {
				countCall("changes", "path", "watcher", 0, path);
			}
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

	const statSync = ((Object.getPrototypeOf(store) as Record<string, unknown>)["statSync"] ?? target["statSync"]) as ((path: string) => Inode) | undefined;
	const statBefore = (path: unknown): Inode | undefined => {
		try {
			return statSync?.call(store, path as string);
		} catch {
			return undefined;
		}
	};

	const pendingOf = (path: unknown): WorkspaceChangeType | undefined => batch.get(prefix + (path === "/" ? "" : String(path)));

	for (const method of ["touch", "touchSync"]) {
		const original = target[method];

		if (typeof original === "function") {
			target[method] = function watchedTouch(this: unknown, ...args: unknown[]): unknown {
				const pending = pendingOf(args[0]);

				if (pending === "added" || pending === "changed") {
					return (original as (...parameters: unknown[]) => unknown).apply(this, args);
				}

				const changed = touchChanges(statBefore(args[0]), args[1]);

				return wrap(original as (...parameters: unknown[]) => unknown, () => (changed ? one("changed")(args) : [])).apply(this, args);
			};
		}
	}
}
