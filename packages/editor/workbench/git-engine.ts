/**
 * Browser git ENGINE — isomorphic-git over the zen-fs workspace, with NO vscode dependency.
 *
 * This is the durable, reusable core: through git-service.ts it backs VS Code's Source Control view and the shell's review
 * panel today, and
 * a custom shell UI / the RHS revision history later, with the view swapped and the engine untouched. It's also the
 * COARSE (git) tier of the eventual two-tier history (Automerge = fine local edits, git = published commits).
 *
 * Phase 1 is OFFLINE and LOCAL: init / status / stage / commit + HEAD blobs for diff — no network, no auth. Clone
 * (public repos) and push / commit-back (auth, Cloudflare) are later phases; they add functions here, not a rewrite.
 */
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "node:buffer";
import { fs } from "@zenfs/core";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { localTracesPath, SILO_DIR, tracesPath } from "@brianjenkins94/util/silo/layout";
import { committable, currentIn, parseTraces, tracesText } from "@brianjenkins94/util/silo/traces";
import { add, branch, commit, currentBranch, hashBlob, init, listBranches, log, readBlob, remove, resetIndex, resolveRef, STAGE, statusMatrix, updateIndex, walk, writeBlob } from "isomorphic-git";

// isomorphic-git reads the `Buffer` global (a Node-ism), which the browser lacks. The build injects unenv's where it's
// read (polyfillNode, build.ts pass 1, which also resolves `node:buffer` here to unenv's); the dev optimizer's copy of
// isomorphic-git gets no such injection, so set the global too. Set before any git op runs (module load precedes the
// git service's first op).
// eslint-disable-next-line ts/naming-convention -- the Buffer global isomorphic-git expects, node's name
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

/** The workspace is the repo root (zen-fs mounts the SingleBuffer here; see workspace-fs.ts). */
const DIR = "/workspace";
/** Placeholder identity for local commits (a real signed-in identity arrives with the auth milestone). */
const AUTHOR = { "name": "editor", "email": "editor@localhost" };

/** The files whose runs the Margin keeps (live runs' programs): the ones a commit shares runs of. */
const PROGRAM = /\.(?:m|c)?[jt]sx?$/u;
/** At most this many runs of a file shared. */
const SHARED_RUNS = 8;

/** A text's BABLR span ids (the editor's BABLR worker, given by `useSpans`): what a run is current for, beyond its very text. */
let spanIds: ((source: string) => Promise<Set<string>>) | undefined;

/** Where the git engine gets a text's span ids — the editor's BABLR (bablr.ts `spans`), once it's started. */
export function useSpans(spans: (source: string) => Promise<{ "id": string }[]>): void {
	spanIds = async (source) => new Set((await spans(source)).map((span) => span.id));
}

export interface GitChange { "path": string; "status": "A" | "M" | "D" }
export interface GitStatus { "staged": GitChange[]; "unstaged": GitChange[] }

/** The default `.gitignore` for a workspace that ships none — keeps the seeded dependency types under node_modules/
 *  out of git status (statusMatrix honors .gitignore). Materialized into zen-fs on a repo load too (see
 *  workbench-entry.tsx), since isomorphic-git reads it straight off the filesystem. */
export const DEFAULT_GITIGNORE = "node_modules/\n";

/** `.silo/` is in git (RUNTIME-EVIDENCE.md): silo's policy, the runs and their evidence travel with the repo, and
 *  `.silo/.gitignore` keeps out only what stays on the machine. The editor used to list `.silo/` in `.git/info/exclude`;
 *  take that line back out of a repo that still has it — idempotent, run on every repo the workspace becomes
 *  (ensureRepo; a clone load in workbench-entry.tsx). */
export async function includeSilo(): Promise<void> {
	const file = DIR + "/.git/info/exclude";

	if (!fs.existsSync(file)) {
		return;
	}

	const lines = (await fs.promises.readFile(file, "utf8")).split("\n");

	if (lines.includes(".silo/")) {
		await fs.promises.writeFile(file, lines.filter((line) => line !== ".silo/").join("\n"));
	}
}

/** Ensure /workspace is a git repo — `git init` on first run (idempotent), with a default `.gitignore` so the seeded
 *  dependency types under node_modules/ don't flood the status (statusMatrix honors .gitignore). */
