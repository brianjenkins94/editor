/**
 * The workspace filesystem on the architecture diagram. zen-fs is shared MEMORY, not a channel: every realm that
 * mounts the workspace SharedArrayBuffer reads and writes the same bytes, with no message to observe. So each realm
 * wraps its own `/workspace` store and reports the store operations it performs, as traffic from itself to the
 * `zenfs` node — which is how the diagram shows who touches the workspace, how much, and (in the workbench) through
 * which door: the vscode provider or a direct caller (isomorphic-git, the terminal's path walk).
 */
import type { ArchSink } from "@brianjenkins94/observability";

export const ZENFS_NODE = "zenfs";

/** StoreFS methods, by the operation they report (sync and async twins alike). */
const OPERATIONS: Record<string, string> = {
	"stat": "stat",
	"statSync": "stat",
	"read": "read",
	"readSync": "read",
	"write": "write",
	"writeSync": "write",
	"readdir": "readdir",
	"readdirSync": "readdir",
	"createFile": "create",
	"createFileSync": "create",
	"mkdir": "mkdir",
	"mkdirSync": "mkdir",
	"unlink": "unlink",
	"unlinkSync": "unlink",
	"rmdir": "rmdir",
	"rmdirSync": "rmdir",
	"rename": "rename",
	"renameSync": "rename",
	"touch": "touch",
	"touchSync": "touch",
	"link": "link",
	"linkSync": "link"
};

const OBSERVED = Symbol.for("architecture.zenfs.observed");

/** The operations on a file's content: what a store is made of (a directory's listing or a stat isn't). */
const CONTENT = new Set(["read", "write", "create", "unlink", "rename"]);

/**
 * The store a workspace path belongs to, by its shape — or undefined for the project's own files. A store is what a tool
 * keeps in a dot-directory at the workspace's root (`.silo/`, `.vscode/`, `.git/`); its shape is the directory and the
 * first one in it, anything deeper folded, and the file's kind: `.silo/evidence/<user>/<env>/world.ts.jsonl` →
 * `.silo/evidence/…/<file>.jsonl`. Discovered from what's written and read (DISCOVERED-ARCHITECTURE.md), not listed.
 */
export function storeShape(path: string): string | undefined {
	const segments = path.split("/").filter((segment) => segment !== "");

	if (segments.length < 2 || !segments[0]!.startsWith(".")) {
		return undefined;
	}

	const name = segments.at(-1)!;
	const kind = name.startsWith(".") ? name : name.includes(".") ? `<file>${name.slice(name.lastIndexOf("."))}` : "<file>";
	const directories = segments.slice(0, -1);

	return [...directories.slice(0, 2), ...directories.length > 2 ? ["…"] : [], kind].join("/");
}

/** A store's node on the view. */
export function storeNode(shape: string): string {
	return "store:" + shape;
}

export interface ZenfsObserverOptions {
	/** Who is calling right now (a label prefix, e.g. "vscode"), or undefined for an unattributed caller. */
	"caller"?: () => string | undefined;
	/** The label prefix for an unattributed caller when `caller` is given (default "direct"). */
	"unattributed"?: string;
	/** Where `store` is mounted in the workspace, for its paths' store shapes (`.silo/local` for silo's local/; default:
	 *  the workspace's root). */
	"mountedAt"?: string;
	/** Whether its operations are the shared workspace's (the `zenfs` node): false for a mount of a store of its own. */
	"shared"?: boolean;
}

/** The byte size an operation moved: the data written, or the span read. */
function bytesOf(operation: string, args: unknown[]): number {
	if (operation === "write" && args[1] instanceof Uint8Array) {
		return args[1].byteLength;
	}

	if (operation === "read" && typeof args[2] === "number" && typeof args[3] === "number") {
		return Math.max(0, args[3] - args[2]);
	}

	return 0;
}

/**
 * Report every operation `store` (a zen-fs FileSystem — the `/workspace` mount) performs as `self → zenfs`.
 * Only the outermost call is counted: a store operation that calls another of its own (a write stats first) is one
 * operation, not three. Idempotent per store.
 */
export function observeZenfs(sink: ArchSink, store: object, options: ZenfsObserverOptions = {}): void {
	const target = store as Record<string | symbol, unknown>;

	if (target[OBSERVED] === true) {
		return;
	}

	target[OBSERVED] = true;
	let depth = 0;
	const wrap = (original: (...parameters: unknown[]) => unknown, operation: string) => function observed(this: unknown, ...args: unknown[]): unknown {
		if (depth === 0) {
			const caller = options.caller === undefined ? undefined : (options.caller() ?? options.unattributed ?? "direct");
			const label = caller === undefined ? operation : caller + " · " + operation;
			const shape = typeof args[0] === "string" && CONTENT.has(operation) ? storeShape((options.mountedAt === undefined ? "" : options.mountedAt + "/") + args[0]) : undefined;

			if (options.shared !== false) {
				sink.record(sink.self, ZENFS_NODE, "request", label, bytesOf(operation, args));
			}

			// What it touched, if it's a tool's store.
			if (shape !== undefined) {
				sink.record(sink.self, storeNode(shape), "request", label);
			}
		}

		depth += 1;

		try {
			return original.apply(this, args);
		} finally {
			depth -= 1;
		}
	};

	for (const [method, operation] of Object.entries(OPERATIONS)) {
		const original = target[method];

		if (typeof original === "function") {
			target[method] = wrap(original as (...parameters: unknown[]) => unknown, operation);
		}
	}
}

/** Keep the `zenfs` node's usage gauge current (the owner's view: the buffer is fixed-size). */
export function reportZenfsUsage(sink: ArchSink, store: { "usage": () => { "totalSpace": number; "freeSpace": number } }, intervalMs = 5000): () => void {
	const megabytes = (bytes: number): string => (bytes / 1048576).toFixed(1) + " MB";
	const update = (): void => {
		const { freeSpace, totalSpace } = store.usage();

		sink.declare({ "id": ZENFS_NODE, "meta": { "used": megabytes(totalSpace - freeSpace) + " of " + megabytes(totalSpace) } });
	};

	update();
	const timer = setInterval(update, intervalMs);

	return () => { clearInterval(timer); };
}
