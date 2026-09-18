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
import { add, commit, hashBlob, init, readBlob, remove, resetIndex, resolveRef, statusMatrix, updateIndex, writeBlob } from "isomorphic-git";

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

/** Ensure /workspace is a git repo — `git init` on first run (idempotent), with a default `.gitignore` so the seeded
 *  dependency types under node_modules/ don't flood the status (statusMatrix honors .gitignore). The `.bablr`/`.silo`
 *  sidecars need no ignore: the derivable caches live inside `.git/`, and `.silo/` is meant to be committed. */
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

			// `add: true` so a new (or index-reset) path gets an entry created; `mode` is required for a fresh entry.
			await updateIndex({ "fs": fs, "dir": DIR, "filepath": file.path, "oid": oid, "add": true, "mode": 0o100644 });
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

/** The git blob oid (content hash) of some working text — a collision-free, content-addressed cache key part. */
export async function blobOid(content: string): Promise<string> {
	return (await hashBlob({ "object": new TextEncoder().encode(content) })).oid;
}

/**
 * The `.silo/` store — the COMMITTED, durable half of the identity spine (the re-derivable half being the `.ts.bablr`
 * sidecars). It lives IN the working tree (unlike the `.git/` caches), so it travels with the repo: clone it and the
 * annotations + run log come along, and every change is reviewable in a diff. It holds only data pinned to derivable
 * NODE IDS or appended as events — never the CST, which the `.ts.bablr` index reconstructs.
 */
const SILO = DIR + "/.silo";
/** Legacy annotation location (pre-`.silo/`): read as a fallback so existing local notes migrate on first write. */
const LEGACY_ANNOTATIONS = DIR + "/.git/bablr-annotations";

/**
 * The annotation store — user data (review notes, dispositions, resolved state) PINNED TO NODE IDS. Because node ids
 * are derivable from git history + the `.ts.bablr` index, this small map is all that has to be shared for an
 * annotation to follow a line as it moves; the CST itself never travels. Per file under `.silo/annotations/`, so it's
 * committed with the repo (falls back to the legacy `.git/` location when a file hasn't migrated yet).
 */
export async function readAnnotations(path: string): Promise<Record<string, unknown>> {
	const name = "/" + encodeURIComponent(path) + ".json";

	for (const file of [SILO + "/annotations" + name, LEGACY_ANNOTATIONS + name]) {
		try {
			return JSON.parse(new TextDecoder().decode(await fs.promises.readFile(file))) as Record<string, unknown>;
		} catch {
			continue; // not here — try the next location
		}
	}

	return {}; // none yet
}

/** Pin (or, with a null value, clear) one annotation on a node id for a file — writing to the committed `.silo/`. */
export async function setAnnotation(path: string, nodeId: string, value: unknown): Promise<void> {
	const dir = SILO + "/annotations";
	const current = await readAnnotations(path);

	if (value === null || value === undefined) {
		delete current[nodeId];
	} else {
		current[nodeId] = value;
	}

	await fs.promises.mkdir(dir, { "recursive": true });
	await fs.promises.writeFile(dir + "/" + encodeURIComponent(path) + ".json", JSON.stringify(current));
}

/**
 * The review-NOTE store — comment annotations pinned to CONTENT-ADDRESSED span-anchor ids (bablr spanAnchors), NOT to
 * file paths. Each note is one file named by its span id under `.silo/notes/`, so a note is never tied to a path: rename
 * a file, or move the span to another file, and the note is still found the moment any open file contains that span —
 * no path-migration. Committed, so notes travel with the repo; per-span files, so distinct notes don't merge-conflict.
 */
const NOTES = SILO + "/notes";
const noteFile = (spanId: string): string => NOTES + "/" + encodeURIComponent(spanId) + ".json";

/** Read the note stored on a span id, or undefined if none. */
export async function readNote(spanId: string): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await fs.promises.readFile(noteFile(spanId))));
	} catch {
		return undefined; // none
	}
}

/** Pin (or, with a null value, clear) the note on a span id. */
export async function setNote(spanId: string, value: unknown): Promise<void> {
	if (value === null || value === undefined) {
		try {
			await fs.promises.unlink(noteFile(spanId));
		} catch { /* already absent */ }

		return;
	}

	await fs.promises.mkdir(NOTES, { "recursive": true });
	await fs.promises.writeFile(noteFile(spanId), JSON.stringify(value));
}

/** Every span id that currently carries a note (the `.silo/notes/` filenames, decoded) — an open file intersects this
 *  with its own span anchors to know which of its spans to show threads on. */
