/**
 * A `VirtualFS`-shaped adapter backed by zen-fs, so almostnode runs on zen-fs instead of its own in-memory
 * tree. almostnode drives its VFS through public methods only (readFileSync/existsSync/statSync/readdirSync/
 * writeFileSync/watch/on/…), so we delegate those to zen-fs's `fs`. This is the seam that lets one filesystem
 * back the runtime's module loads, the tool's I/O, and — later — the editor: swap the zen-fs BACKEND from
 * InMemory to a SharedArrayBuffer store shared with the main thread, and bind a vscode FileSystemProvider to
 * the same zen-fs, without touching this adapter or the tools.
 *
 * Today it configures an InMemory backend. Events/watch/snapshot are no-ops: cspell is read-mostly, and the
 * in-realm runtime never calls toSnapshot (that's WorkerRuntime's transfer path). Live coherence (wiring
 * zen-fs change events into `on('change')`) comes with the shared backend.
 *
 * It's a plain object, not a class: there's no per-instance state — every method delegates to zen-fs's single
 * module-global `fs`.
 */
import type { VirtualFS } from "@brianjenkins94/almostnode";
import { configure, fs, InMemory, resolveMountConfig, SingleBuffer } from "@zenfs/core";

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

// ── Shared workspace mount (unification M3b) ────────────────────────────────────────────────────────────────
// The workbench owns a SharedArrayBuffer-backed zen-fs mounted at /workspace; the ext host forwards that buffer
// here over a control MessagePort. We mount the SAME buffer at /workspace, ADDITIVELY — the InMemory root
// (tooling: the dict, the server bundle) is untouched; the worker just GAINS the real workspace files from the
// one filesystem the editor + type-checker use. Non-breaking: if no buffer ever arrives (no COI / standalone),
// the worker runs exactly as before.
const WORKSPACE_MOUNT = "/workspace";
let configured = false;
let mounted = false;
let pendingBuffer: SharedArrayBuffer | undefined;
// The workspace SAB, retained once received so a worker can HAND IT ON to a freshly-spawned child worker (the
// preview.provoke hardReset path spawns a cold child per round; it mounts this same buffer). undefined without COI.
let sharedWorkspaceBuffer: SharedArrayBuffer | undefined;

/** The received workspace SharedArrayBuffer, or undefined if none arrived (no cross-origin isolation / standalone). */
export function getSharedWorkspaceBuffer(): SharedArrayBuffer | undefined {
	return sharedWorkspaceBuffer;
}

/**
 * Mount the workspace SAB into THIS realm's zen-fs and return a VirtualFS adapter over it. For a fresh child
 * worker that received the buffer directly (not over the pod control port) — e.g. the provoke child worker.
 */
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
	fs.mount(WORKSPACE_MOUNT, await resolveMountConfig({ "backend": SingleBuffer, "buffer": buffer }));
	console.log("[zenfs-vfs] shared workspace mounted at " + WORKSPACE_MOUNT + " — this worker now reads the editor's files");
}

/**
 * Configure zen-fs (InMemory root) and return a VirtualFS-shaped adapter over it, ready to hand to almostnode's
 * `createRuntime`. If the shared workspace buffer already arrived, mount it now. Safe to call once per worker.
 */
export async function createZenfsVFS(): Promise<VirtualFS> {
	await configure({ "mounts": { "/": InMemory } });
	configured = true;

	if (pendingBuffer !== undefined) {
		await mountSharedWorkspace(pendingBuffer);
		pendingBuffer = undefined;
	}

	// Duck-typed: almostnode only calls the public VirtualFS methods, which this delegates to zen-fs.
	return adapter;
}

/**
 * Listen — SYNCHRONOUSLY, at module load, before the LSP reader attaches — for the ext host's control port and,
 * over it, the workbench's workspace SharedArrayBuffer; mount it at /workspace when it arrives. Kept off the LSP
 * JSON-RPC channel (a dedicated transferred MessagePort) so the two never collide. Call once at a host's top.
 */
export function receiveSharedWorkspace(): void {
	const onControl = (event: MessageEvent): void => {
		if ((event.data as { "type"?: string } | undefined)?.type !== "ws-control" || event.ports.length === 0) {
			return;
		}

		globalThis.removeEventListener("message", onControl);
		const port = event.ports[0];

		port.addEventListener("message", (message: MessageEvent) => {
			const buffer = (message.data as { "buffer"?: unknown } | undefined)?.buffer;

			if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) {
				sharedWorkspaceBuffer = buffer; // retained so we can hand it to a spawned child worker

				if (configured) {
					void mountSharedWorkspace(buffer);
				} else {
					pendingBuffer = buffer; // createZenfsVFS mounts it once configured
				}
			}
		});
		port.start();
	};

	globalThis.addEventListener("message", onControl);
}
