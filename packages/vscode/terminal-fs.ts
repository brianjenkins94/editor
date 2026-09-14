/**
 * A just-bash `IFileSystem` backed by the editor's own filesystem (`vscode.workspace.fs`).
 *
 * The terminal (just-bash — a pure-TS bash interpreter) writes through THIS, which routes to `workspace.fs` →
 * the workspace-fs overlay. Two things fall out for free by going through that single chokepoint rather than
 * just-bash's default in-memory FS:
 *   • Permissions — a write to a managed/read-only config (see workspace-fs `readonly`) throws `NoPermissions`,
 *     surfaced here as `EACCES`, so `> tsconfig.json` in the shell prints `permission denied` like a real shell.
 *   • Coherence — files the shell creates/edits fire the provider's change events, so they appear in the
 *     explorer and are visible to tsserver; edits in the editor are visible to the shell. One filesystem.
 *
 * just-bash's FS interface is async, which matches `workspace.fs`. The ops vscode's FS API doesn't offer
 * (symlink/readlink, chmod, utimes) degrade: symlinks are unsupported (thrown), chmod/utimes are no-ops — a
 * shell `chmod` deliberately can't override a managed file's read-only-ness (that's the FS's call, not the
 * user's). The two optional interface methods (`readFileBytes`, `readdirWithFileTypes`) are omitted; just-bash
 * falls back to the required ones.
 */
import type { FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash/browser";

import { fs as zenfs } from "@zenfs/core";

/** just-bash's `ReadFileOptions` isn't re-exported from its `/browser` entry, so mirror the shape we use. */
interface ReadOptions { "encoding"?: string | null }

type VscodeApi = typeof import("vscode");

// vscode FileType bits (File=1, Directory=2, SymbolicLink=64) and FilePermission.Readonly (=1). Read numerically
// so this module needs no value import beyond the passed-in api.
const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;
const READONLY = 1;

/** A minimal Error with a unix `code`, so just-bash commands print sane messages (`cat`: "No such file"). */
function fsError(code: string, message: string): Error {
	return Object.assign(new Error(message), { "code": code });
}

/** Translate a vscode FileSystemError into a unix-coded error the shell understands. */
function translate(error: unknown, path: string): Error {
	const name = (error as { "name"?: string } | undefined)?.name ?? "";
	const code = (error as { "code"?: string } | undefined)?.code ?? "";

	if (name.includes("FileNotFound") || code.includes("FileNotFound")) {
		return fsError("ENOENT", `ENOENT: no such file or directory, '${path}'`);
	}

	if (name.includes("NoPermissions") || code.includes("NoPermissions")) {
		return fsError("EACCES", `EACCES: permission denied, '${path}'`);
	}

	if (name.includes("FileExists") || code.includes("FileExists")) {
		return fsError("EEXIST", `EEXIST: file already exists, '${path}'`);
	}

	if (name.includes("FileIsADirectory") || name.includes("FileNotADirectory")) {
		return fsError("EISDIR", `EISDIR: illegal operation on a directory, '${path}'`);
	}

	return error instanceof Error ? error : new Error(String(error));
}

function toBytes(content: FileContent): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** POSIX path resolution — `path` against `base`, collapsing `.`/`..`. Pure arithmetic (no filesystem), so it
 *  satisfies just-bash's SYNChronous `resolvePath` even though our store is async. */
function resolvePosix(base: string, path: string): string {
	const combined = path.startsWith("/") ? path : `${base.endsWith("/") ? base.slice(0, -1) : base}/${path}`;
	const stack: string[] = [];

	for (const part of combined.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}

		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
	}

	return `/${stack.join("/")}`;
}

/**
 * Build a just-bash `IFileSystem` over `api.workspace.fs`. Paths are treated as absolute in the editor's own
 * namespace (`/workspace/...`); pair with `new Bash({ fs, cwd: "/workspace" })`.
 */