export async function annotatedSpanIds(): Promise<string[]> {
	try {
		return (await fs.promises.readdir(NOTES)).filter((name) => name.endsWith(".json")).map((name) => decodeURIComponent(name.slice(0, -".json".length)));
	} catch {
		return []; // no notes yet
	}
}

/**
 * Append one play-session record to `.silo/runs.jsonl` (committed, append-only). Each line is a self-contained JSON
 * event — one recorded run of the game (inputs / outcome / the system node ids it exercised) — so runs are shareable
 * and replayable, and become the basis for regression checks against the systems they pin to. Newline-delimited so a
 * run is one atomic append and the log stays diff-friendly.
 */
export async function appendRun(record: unknown): Promise<void> {
	await fs.promises.mkdir(SILO, { "recursive": true });
	await fs.promises.appendFile(SILO + "/runs.jsonl", JSON.stringify(record) + "\n");
}

/** Read the play-session log back as parsed records (skips blank/corrupt lines rather than throwing). */
export async function readRuns(): Promise<unknown[]> {
	let text: string;

	try {
		text = new TextDecoder().decode(await fs.promises.readFile(SILO + "/runs.jsonl"));
	} catch {
		return []; // no runs yet
	}

	const runs: unknown[] = [];

	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}

		try {
			runs.push(JSON.parse(line));
		} catch {
			continue; // a partial/corrupt line — skip it, keep the rest
		}
	}

	return runs;
}

/**
 * The `.ts.bablr` CACHE — a derivable, CONTENT-ADDRESSED sidecar under `.git/bablr/<blobOid>.json` (git's own model).
 * Keyed by the content's blob oid, not its path, so a file moving/renaming is a non-problem (same content → same
 * entry), identical content dedups, and an edit naturally mints a new entry (the old one stale/GC-able). Inside `.git/`
 * → never in the working tree, no .gitignore needed. A miss just re-derives — it's a pure parse cache.
 */
const BABLR_CACHE = DIR + "/.git/bablr";
const cacheFile = (blob: string): string => BABLR_CACHE + "/" + blob + ".json";

/** Read a cached `.ts.bablr` payload (e.g. the span anchors) for some content by its blob oid, or null on a miss. */
export async function readBablr(blob: string): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await fs.promises.readFile(cacheFile(blob))));
	} catch {
		return null; // not cached
	}
}

/** Write a content's `.ts.bablr` cache payload, keyed by its blob oid. */
export async function writeBablr(blob: string, payload: unknown): Promise<void> {
	await fs.promises.mkdir(BABLR_CACHE, { "recursive": true });
	await fs.promises.writeFile(cacheFile(blob), JSON.stringify(payload));
}

/**
 * The game-maker's per-file identity snapshot (its reidentify baseline for the event-sheet projection). Under `.git/`
 * like the other derivable sidecars — off the working tree, so no `.gitignore` needed and never accidentally committed
 * (this replaces the old working-tree `<file>.ts.bablr` sidecars). Path-keyed: it's the baseline for a specific file.
 */
const GAME_SIDECARS = DIR + "/.git/bablr-game";

/** Read a game file's prior identity snapshot, or undefined if none. */
export async function readGameSidecar(path: string): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await fs.promises.readFile(GAME_SIDECARS + "/" + encodeURIComponent(path) + ".json")));
	} catch {
		return undefined; // none yet
	}
}

/** Persist a game file's new identity snapshot. */
export async function writeGameSidecar(path: string, snapshot: unknown): Promise<void> {
	await fs.promises.mkdir(GAME_SIDECARS, { "recursive": true });
	await fs.promises.writeFile(GAME_SIDECARS + "/" + encodeURIComponent(path) + ".json", JSON.stringify(snapshot));
}

/**
 * Persist a file's Automerge edit-history doc (the fine-grained local tier) under `.git/bablr-automerge/`, as the raw
 * `Automerge.save` binary. Same rationale as the `.bablr` sidecar: inside `.git`, off the working tree, local + per
 * session (zen-fs). The synced/shared version is the Keyhive milestone.
 */
export async function writeAutomerge(path: string, bytes: Uint8Array): Promise<void> {
	const dir = DIR + "/.git/bablr-automerge";

	await fs.promises.mkdir(dir, { "recursive": true });
	await fs.promises.writeFile(dir + "/" + encodeURIComponent(path) + ".bin", bytes);
}

/** Read back a file's Automerge edit-history doc, or null if none has been recorded yet. */
export async function readAutomerge(path: string): Promise<Uint8Array | null> {
	try {
		const data = await fs.promises.readFile(DIR + "/.git/bablr-automerge/" + encodeURIComponent(path) + ".bin");

		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	} catch {
		return null; // none yet
	}
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
