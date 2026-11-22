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
import type { Bablr } from "./bablr";
import * as engine from "./git-engine";
import { createChangeEvent, notFound } from "./provider-base";

const DIR = "/workspace";
const ROOT = `${DIR}/${REFS_DIR}`;

type Entry = NonNullable<Awaited<ReturnType<typeof engine.treeAt>>>[number];

interface Opened { "oid": string; "time": number; "stripped": boolean }

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

const DOCS = (name: string): boolean => /\.mdx?$/iu.test(name) || name === ".silo";

function refused(path: string): FileSystemProviderError {
	return FileSystemProviderError.create(`${path} is a commit's, read-only`, FileSystemProviderErrorCode.FileWriteLocked);
}

function notOurs(): FileSystemProviderError {
	return FileSystemProviderError.create("not a commit's", FileSystemProviderErrorCode.Unavailable);
}

export function installGitRefs(vscode: typeof vscodeApi, hub: Hub, log: Logger, bablr: Bablr, remote?: HttpClient): void {
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

	const entryOf = async (name: string, path: string): Promise<{ "commit": Opened; "entry": Pick<Entry, "type" | "oid"> } | undefined> => {
		const commit = opened.get(name);

		if (commit === undefined) {
			return undefined;
		}

		if (path === "") {
			return { "commit": commit, "entry": { "type": "tree", "oid": commit.oid } };
		}

		if (commit.stripped && path.split("/").some(DOCS)) {
			return undefined;
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

		const stripped = opened.get(at.name)?.stripped === true;

		return tree.filter((entry) => entry.type !== "commit" && !(stripped && DOCS(entry.name))).map((entry) => [entry.name, entry.type === "tree" ? FileType.Directory : FileType.File]);
	};

	const readFile = async (resource: { "path": string }): Promise<Uint8Array> => {
		const at = where(resource.path);
		const found = at?.name === undefined ? undefined : await entryOf(at.name, at.path);

		if (found?.entry.type !== "blob") {
			throw notFound();
		}

		const bytes = await blobOf(found.entry.oid);

		if (!found.commit.stripped || !CODE.test(resource.path)) {
			return bytes;
		}

		const stripped = await bablr.stripped(new TextDecoder().decode(bytes));

		return stripped === undefined ? bytes : new TextEncoder().encode(stripped);
	};

	const write = (path: string): never => {
		throw where(path) === undefined ? notOurs() : refused(path);
	};

	const provider: IFileSystemProviderWithFileReadWriteCapability = {
		"capabilities": FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive,
		"onDidChangeCapabilities": (() => ({ "dispose": function() {
		} })) as never,
		"onDidChangeFile": onDidChangeFile,
		"watch": () => ({ "dispose": function() {
		} }),
		"stat": async (resource) => timeCall("refs", "stat", vscodeCaller(), resource.path, async () => stat(resource)),
		"readdir": async (resource) => timeCall("refs", "readdir", vscodeCaller(), resource.path, async () => readdir(resource)),
		"readFile": async (resource) => timeCall("refs", "readFile", vscodeCaller(), resource.path, async () => readFile(resource)),
		"writeFile": async (resource) => write(resource.path),
		"mkdir": async (resource) => write(resource.path),
		"delete": async (resource) => write(resource.path),
		"rename": async (from, to) => write(where(from.path) === undefined ? to.path : from.path)
	};

	registerFileSystemOverlay(3, provider);

	const open = async (ref: string, stripped = false): Promise<{ "ref": string; "commit": string; "path": string }> => log.span("editor.workbench.git-refs.open", { "ref": ref, "stripped": stripped }, async (span) => {
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

		const name = ref.replaceAll("/", "~") + (stripped ? "~stripped" : "");
		const path = `${REFS_DIR}/${name}`;

		opened.set(name, { ...commit, "stripped": stripped });

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

		const how = await vscode.window.showQuickPick([{ "label": "As it is", "stripped": false }, { "label": "The code alone", "description": "comments stripped, no docs", "stripped": true }], { "title": "Open a Commit Read-Only" });

		if (how === undefined) {
			return;
		}

		try {
			const { path } = await open(ref.trim(), how.stripped);

			await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(`${DIR}/${path}`));
		} catch (error) {
			void vscode.window.showWarningMessage("Open a Commit Read-Only: " + (error instanceof Error ? error.message : String(error)));
		}
	});

	vscode.commands.registerCommand("editor.git.closeRefs", () => {
		if (opened.size === 0) {
			return;
		}

		const names = [...opened.keys()];

		opened.clear();
		trees.clear();
		blobs.clear();

		for (const listener of listeners) {
			listener([{ "resource": Uri.file(DIR), "type": FileChangeType.UPDATED }, ...names.map((name) => ({ "resource": Uri.file(`${ROOT}/${name}`), "type": FileChangeType.DELETED })), { "resource": Uri.file(ROOT), "type": FileChangeType.DELETED }]);
		}
	});

	serve(hub, "git.openRef", async (args) => {
		const { ref, stripped } = (args ?? {}) as { "ref"?: unknown; "stripped"?: unknown };

		if (typeof ref !== "string" || ref.trim() === "") {
			throw new TypeError("git.openRef takes { ref, stripped? }: a branch, tag or commit, and whether it's the code alone");
		}

		return open(ref.trim(), stripped === true);
	});
}
