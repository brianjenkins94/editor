/**
 * A commit beside the work, read-only: a branch, tag or commit opened is a folder of the workspace, `.refs/<name>/`, its
 * files as that commit has them, read from git's objects — no copy in the workspace's store. It's how a removed
 * feature's code is read at its tombstone, and the rewrite's Measure reads `full-editor` (ARCHITECTURE.md, *The
 * rewrite, in place*). The Explorer, Quick Open, Find in Files and agents' files_* read it as any folder; git doesn't
 * see it (it reads the store), nor does TypeScript's project (a dot-folder), and the walks for the project's manifests
 * leave it out (editor-api's `REFS_DIR`). Nothing is written there: a write is refused, not let fall through to the workspace.
 *
 * - the command `editor.git.openRef` ("Git: Open a Commit Read-Only…"): a branch, tag or commit, fetched one commit deep
 *   when the clone hasn't it, then shown in the Explorer;
 * - `git.openRef` { ref }: the same, for agents' `git_open`.
 *
 * Open until the window reloads.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { IFileSystemProviderWithFileReadWriteCapability, IStat } from "@brianjenkins94/monaco-vscode-api/main";
import type { Logger } from "@brianjenkins94/util/logger";
import type { HttpClient } from "isomorphic-git";
import type * as vscodeApi from "vscode";
import { REFS_DIR } from "@brianjenkins94/editor-api/git";
import { serve } from "@brianjenkins94/hub";
import { FileChangeType, FilePermission, FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, FileType, registerFileSystemOverlay, Uri } from "@brianjenkins94/monaco-vscode-api/main";
import { timeCall } from "../shared/fs-boundaries";
import { vscodeCaller } from "../shared/fs-caller";
import * as engine from "./git-engine";
import { createChangeEvent, notFound } from "./provider-base";

const DIR = "/workspace";
const ROOT = `${DIR}/${REFS_DIR}`;

/** An entry of a commit's tree. */
type Entry = NonNullable<Awaited<ReturnType<typeof engine.treeAt>>>[number];

/** A commit opened: its oid and when it was made (its files' times). */
interface Opened { "oid": string; "time": number }

/** A write somewhere under `.refs/`, refused — an error the overlay doesn't pass on to the workspace's provider. */
function refused(path: string): FileSystemProviderError {
	return FileSystemProviderError.create(`${path} is a commit's, read-only`, FileSystemProviderErrorCode.FileWriteLocked);
}

/** Not this provider's to write: the overlay tries the next one. */
function notOurs(): FileSystemProviderError {
	return FileSystemProviderError.create("not a commit's", FileSystemProviderErrorCode.Unavailable);
}

