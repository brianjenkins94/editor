/**
 * A writable, zen-fs-backed vscode FileSystemProvider for the workspace — M0 of the zen-fs unification.
 *
 * Why: the in-browser tsserver reads on-disk / .d.ts / dependency files by PULLING them through
 * `vscode.workspace.fs` on demand (bridged to sync by VS Code's own @vscode/sync-api SAB), NOT by having content
 * pushed to it. So the type-checker resolves against whatever FileSystemProvider answers — and it only needs that
 * provider to answer promptly, completely, and locally (which is why the async CDN overlay can't feed it, but the
 * in-memory seed can). This makes the workspace filesystem a real, editable store we own — a single zen-fs — that
 * the type-checker reads from directly.
 *
 * M0 is deliberately additive: zen-fs is seeded from the same `files` the workbench boots with and registered as
 * a HIGHER-priority overlay than boot's in-memory seed, so the type-checker reads through zen-fs (proven) with no
 * behaviour change. Later milestones make zen-fs the sole store (drop the boot seed), populate it from ATA/CDN
 * (retiring the bake), swap the backend to a SharedArrayBuffer so the LSP workers + preview share it, and persist
 * it — see the zenfs-vfs.ts seam and the unification design.
 */
import type { IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import { FileChangeType, FileSystemProviderCapabilities, FileType, registerFileSystemOverlay } from "@brianjenkins94/monaco-vscode-api/main";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";
import type { Logger } from "@brianjenkins94/util/logger";
import { configureSingle, fs, InMemory } from "@zenfs/core";

import { createChangeEvent, notFound } from "./provider-base";

/** M0 instrumentation: counts + an existence probe, stashed on globalThis so a verification can confirm the
 *  type-checker actually reads through zen-fs. Harmless; removed once the mechanism is trusted. */
interface WorkspaceFsStats { "reads": number; "writes": number; "has": (path: string) => boolean }

const encoder = new TextEncoder();

/** Ensure the parent directory of `path` exists in zen-fs (recursive mkdir). */
function ensureParent(path: string): void {
	const dir = path.slice(0, path.lastIndexOf("/"));

	if (dir !== "" && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { "recursive": true });
	}
}

/** Map a zen-fs stat to a vscode FileType. */
function fileType(stat: { "isDirectory": () => boolean; "isSymbolicLink": () => boolean }): FileType {
	if (stat.isSymbolicLink()) {
		return FileType.SymbolicLink;
	}

	return stat.isDirectory() ? FileType.Directory : FileType.File;
}

/**
 * Configure a fresh InMemory zen-fs for this realm, seed it with `files`, and return a FileSystemProvider bound
 * to it, registered as an overlay ABOVE the boot seed (priority 2 > boot's 1) so the workbench + type-checker
 * read through zen-fs. Returns the instrumentation handle (also stashed on `globalThis.__workspaceFs`).
 */
export async function installWorkspaceFs(files: WorkbenchFile[], log: Logger): Promise<WorkspaceFsStats> {
	await configureSingle({ "backend": InMemory });

	for (const file of files) {
		ensureParent(file.path);
		fs.writeFileSync(file.path, file.contents);
	}

	const { listeners, onDidChangeFile } = createChangeEvent();
	const fire = (path: string, type: FileChangeType): void => {
		for (const listener of listeners) {
			listener([{ "resource": { "path": path } as never, "type": type }]);
		}
	};

	const stats: WorkspaceFsStats = { "reads": 0, "writes": 0, "has": (path) => fs.existsSync(path) };

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": () => undefined })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": () => undefined }),

		"stat": async (resource): Promise<IStat> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound(); // fall through to a lower overlay (the CDN node_modules provider)
			}

			const stat = fs.statSync(resource.path);

			return { "type": fileType(stat), "ctime": stat.ctimeMs, "mtime": stat.mtimeMs, "size": stat.size };
		},

		"readFile": async (resource): Promise<Uint8Array> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound();
			}

			stats.reads += 1;
			const data = fs.readFileSync(resource.path);

			return typeof data === "string" ? encoder.encode(data) : data;
		},

		"readdir": async (resource): Promise<[string, FileType][]> => {
			if (!fs.existsSync(resource.path)) {
				throw notFound();
			}

			return fs.readdirSync(resource.path).map((name) => {
				const child = resource.path.replace(/\/$/u, "") + "/" + name;

				return [name, fileType(fs.statSync(child))];
			});
		},

		"writeFile": async (resource, content): Promise<void> => {
			const existed = fs.existsSync(resource.path);

			ensureParent(resource.path);
			fs.writeFileSync(resource.path, content);
			stats.writes += 1;
			fire(resource.path, existed ? FileChangeType.UPDATED : FileChangeType.ADDED);
		},

		"mkdir": async (resource): Promise<void> => {
			fs.mkdirSync(resource.path, { "recursive": true });
		},

		"delete": async (resource, options): Promise<void> => {
			fs.rmSync(resource.path, { "recursive": options.recursive, "force": true });
			fire(resource.path, FileChangeType.DELETED);
		},

		"rename": async (from, to): Promise<void> => {
			ensureParent(to.path);
			fs.renameSync(from.path, to.path);
			fire(from.path, FileChangeType.DELETED);
			fire(to.path, FileChangeType.ADDED);
		}
	};

	// Priority 2 — above boot's in-memory seed (1) and the CDN node_modules overlay (0). Reads for a path zen-fs
	// holds are served here; genuine misses (a CDN dep) fall through to the lower overlays.
	registerFileSystemOverlay(2, provider);

	(globalThis as unknown as { "__workspaceFs": WorkspaceFsStats }).__workspaceFs = stats;
	log.info("workspace zen-fs mounted", { "files": files.length });

	return stats;
}