export function createWorkspaceTerminalFs(api: VscodeApi): IFileSystem {
	const { fs } = api.workspace;
	const uri = (path: string) => api.Uri.file(path);

	const statRaw = async (path: string) => {
		try {
			return await fs.stat(uri(path));
		} catch (error) {
			throw translate(error, path);
		}
	};

	const toFsStat = (stat: { "type": number; "mtime": number; "size": number; "permissions"?: number }): FsStat => {
		const isDirectory = (stat.type & DIRECTORY) !== 0;
		const isSymbolicLink = (stat.type & SYMLINK) !== 0;
		const isFile = !isDirectory && (stat.type & FILE) !== 0;
		const writable = ((stat.permissions ?? 0) & READONLY) === 0;
		// A unix-ish mode for `ls -l` etc.: dir 0o755, file 0o644 (0o444 when the FS marks it read-only).
		const mode = isDirectory ? 0o040755 : isSymbolicLink ? 0o120777 : 0o100000 | (writable ? 0o644 : 0o444);

		return { "isFile": isFile, "isDirectory": isDirectory, "isSymbolicLink": isSymbolicLink, "mode": mode, "size": stat.size, "mtime": new Date(stat.mtime) };
	};

	return {
		"readFile": async (path: string, options?: ReadOptions | string): Promise<string> => {
			const encoding = (typeof options === "string" ? options : options?.encoding) ?? "utf8";

			try {
				const bytes = await fs.readFile(uri(path));

				return new TextDecoder(encoding === "utf-8" ? "utf8" : (encoding)).decode(bytes);
			} catch (error) {
				throw translate(error, path);
			}
		},

		"readFileBuffer": async (path: string): Promise<Uint8Array> => {
			try {
				return await fs.readFile(uri(path));
			} catch (error) {
				throw translate(error, path);
			}
		},

		"writeFile": async (path: string, content: FileContent): Promise<void> => {
			try {
				await fs.writeFile(uri(path), toBytes(content));
			} catch (error) {
				throw translate(error, path); // NoPermissions on a managed config → EACCES
			}
		},

		"appendFile": async (path: string, content: FileContent): Promise<void> => {
			let existing = new Uint8Array(0);

			try {
				existing = await fs.readFile(uri(path));
			} catch { /* absent → create */ }

			const add = toBytes(content);
			const merged = new Uint8Array(existing.length + add.length);

			merged.set(existing);
			merged.set(add, existing.length);

			try {
				await fs.writeFile(uri(path), merged);
			} catch (error) {
				throw translate(error, path);
			}
		},

		"exists": async (path: string): Promise<boolean> => {
			try {
				await fs.stat(uri(path));

				return true;
			} catch {
				return false;
			}
		},

		"stat": async (path: string): Promise<FsStat> => toFsStat(await statRaw(path)),
		"lstat": async (path: string): Promise<FsStat> => toFsStat(await statRaw(path)),

		"mkdir": async (path: string, _options?: MkdirOptions): Promise<void> => {
			// vscode createDirectory is already recursive and a no-op if the directory exists.
			try {
				await fs.createDirectory(uri(path));
			} catch (error) {
				throw translate(error, path);
			}
		},

		"readdir": async (path: string): Promise<string[]> => {
			try {
				return (await fs.readDirectory(uri(path))).map(([name]) => name);
			} catch (error) {
				throw translate(error, path);
			}
		},

		"rm": async (path: string, options?: RmOptions): Promise<void> => {
			try {
				await fs.delete(uri(path), { "recursive": options?.recursive ?? false, "useTrash": false });
			} catch (error) {
				if (options?.force === true) {
					return; // `rm -f` ignores a missing target
				}

				throw translate(error, path);
			}
		},

		"cp": async (source: string, destination: string): Promise<void> => {
			try {
				await fs.copy(uri(source), uri(destination), { "overwrite": true });
			} catch (error) {
				throw translate(error, destination);
			}
		},

		"mv": async (source: string, destination: string): Promise<void> => {
			try {
				await fs.rename(uri(source), uri(destination), { "overwrite": true });
			} catch (error) {
				throw translate(error, destination); // a managed source/target rejects (workspace-fs rename guard) → EACCES
			}
		},

		// Synchronous helpers. `resolvePath` is pure arithmetic; `getAllPaths` walks the SAME store synchronously
		// via zen-fs (workspace-fs is zen-fs under /workspace) — the async vscode API can't answer a sync method.
		"resolvePath": (base: string, path: string): string => resolvePosix(base, path),

		"getAllPaths": (): string[] => {
			const paths: string[] = [];
			const walk = (dir: string): void => {
				let entries: string[];

				try {
					entries = zenfs.readdirSync(dir);
				} catch {
					return;
				}

				for (const name of entries) {
					const full = dir === "/" ? `/${name}` : `${dir}/${name}`;

					paths.push(full);

					try {
						if (zenfs.statSync(full).isDirectory()) {
							walk(full);
						}
					} catch { /* vanished mid-walk — skip */ }
				}
			};

			walk("/");

			return paths;
		},

		"realpath": async (path: string): Promise<string> => path, // no symlink layer — the path IS the real path

		"chmod": async (): Promise<void> => { /* permissions are the filesystem's call, not the shell's — no-op */ },
		"utimes": async (): Promise<void> => { /* the store doesn't expose mtime writes — no-op */ },

		"symlink": async (_target: string, linkPath: string): Promise<void> => {
			throw fsError("ENOSYS", `ENOSYS: symlinks are not supported, '${linkPath}'`);
		},
		"link": async (_existingPath: string, newPath: string): Promise<void> => {
			throw fsError("ENOSYS", `ENOSYS: hard links are not supported, '${newPath}'`);
		},
		"readlink": async (path: string): Promise<string> => {
			throw fsError("EINVAL", `EINVAL: not a symbolic link, '${path}'`);
		}
	};
}