export function installGitRefs(vscode: typeof vscodeApi, hub: Hub, log: Logger, remote?: HttpClient): void {
	const opened = new Map<string, Opened>();
	const trees = new Map<string, Promise<Entry[] | undefined>>();
	const blobs = new Map<string, Promise<Uint8Array>>();
	const { listeners, onDidChangeFile } = createChangeEvent();

	const treeOf = (commit: string, path: string): Promise<Entry[] | undefined> => {
		const key = commit + ":" + path;
		let tree = trees.get(key);

		if (tree === undefined) {
			tree = engine.treeAt(commit, path);
			trees.set(key, tree);
		}

		return tree;
	};
	const blobOf = (oid: string): Promise<Uint8Array> => {
		let blob = blobs.get(oid);

		if (blob === undefined) {
			blob = engine.blobBytes(oid);
			blobs.set(oid, blob);
		}

		return blob;
	};

	/** Where `path` is: `.refs/` itself (no name), a commit's folder or a path in it; undefined outside `.refs/`. */
	const where = (path: string): { "name"?: string; "path": string } | undefined => {
		if (path === ROOT) {
			return { "path": "" };
		}

		if (!path.startsWith(ROOT + "/")) {
			return undefined;
		}

		const [name, ...rest] = path.slice(ROOT.length + 1).split("/");

		return { "name": name, "path": rest.join("/") };
	};

	/** `path`'s entry in the commit opened as `name`: its root is a tree. */
	const entryOf = async (name: string, path: string): Promise<{ "commit": Opened; "entry": Pick<Entry, "type" | "oid"> } | undefined> => {
		const commit = opened.get(name);

		if (commit === undefined) {
			return undefined;
		}

		if (path === "") {
			return { "commit": commit, "entry": { "type": "tree", "oid": commit.oid } };
		}

		const slash = path.lastIndexOf("/");
		const entry = (await treeOf(commit.oid, slash === -1 ? "" : path.slice(0, slash)))?.find((each) => each.name === path.slice(slash + 1));

		return entry === undefined || entry.type === "commit" ? undefined : { "commit": commit, "entry": entry };
	};

	const stat = async (resource: { "path": string }): Promise<IStat> => {
		const at = where(resource.path);

		if (at === undefined || (at.name === undefined && opened.size === 0)) {
			throw notFound();
		}

		if (at.name === undefined) {
			return { "type": FileType.Directory, "ctime": 0, "mtime": 0, "size": 0, "permissions": FilePermission.Readonly };
		}

		const found = await entryOf(at.name, at.path);

		if (found === undefined) {
			throw notFound();
		}

		const { commit, entry } = found;
		const size = entry.type === "blob" ? (await blobOf(entry.oid)).length : 0;

		return { "type": entry.type === "tree" ? FileType.Directory : FileType.File, "ctime": commit.time, "mtime": commit.time, "size": size, "permissions": FilePermission.Readonly };
	};

	const readdir = async (resource: { "path": string }): Promise<[string, FileType][]> => {
		// (the workspace's root lists `.refs/` once a commit's open: the overlay merges each provider's listing)
		if (resource.path === DIR) {
			if (opened.size === 0) {
				throw notFound();
			}

			return [[REFS_DIR, FileType.Directory]];
		}

		const at = where(resource.path);

		if (at === undefined) {
			throw notFound();
		}

		if (at.name === undefined) {
			return [...opened.keys()].map((name) => [name, FileType.Directory]);
		}

		const found = await entryOf(at.name, at.path);
		const tree = found?.entry.type === "tree" ? await treeOf(found.entry.oid, "") : undefined;

		if (tree === undefined) {
			throw notFound();
		}

		return tree.filter((entry) => entry.type !== "commit").map((entry) => [entry.name, entry.type === "tree" ? FileType.Directory : FileType.File]);
	};

	const readFile = async (resource: { "path": string }): Promise<Uint8Array> => {
		const at = where(resource.path);
		const found = at?.name === undefined ? undefined : await entryOf(at.name, at.path);

		if (found?.entry.type !== "blob") {
			throw notFound();
		}

		return blobOf(found.entry.oid);
	};

	const write = (path: string): never => {
		throw where(path) === undefined ? notOurs() : refused(path);
	};

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		// (not Readonly: the overlay skips a read-only provider's writes, and the workspace's would take them)
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": function() {
			// capabilities never change — nothing to dispose
		} })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": function() {
			// a commit never changes — nothing to watch
		} }),
		// (each call counted at the boundary, as the workspace's are: fs-boundaries.ts' `refs`)
		"stat": async (resource) => timeCall("refs", "stat", vscodeCaller(), resource.path, async () => stat(resource)),
		"readdir": async (resource) => timeCall("refs", "readdir", vscodeCaller(), resource.path, async () => readdir(resource)),
		"readFile": async (resource) => timeCall("refs", "readFile", vscodeCaller(), resource.path, async () => readFile(resource)),
		"writeFile": async (resource) => write(resource.path),
		"mkdir": async (resource) => write(resource.path),
		"delete": async (resource) => write(resource.path),
		"rename": async (from, to) => write(where(from.path) === undefined ? to.path : from.path)
	};

	// Above the workspace's (2): a write under `.refs/` is refused here before the workspace's provider could take it.
	registerFileSystemOverlay(3, provider);

	/** Open `ref` at `.refs/<name>/`, fetched one commit deep when the clone hasn't it. */
	const open = async (ref: string): Promise<{ "ref": string; "commit": string; "path": string }> => log.span("editor.workbench.git-refs.open", { "ref": ref }, async (span) => {
		let commit = await engine.commitOf(ref);

		if (commit === undefined && remote !== undefined && !/^[\da-f]{4,40}$/u.test(ref) && ref !== "HEAD") {
			const url = await engine.githubRemote();

			if (url !== undefined && await engine.fetchRef(remote, url, ref).catch(() => false)) {
				commit = await engine.commitOf(ref);
			}
		}

		if (commit === undefined) {
			throw new Error(`${ref} isn't a commit, branch or tag this clone has or could fetch`);
		}

		const name = ref.replaceAll("/", "~");
		const path = `${REFS_DIR}/${name}`;

		opened.set(name, commit);

		for (const listener of listeners) {
			listener([{ "resource": Uri.file(DIR), "type": FileChangeType.UPDATED }, { "resource": Uri.file(ROOT), "type": FileChangeType.ADDED }, { "resource": Uri.file(`${ROOT}/${name}`), "type": FileChangeType.ADDED }]);
		}

		span.end({ "commit": commit.oid });

		return { "ref": ref, "commit": commit.oid, "path": path };
	});

	vscode.commands.registerCommand("editor.git.openRef", async () => {
		const ref = await vscode.window.showInputBox({ "title": "Open a Commit Read-Only", "prompt": "A branch, tag or commit: it opens beside the work, in .refs/", "placeHolder": "full-editor" });

		if (ref === undefined || ref.trim() === "") {
			return;
		}

		try {
			const { path } = await open(ref.trim());

			await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(`${DIR}/${path}`));
		} catch (error) {
			void vscode.window.showWarningMessage("Open a Commit Read-Only: " + (error instanceof Error ? error.message : String(error)));
		}
	});

	serve(hub, "git.openRef", async (args) => {
		const { ref } = (args ?? {}) as { "ref"?: unknown };

		if (typeof ref !== "string" || ref.trim() === "") {
			throw new TypeError("git.openRef takes { ref }: a branch, tag or commit");
		}

		return open(ref.trim());
	});
}
