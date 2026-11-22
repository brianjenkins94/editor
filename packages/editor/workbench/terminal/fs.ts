import type { FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash/browser";

import { fs as store } from "@zenfs/core";
import { callerFs } from "../../shared/fs-caller";

const zenfs = callerFs(store, "terminal");

interface EncodingOptions { "encoding"?: string | null }

function encodingOf(options: EncodingOptions | string | undefined): string {
	return (typeof options === "string"
		? options
		: options?.encoding) ?? "utf8";
}

type VscodeApi = typeof import("vscode");

const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;
const READONLY = 1;

function fsError(code: string, message: string): Error {
	return Object.assign(new Error(message), { "code": code });
}

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

	if (error instanceof Error) {
		return error;
	}

	const thrown = error as string | number | boolean | null | undefined;

	return new Error(String(thrown));
}

function toBytes(content: FileContent, encoding: string): Uint8Array {
	if (typeof content !== "string") {
		return content;
	}

	switch (encoding) {
		case "binary":
		case "latin1":
		case "ascii":
			return Uint8Array.from(content, (char) => char.charCodeAt(0) & 0xFF);
		case "base64":
			return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
		case "hex":
			return Uint8Array.from(content.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
		default:
			return new TextEncoder().encode(content);
	}
}

function fromBytes(bytes: Uint8Array, encoding: string): string {
	if (encoding === "hex") {
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	if (encoding !== "binary" && encoding !== "latin1" && encoding !== "ascii" && encoding !== "base64") {
		return new TextDecoder().decode(bytes);
	}

	let chars = "";

	for (let at = 0; at < bytes.length; at += 8192) {
		chars += String.fromCharCode(...(encoding === "ascii"
			? bytes.subarray(at, at + 8192).map((byte) => byte & 0x7F)
			: bytes.subarray(at, at + 8192)));
	}

	return encoding === "base64"
		? btoa(chars)
		: chars;
}

function resolvePosix(base: string, path: string): string {
	const combined = path.startsWith("/")
		? path
		: `${base.endsWith("/")
			? base.slice(0, -1)
			: base}/${path}`;
	const stack: string[] = [];

	for (const part of combined.split("/")) {
		if (part === "..") {
			stack.pop();
		} else if (part !== "" && part !== ".") {
			stack.push(part);
		}
	}

	return `/${stack.join("/")}`;
}

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
		let mode = 0o100000 | (writable ? 0o644 : 0o444);

		if (isDirectory) {
			mode = 0o040755;
		} else if (isSymbolicLink) {
			mode = 0o120777;
		}

		return {
			"isFile": isFile,
			"isDirectory": isDirectory,
			"isSymbolicLink": isSymbolicLink,
			"mode": mode,
			"size": stat.size,
			"mtime": new Date(stat.mtime)
		};
	};

	return {
		"readFile": async (path: string, options?: EncodingOptions | string): Promise<string> => {
			try {
				return fromBytes(await fs.readFile(uri(path)), encodingOf(options));
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

		"writeFile": async (path: string, content: FileContent, options?: EncodingOptions | string): Promise<void> => {
			try {
				await fs.writeFile(uri(path), toBytes(content, encodingOf(options)));
			} catch (error) {
				throw translate(error, path);
			}
		},

		"appendFile": async (path: string, content: FileContent, options?: EncodingOptions | string): Promise<void> => {
			let existing = new Uint8Array(0);

			try {
				existing = await fs.readFile(uri(path));
			} catch { /* absent → create */ }

			const add = toBytes(content, encodingOf(options));
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
					return;
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
				throw translate(error, destination);
			}
		},

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
					const full = dir === "/"
						? `/${name}`
						: `${dir}/${name}`;

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

		"realpath": (path: string): Promise<string> => Promise.resolve(path),

		"chmod": async (): Promise<void> => { /* permissions are the filesystem's call, not the shell's — no-op */ },
		"utimes": async (): Promise<void> => { /* the store doesn't expose mtime writes — no-op */ },

		"symlink": (_target: string, linkPath: string): Promise<void> => Promise.reject(fsError("ENOSYS", `ENOSYS: symlinks are not supported, '${linkPath}'`)),
		"link": (_existingPath: string, newPath: string): Promise<void> => Promise.reject(fsError("ENOSYS", `ENOSYS: hard links are not supported, '${newPath}'`)),
		"readlink": (path: string): Promise<string> => Promise.reject(fsError("EINVAL", `EINVAL: not a symbolic link, '${path}'`))
	};
}
