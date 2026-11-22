import type { VirtualFS } from "@brianjenkins94/almostnode";
import type { ArchSink } from "@brianjenkins94/observability";
import type { WorkspaceChange } from "./workspace-changes";

import { configure, defaultContext, fs, InMemory, resolveMountConfig, SingleBuffer } from "@zenfs/core";
import { observeZenfs, ZENFS_NODE } from "./architecture-zenfs";
import { watchWorkspaceStore } from "./workspace-changes";

const noopWatcher = { "close": () => undefined };

const adapter = {
	"readFileSync": (path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string => (encoding === undefined ? fs.readFileSync(path) : fs.readFileSync(path, encoding)),
	"writeFileSync": (path: string, data: string | Uint8Array): void => { fs.writeFileSync(path, data); },
	"existsSync": (path: string): boolean => fs.existsSync(path),
	"statSync": (path: string): unknown => fs.statSync(path),
	"lstatSync": (path: string): unknown => fs.lstatSync(path),
	"readdirSync": (path: string): string[] => fs.readdirSync(path),
	"mkdirSync": (path: string, options?: { "recursive"?: boolean }): void => { fs.mkdirSync(path, options); },
	"unlinkSync": (path: string): void => { fs.unlinkSync(path); },
	"rmdirSync": (path: string): void => { fs.rmdirSync(path); },
	"renameSync": (from: string, to: string): void => { fs.renameSync(from, to); },
	"realpathSync": (path: string): string => {
		try {
			return fs.realpathSync(path);
		} catch {
			return path;
		}
	},
	"accessSync": (path: string): void => { fs.accessSync(path); },
	"watch": (): { "close": () => void } => noopWatcher,
	"on": function on(): typeof adapter { return adapter; },
	"off": function off(): typeof adapter { return adapter; },
	"toSnapshot": (): never => { throw new Error("[zenfs-vfs] toSnapshot is unsupported (in-realm runtime only)"); }
};

const WORKSPACE_MOUNT = "/workspace";
let configured = false;
let mounted = false;
let pendingBuffer: SharedArrayBuffer | undefined;
let sharedWorkspaceBuffer: SharedArrayBuffer | undefined;
let connection: WorkspaceConnection = {};

export interface WorkspaceConnection {
	"architecture"?: ArchSink;
	"onChanges"?: (changes: WorkspaceChange[]) => void;
}

export function connectWorkspace(options: WorkspaceConnection): void {
	connection = options;
	const store = mounted ? defaultContext.mounts.get(WORKSPACE_MOUNT) : undefined;

	if (store !== undefined) {
		connectStore(store);
	}
}

function connectStore(store: object): void {
	if (connection.architecture !== undefined) {
		observeZenfs(connection.architecture, store);
	}

	if (connection.onChanges !== undefined) {
		watchWorkspaceStore(store, WORKSPACE_MOUNT, connection.onChanges);
	}
}

export function attachSharedWorkspace(buffer: unknown): void {
	if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
		return;
	}

	sharedWorkspaceBuffer = buffer; // retained so we can hand it to a spawned child worker

	if (configured) {
		void mountSharedWorkspace(buffer);
	} else {
		pendingBuffer = buffer; // createZenfsVFS mounts it once configured
	}
}

export function getSharedWorkspaceBuffer(): SharedArrayBuffer | undefined {
	return sharedWorkspaceBuffer;
}

export async function mountWorkspaceVfs(buffer: SharedArrayBuffer): Promise<VirtualFS> {
	await configure({ "mounts": { "/": InMemory } });
	configured = true;
	sharedWorkspaceBuffer = buffer;
	await mountSharedWorkspace(buffer);

	return adapter;
}

async function mountSharedWorkspace(buffer: SharedArrayBuffer): Promise<void> {
	if (mounted) {
		return;
	}

	mounted = true;
	const store = await resolveMountConfig({ "backend": SingleBuffer, "buffer": buffer });

	store.attributes.set("no_atime", undefined);

	connectStore(store);
	connection.architecture?.record(connection.architecture.self, ZENFS_NODE, "lifecycle", "mount " + WORKSPACE_MOUNT + " (shared " + Math.round(buffer.byteLength / 1048576) + " MB)");

	fs.mount(WORKSPACE_MOUNT, store);
	console.log("[zenfs-vfs] shared workspace mounted at " + WORKSPACE_MOUNT + " — this worker now reads the editor's files");
}

export async function createZenfsVFS(): Promise<VirtualFS> {
	await configure({ "mounts": { "/": InMemory } });
	configured = true;

	const buffer = pendingBuffer;

	if (buffer !== undefined) {
		pendingBuffer = undefined;
		await mountSharedWorkspace(buffer);
	}

	return adapter;
}