export async function ensureRepo(): Promise<void> {
	if (!fs.existsSync(DIR + "/.git")) {
		await init({ "fs": fs, "dir": DIR, "defaultBranch": "main" });
	}

	if (!fs.existsSync(DIR + "/.gitignore")) {
		await fs.promises.writeFile(DIR + "/.gitignore", DEFAULT_GITIGNORE);
	}

	await includeSilo();
}

/** A→added/untracked, D→deleted, M→modified, from a statusMatrix row's head+workdir columns. */
function letterFor(head: number, workdir: number): "A" | "M" | "D" {
	if (head === 0) {
		return "A";
	}

	return workdir === 0 ? "D" : "M";
}

/** D→deleted, A→added, M→modified, from a statusMatrix row's head+stage columns (what's staged). */
function stagedLetterFor(head: number, stage: number): "A" | "M" | "D" {
	if (stage === 0) {
		return "D";
	}

	return head === 0 ? "A" : "M";
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
		// [1,1,1] is unmodified
		if (head !== 1 || workdir !== 1 || stage !== 1) {
			if (workdir !== stage) {
				unstaged.push({ "path": path, "status": letterFor(head, workdir) });
			}

			if (stage !== head) {
				staged.push({ "path": path, "status": stagedLetterFor(head, stage) });
			}
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

/** Stage these paths (repo-relative): a file that's gone is staged as removed, as `git add` does. */
export async function stagePaths(paths: string[]): Promise<void> {
	for (const path of paths) {
		if (fs.existsSync(DIR + "/" + path)) {
			await add({ "fs": fs, "dir": DIR, "filepath": path });
		} else {
			await remove({ "fs": fs, "dir": DIR, "filepath": path });
		}
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(`${DIR}/${path}`, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * The editor's pre-commit step (it makes every commit: the Source Control view's, Commit All, the terminal's `git
 * commit`): what `.silo/` shares of runs is worked out for what's being committed (RUNTIME-EVIDENCE.md, *Kept across reloads*). For
 * each program file staged, the runs kept on this machine of the very text staged (by its blob oid) — each as it may be
 * shared (lib traces' `committable`: never its text, a run that could have read inputs by its values' types) — go in
 * `.silo/traces/<you>/<file>.jsonl`, staged with it — those of the text staged, or whose every executed declaration is in
 * it unchanged (lib traces' `currentIn`, by the staged text's BABLR spans: a reformat or an edit to code a run didn't run
 * leaves it current); a file staged with no such runs, or deleted, takes its shared runs out. So what's committed is always the runs of the code beside it. A failure here shares nothing and doesn't stop
 * the commit, but isn't silent: it's what this returns (why), and the commit says so (`Committed`'s `unshared`).
 */
async function shareRuns(): Promise<string | undefined> {
	try {
		const programs = (await status()).staged.filter((change) => PROGRAM.test(change.path) && !change.path.startsWith(`${SILO_DIR}/`));

		if (programs.length === 0) {
			return undefined;
		}

		const wanted = new Set(programs.map((change) => change.path));
		const staged = new Map<string, string>();

		await walk({
			"fs": fs,
			"dir": DIR,
			"trees": [STAGE()],
			"map": async (path, [entry]) => {
				if (entry !== null && wanted.has(path) && await entry.type() === "blob") {
					staged.set(path, await entry.oid());
				}

				return undefined;
			}
		});

		const config = await readText(".git/config");
		const user = (config === undefined ? undefined : userSlug(config)) ?? "local";

		for (const path of wanted) {
			const oid = staged.get(path);
			const shared = tracesPath(user, path);
			const before = await readText(shared);
			// The staged text's span ids (none when there's no BABLR, or it can't parse it: then only runs of that very text).
			const ids = oid === undefined || spanIds === undefined ? undefined : await spanIds(new TextDecoder().decode((await readBlob({ "fs": fs, "dir": DIR, "oid": oid })).blob)).catch(() => undefined);
			// This machine's runs current for the text staged; else what's shared of it already (kept on another machine).
			const kept = oid === undefined ? [] : currentIn(parseTraces(await readText(localTracesPath(path)) ?? ""), oid, ids);
			const runs = kept.length > 0 ? kept.map(committable).slice(-SHARED_RUNS) : currentIn(parseTraces(before ?? ""), oid ?? "", ids);

			if (runs.length > 0) {
				await fs.promises.mkdir(`${DIR}/${shared.slice(0, shared.lastIndexOf("/"))}`, { "recursive": true });
				await fs.promises.writeFile(`${DIR}/${shared}`, tracesText(runs));
				await add({ "fs": fs, "dir": DIR, "filepath": shared });
			} else if (before !== undefined) {
				await fs.promises.unlink(`${DIR}/${shared}`);
				await remove({ "fs": fs, "dir": DIR, "filepath": shared });
			}
		}

		// (what keeps this machine's runs out of git, with them: `/local/`)
		for (const seed of [`${SILO_DIR}/.gitignore`, `${SILO_DIR}/.gitattributes`]) {
			if (await readText(seed) !== undefined) {
				await add({ "fs": fs, "dir": DIR, "filepath": seed });
			}
		}
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	return undefined;
}

/** A commit made: its oid — and, when its runs couldn't be shared with it (`shareRuns`), why: said where it was made. */
export interface Committed { "oid": string; "unshared"?: string }

/** The commit, once `.silo/`'s share of it is staged (`shareRuns`), whether or not that could be. */
async function committed(message: string): Promise<Committed> {
	const unshared = await shareRuns();
	const oid = await commit({ "fs": fs, "dir": DIR, "message": message, "author": AUTHOR });

	return { "oid": oid, ...unshared === undefined ? {} : { "unshared": unshared } };
}

/** Commit what's staged, and only that (`git commit`): the new commit (`Committed`). */
export async function commitIndex(message: string): Promise<Committed> {
	return committed(message);
}

/** One commit, as `git log` shows it. */
export interface LogEntry { "oid": string; "message": string; "author": { "name": string; "email": string; "timestamp": number; "timezoneOffset": number } }

/** The commits from HEAD back, newest first; at most `depth`. None before the first commit. */
export async function history(depth?: number): Promise<LogEntry[]> {
	try {
		return (await log({ "fs": fs, "dir": DIR, ...depth === undefined ? {} : { "depth": depth } })).map(({ oid, "commit": entry }) => ({ "oid": oid, "message": entry.message, "author": entry.author }));
	} catch {
		return [];
	}
}

/** The branches, and which one HEAD is on. */
export async function branches(): Promise<{ "current": string | undefined; "all": string[] }> {
	return { "current": await currentBranch({ "fs": fs, "dir": DIR }) ?? undefined, "all": await listBranches({ "fs": fs, "dir": DIR }) };
}

/** Make a branch at HEAD (without switching to it, as `git branch <name>` does). */
export async function createBranch(name: string): Promise<void> {
	await branch({ "fs": fs, "dir": DIR, "ref": name });
}

/** Stage all changes, then commit: the new commit (`Committed`). */
export async function commitAll(message: string): Promise<Committed> {
	await stageAll();

	return committed(message);
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
export async function commitSelection(message: string, files: CommitFile[]): Promise<Committed> {
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

	return committed(message);
}

/** The commit HEAD points at, or undefined before the first commit (or with no repository). */
export async function headCommit(): Promise<string | undefined> {
	try {
		return await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });
	} catch {
		return undefined;
	}
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

/** A file's text in the working tree; "" when it's gone. */
export async function workingContent(path: string): Promise<string> {
	return fs.existsSync(DIR + "/" + path) ? fs.promises.readFile(DIR + "/" + path, "utf8") : "";
}

/** The HEAD version of a file, for quick-diff gutters + the diff view. "" when the repo is unborn or the file is
 *  new (no HEAD blob), which is exactly what a diff against "nothing" wants. */
/** The text of the blob `oid` from git's objects — a span annotation's baseline, say — or undefined when this repo
 *  doesn't have it (it was never committed here). */
export async function blobText(oid: string): Promise<string | undefined> {
	try {
		return new TextDecoder().decode((await readBlob({ "fs": fs, "dir": DIR, "oid": oid })).blob);
	} catch {
		return undefined;
	}
}

export async function headContent(path: string): Promise<string> {
	try {
		const oid = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });
		const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return new TextDecoder().decode(blob);
	} catch {
		return "";
	}
}
