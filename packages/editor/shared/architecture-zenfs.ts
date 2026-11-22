import type { ArchSink } from "@brianjenkins94/observability";
import type { FileSystem } from "@zenfs/core";
import { countCall } from "./fs-boundaries";

export const ZENFS_NODE = "zenfs";

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

const UNNAMED_SAMPLE = 200;

let unnamed = 0;

function callerFrame(stack: string | undefined): string {
	const names = (stack ?? "").split("\n").slice(1).map((line) => /at (?:async )?([\w$.<>]+) /u.exec(line)?.[1] ?? "anonymous").filter((name) => name !== "observed" && name !== "Object.observed");

	return names.slice(0, 8).join("<").replaceAll(".", "_");
}

const CONTENT = new Set(["read", "write", "create", "unlink", "rename"]);

export function storeShape(path: string): string | undefined {
	const segments = path.split("/").filter((segment) => segment !== "");

	if (segments.length < 2 || !segments[0].startsWith(".")) {
		return undefined;
	}

	const name = segments.at(-1);
	let kind = "<file>";

	if (name.startsWith(".")) {
		kind = name;
	} else if (name.includes(".")) {
		kind = `<file>${name.slice(name.lastIndexOf("."))}`;
	}

	const directories = segments.slice(0, -1);

	return [...directories.slice(0, 2), ...directories.length > 2 ? ["…"] : [], kind].join("/");
}

export function storeNode(shape: string): string {
	return "store:" + shape;
}

export interface ZenfsObserverOptions {
	"caller"?: () => string | undefined;
	"unattributed"?: string;
	"mountedAt"?: string;
	"shared"?: boolean;
}

function bytesOf(operation: string, args: unknown[]): number {
	if (operation === "write" && args[1] instanceof Uint8Array) {
		return args[1].byteLength;
	}

	if (operation === "read" && typeof args[2] === "number" && typeof args[3] === "number") {
		return Math.max(0, args[3] - args[2]);
	}

	return 0;
}

export function observeZenfs(sink: ArchSink, store: object, options: ZenfsObserverOptions = {}): void {
	const target = store as Record<string | symbol, unknown>;

	if (target[OBSERVED] === true) {
		return;
	}

	target[OBSERVED] = true;
	let depth = 0;
	const wrap = (original: (...parameters: unknown[]) => unknown, operation: string) => function observed(this: unknown, ...args: unknown[]): unknown {
		const outermost = depth === 0;
		const started = outermost ? performance.now() : 0;
		const who = outermost && options.caller !== undefined ? options.caller() ?? options.unattributed ?? "direct" : "direct";

		if (outermost) {
			const caller = options.caller === undefined ? undefined : who;
			const label = caller === undefined ? operation : caller + " · " + operation;
			const shape = typeof args[0] === "string" && CONTENT.has(operation) ? storeShape((options.mountedAt === undefined ? "" : options.mountedAt + "/") + args[0]) : undefined;

			if (options.shared !== false) {
				sink.record(sink.self, ZENFS_NODE, "request", label, bytesOf(operation, args));
			}

			if (shape !== undefined) {
				sink.record(sink.self, storeNode(shape), "request", label);
			}
		}

		depth += 1;

		try {
			return original.apply(this, args);
		} finally {
			depth -= 1;

			if (outermost) {
				countCall(options.mountedAt === undefined ? "zenfs" : "zenfs-local", operation, who, performance.now() - started, typeof args[0] === "string" ? args[0] : undefined, bytesOf(operation, args));

				if (who === "direct" && (unnamed += 1) % UNNAMED_SAMPLE === 0) {
					countCall("zenfs-unnamed", operation, callerFrame(new Error("sample").stack), 0);
				}
			}
		}
	};

	for (const [method, operation] of Object.entries(OPERATIONS)) {
		const original = target[method];

		if (typeof original === "function") {
			target[method] = wrap(original as (...parameters: unknown[]) => unknown, operation);
		}
	}
}

export function reportZenfsUsage(sink: ArchSink, store: { "usage": () => { "totalSpace": number; "freeSpace": number } }, intervalMs = 5000): () => void {
	const megabytes = (bytes: number): string => (bytes / 1048576).toFixed(1) + " MB";
	const update = (): void => {
		const { freeSpace, totalSpace } = store.usage();

		sink.declare({ "id": ZENFS_NODE, "meta": { "used": megabytes(totalSpace - freeSpace) + " of " + megabytes(totalSpace) } });
	};

	update();
	const timer = setInterval(update, intervalMs);

	return () => {
		clearInterval(timer);
	};
}

export function observeStores(sink: ArchSink | undefined, store: FileSystem | undefined, local: { "store": object | undefined; "at": string }, shared: boolean, caller: () => string | undefined): void {
	if (sink !== undefined && store !== undefined) {
		sink.declare({ "id": ZENFS_NODE, "meta": { "backend": shared ? "SingleBuffer (SharedArrayBuffer)" : "InMemory (this realm only)" } });
		observeZenfs(sink, store, { "caller": caller });
		reportZenfsUsage(sink, store);
	}

	if (sink !== undefined && local.store !== undefined) {
		observeZenfs(sink, local.store, { "caller": caller, "mountedAt": local.at, "shared": false });
	}
}
