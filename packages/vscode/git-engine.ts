/**
 * Browser git ENGINE — isomorphic-git over the zen-fs workspace, with NO vscode dependency.
 *
 * This is the durable, reusable core: the same engine backs the standard vscode SCM viewlet today (git-scm.ts) and
 * a custom shell UI / the RHS revision history later, with the view swapped and the engine untouched. It's also the
 * COARSE (git) tier of the eventual two-tier history (Automerge = fine local edits, git = published commits).
 *
 * Phase 1 is OFFLINE and LOCAL: init / status / stage / commit + HEAD blobs for diff — no network, no auth. Clone
 * (public repos) and push / commit-back (auth, Cloudflare) are later phases; they add functions here, not a rewrite.
 */
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "buffer";
import { fs } from "@zenfs/core";
import { add, commit, init, readBlob, remove, resetIndex, resolveRef, statusMatrix, updateIndex, writeBlob } from "isomorphic-git";

// isomorphic-git reads the `Buffer` global (a Node-ism); the browser has none and the workbench bundle doesn't
// polyfill node globals, so provide it. The `buffer` import resolves to the node-stdlib-browser polyfill via the
// build's resolve.alias (see build.ts pass 1). Set before any git op runs (module load precedes installGitScm).
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

/** The workspace is the repo root (zen-fs mounts the SingleBuffer here; see workspace-fs.ts). */
const DIR = "/workspace";
/** Placeholder identity for local commits (a real signed-in identity arrives with the auth milestone). */
const AUTHOR = { "name": "editor", "email": "editor@localhost" };

export interface GitChange { "path": string; "status": "A" | "M" | "D" }
export interface GitStatus { "staged": GitChange[]; "unstaged": GitChange[] }

/** Ensure /workspace is a git repo — `git init` on first run (idempotent), with a default `.gitignore` so the
 *  seeded dependency types under node_modules/ don't flood the status (statusMatrix honors .gitignore). */
export async function ensureRepo(): Promise<void> {
	if (!fs.existsSync(DIR + "/.git")) {
		await init({ "fs": fs, "dir": DIR, "defaultBranch": "main" });
	}

	if (!fs.existsSync(DIR + "/.gitignore")) {
		await fs.promises.writeFile(DIR + "/.gitignore", "node_modules/\n");
	}
}

/** A→added/untracked, D→deleted, M→modified, from a statusMatrix row's head+workdir columns. */
function letterFor(head: number, workdir: number): "A" | "M" | "D" {
	if (head === 0) {
		return "A";
	}

	return workdir === 0 ? "D" : "M";
}

/**
 * Working-tree status split into staged (index differs from HEAD) and unstaged (working tree differs from index).
 * A file can be in BOTH (staged, then edited again). statusMatrix rows are [path, head, workdir, stage] with 0/1/2/3
 * codes; `[1,1,1]` is unmodified and skipped.
 */
export async function status(): Promise<GitStatus> {
	const matrix = await statusMatrix({ "fs": fs, "dir": DIR });
	const staged: GitChange[] = [];
	const unstaged: GitChange[] = [];

	for (const [path, head, workdir, stage] of matrix) {
		if (head === 1 && workdir === 1 && stage === 1) {
			continue; // unmodified
		}

		if (workdir !== stage) {
			unstaged.push({ "path": path, "status": letterFor(head, workdir) });
		}

		if (stage !== head) {
			staged.push({ "path": path, "status": stage === 0 ? "D" : (head === 0 ? "A" : "M") });
		}
	}

	return { "staged": staged, "unstaged": unstaged };
}

/** Stage every working-tree change (adds + removals) — the commit-all path for phase 1. */
export async function stageAll(): Promise<void> {
	const { unstaged } = await status();

	for (const change of unstaged) {
		if (change.status === "D") {
			await remove({ "fs": fs, "dir": DIR, "filepath": change.path });
		} else {
			await add({ "fs": fs, "dir": DIR, "filepath": change.path });
		}
	}
}

/** Unstage one path (reset its index entry to HEAD). */
export async function unstage(path: string): Promise<void> {
	await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
}

/** Stage all changes, then commit. Returns the new commit oid. */
export async function commitAll(message: string): Promise<string> {
	await stageAll();

	return commit({ "fs": fs, "dir": DIR, "message": message, "author": AUTHOR });
}

/** One file's contribution to a selective commit. */
export interface CommitFile {
	"path": string;
	/** Exact blob text to commit (a PARTIAL selection: HEAD + only the chosen hunks). Omit to stage the working file. */
	"content"?: string;
	/** The file was deleted in the working tree and the deletion is selected. */
	"deleted"?: boolean;
}

/**
 * Commit exactly the given files (GitHub-Desktop-style selective commit), leaving the working tree untouched. The
 * index is first reset to HEAD for every currently-changed path so nothing outside `files` sneaks in; then each file
 * is staged — a `content` blob for a PARTIAL selection (written via writeBlob + updateIndex so the working tree keeps
 * the unselected changes), a removal for a deletion, or the working file otherwise — and the index is committed.
 */
export async function commitSelection(message: string, files: CommitFile[]): Promise<string> {
	const { staged, unstaged } = await status();

	for (const path of new Set([...staged, ...unstaged].map((change) => change.path))) {
		try {
			await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
		} catch { /* nothing to reset */ }
	}

	for (const file of files) {
		if (file.deleted === true) {
			await remove({ "fs": fs, "dir": DIR, "filepath": file.path });
		} else if (file.content !== undefined) {
			const oid = await writeBlob({ "fs": fs, "dir": DIR, "blob": new TextEncoder().encode(file.content) });

			await updateIndex({ "fs": fs, "dir": DIR, "filepath": file.path, "oid": oid });
		} else {
			await add({ "fs": fs, "dir": DIR, "filepath": file.path });
		}
	}

	return commit({ "fs": fs, "dir": DIR, "message": message, "author": AUTHOR });
}

/** True when `path` exists in HEAD (i.e. it's tracked, not a brand-new file). */
async function isTracked(path: string): Promise<boolean> {
	try {
		const oid = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });

		await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return true;
	} catch {
		return false;
	}
}

/** Discard ALL of a file's working-tree changes: restore a tracked file to its HEAD content, or delete an added one. */
export async function discardFile(path: string): Promise<void> {
	const full = DIR + "/" + path;

	if (await isTracked(path)) {
		await fs.promises.writeFile(full, await headContent(path));

		try {
			await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
		} catch { /* nothing staged */ }
	} else if (fs.existsSync(full)) {
		await fs.promises.unlink(full);
	}
}

/** Overwrite a file's working-tree content (a PARTIAL discard: working with the chosen hunks reverted to HEAD). */
export async function setWorking(path: string, content: string): Promise<void> {
	await fs.promises.writeFile(DIR + "/" + path, content);
}

/** The HEAD version of a file, for quick-diff gutters + the diff view. "" when the repo is unborn or the file is
 *  new (no HEAD blob), which is exactly what a diff against "nothing" wants. */
export async function headContent(path: string): Promise<string> {
	try {
		const oid = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });
		const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return new TextDecoder().decode(blob);
	} catch {
		return "";
	}
}
