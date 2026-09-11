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
import type { VirtualFS } from "almostnode";
import { configure, fs, InMemory } from "@zenfs/core";

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

/**
 * Configure zen-fs (InMemory for now) and return a VirtualFS-shaped adapter over it, ready to hand to
 * almostnode's `createRuntime`. Idempotent-friendly: safe to call once per worker.
 */
export async function createZenfsVFS(): Promise<VirtualFS> {
	await configure({ "mounts": { "/": InMemory } });

	// Duck-typed: almostnode only calls the public VirtualFS methods, which this delegates to zen-fs.
	return adapter as unknown as VirtualFS;
}
