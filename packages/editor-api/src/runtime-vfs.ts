/**
 * almostnode's VirtualFS with the workspace's files through the editor (the run contract's runtime files, runtime-fs.ts
 * answering): what a debugger gives a program's own `fs` (almostnode's `createFsShim` over this), so each of its calls
 * on a workspace file is the editor's to decide, make and keep among the run's effects — one gate for every debugger's
 * programs. Only the primitives are here: VirtualFS builds its callback forms, streams and copies on them. A path outside
 * the workspace (a program's temp files) stays in this worker's memory, as VirtualFS keeps it: the editor has nothing
 * there. The debugger's module loading isn't through this: its reads aren't the program's.
 */
import type { Stats } from "@brianjenkins94/almostnode";
import type { RuntimeFs, RuntimeStat } from "./runtime.ts";
import { VirtualFS } from "@brianjenkins94/almostnode";

/** `path`, absolute and normalized — if it's in the workspace. */
function inWorkspace(path: string): string | undefined {
	const parts: string[] = [];

	for (const part of path.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	const normal = "/" + parts.join("/");

	return path.startsWith("/") && (normal === "/workspace" || normal.startsWith("/workspace/")) ? normal : undefined;
}

/** A stat, as node's `fs.Stats` reads. */
function statsOf({ type, size, mtime }: RuntimeStat): Stats {
	const at = new Date(mtime);

	return {
		"isFile": () => type === "file",
		"isDirectory": () => type === "directory",
		"isSymbolicLink": () => false,
		"isBlockDevice": () => false,
		"isCharacterDevice": () => false,
		"isFIFO": () => false,
		"isSocket": () => false,
		"size": size,
		"mode": type === "directory" ? 0o755 : 0o644,
		"mtime": at,
		"atime": at,
		"ctime": at,
		"birthtime": at,
		"mtimeMs": mtime,
		"atimeMs": mtime,
		"ctimeMs": mtime,
		"birthtimeMs": mtime,
		"nlink": 1,
		"uid": 1000,
		"gid": 1000,
		"dev": 0,
		"ino": 0,
		"rdev": 0,
		"blksize": 4096,
		"blocks": Math.ceil(size / 512)
	};
}

function missing(syscall: string, path: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { "code": "ENOENT", "errno": -2, "syscall": syscall, "path": path });
}

export class RuntimeVfs extends VirtualFS {
	private readonly files: RuntimeFs;

	public constructor(files: RuntimeFs) {
		super();
		this.files = files;
	}

	public override existsSync(path: string): boolean {
		const workspace = inWorkspace(path);

		return workspace === undefined ? super.existsSync(path) : this.files.stat(workspace) !== undefined;
	}

	public override statSync(path: string): Stats {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			return super.statSync(path);
		}

		const stat = this.files.stat(workspace);

		if (stat === undefined) {
			throw missing("stat", path);
		}

		return statsOf(stat);
	}

	public override lstatSync(path: string): Stats {
		return this.statSync(path);
	}

	public override readFileSync(path: string): Uint8Array;
	public override readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
	public override readFileSync(path: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			return encoding === undefined ? super.readFileSync(path) : super.readFileSync(path, encoding);
		}

		const bytes = this.files.readFile(workspace);

		return encoding === undefined ? bytes : new TextDecoder().decode(bytes);
	}

	public override writeFileSync(path: string, data: string | Uint8Array): void {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			super.writeFileSync(path, data);
		} else {
			this.files.writeFile(workspace, data);
		}
	}

	public override mkdirSync(path: string, options?: { "recursive"?: boolean }): void {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			super.mkdirSync(path, options);
		} else {
			this.files.mkdir(workspace);
		}
	}

	public override readdirSync(path: string): string[] {
		const workspace = inWorkspace(path);

		return workspace === undefined ? super.readdirSync(path) : this.files.readdir(workspace);
	}

	public override unlinkSync(path: string): void {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			super.unlinkSync(path);
		} else {
			this.files.rm(workspace);
		}
	}

	public override rmdirSync(path: string): void {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			super.rmdirSync(path);
		} else {
			this.files.rm(workspace);
		}
	}

	public override renameSync(oldPath: string, newPath: string): void {
		const from = inWorkspace(oldPath);
		const to = inWorkspace(newPath);

		if (from !== undefined && to !== undefined) {
			this.files.rename(from, to);
		} else if (from === undefined && to === undefined) {
			super.renameSync(oldPath, newPath);
		} else {
			// (across the workspace's edge: a copy, then the old one gone)
			this.writeFileSync(newPath, this.readFileSync(oldPath));
			this.unlinkSync(oldPath);
		}
	}

	public override realpathSync(path: string): string {
		const workspace = inWorkspace(path);

		if (workspace === undefined) {
			return super.realpathSync(path);
		}

		if (this.files.stat(workspace) === undefined) {
			throw missing("realpath", path);
		}

		return workspace;
	}
}
