/**
 * Browser git ENGINE — isomorphic-git over the zen-fs workspace, with NO vscode dependency.
 *
 * This is the durable, reusable core: through git-service.ts it backs VS Code's Source Control view and the shell's review
 * panel today, and
 * a custom shell UI / the RHS revision history later, with the view swapped and the engine untouched. It's also the
 * COARSE (git) tier of the eventual two-tier history (Automerge = fine local edits, git = published commits).
 *
 * Local, but for two things: init / status / stage / commit / branches + HEAD blobs for diff, and a push and a
 * fast-forward. Their HTTP is the caller's (`push`'s and `pull`'s `http`): the workbench's goes through the shell,
 * which holds the sign-in (shell/git-push.ts).
 * Who a commit is by is the caller's too (`setAuthor`): the signed-in GitHub user, else a placeholder.
 */
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "node:buffer";
import { KEPT, localOf } from "@brianjenkins94/editor-api/git";
import { fs } from "@zenfs/core";
import { GITIGNORE, SILO_DIR, withLines } from "@brianjenkins94/util/silo/layout";
import type { HttpClient } from "isomorphic-git";
import { add, branch, checkout, commit, currentBranch, expandOid, getConfig, fetch as gitFetch, push as gitPush, hashBlob, init, isDescendent, listBranches, log, readBlob, remove, resetIndex, resolveRef, STAGE, statusMatrix, TREE, updateIndex, walk, writeBlob, writeRef } from "isomorphic-git";

// isomorphic-git reads the `Buffer` global (a Node-ism), which the browser lacks. The build injects unenv's where it's
// read (polyfillNode, build.ts pass 1, which also resolves `node:buffer` here to unenv's); the dev optimizer's copy of
// isomorphic-git gets no such injection, so set the global too. Set before any git op runs (module load precedes the
// git service's first op).
// eslint-disable-next-line ts/naming-convention -- the Buffer global isomorphic-git expects, node's name
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

/** The workspace is the repo root (zen-fs mounts the SingleBuffer here; see workspace-fs.ts). */
const DIR = "/workspace";
/** Who a commit is by when nothing says (signed out). */
const AUTHOR = { "name": "editor", "email": "editor@localhost" };

/** Who a commit is by: asked as each is made (setAuthor). */
let authorOf: () => Promise<{ "name": string; "email": string } | undefined> = () => Promise.resolve(undefined);

/** Where who a commit is by comes from (git-service.ts: the shell's signed-in GitHub user). */
export function setAuthor(source: typeof authorOf): void {
	authorOf = source;
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
 *  (ensureRepo; a clone load in workbench-entry.tsx). And the files the editor makes that the repository hasn't taken
 *  (`keepLocal`) go to their local copies. */
export async function includeSilo(): Promise<void> {
	const file = DIR + "/.git/info/exclude";

	if (fs.existsSync(file)) {
		const lines = (await fs.promises.readFile(file, "utf8")).split("\n");

		if (lines.includes(".silo/")) {
			await fs.promises.writeFile(file, lines.filter((line) => line !== ".silo/").join("\n"));
		}
	}

	await keepLocal();
}

/**
 * The files the editor makes for a project (editor-api's git.ts `KEPT`: versions, baseline, capabilities) are the
 * repository's at `.silo/` once it has committed them, and local until then (`keptAt`). One at `.silo/` that git has
 * neither in HEAD nor staged — an editor before 2026-10-30 wrote them there, and every commit took them — is moved to
 * its local copy, where git doesn't see it.
 */
async function keepLocal(): Promise<void> {
	// (what makes a local copy local: `.silo/.gitignore`'s `/local/`, there before anything is moved or written)
	if (fs.existsSync(`${DIR}/${SILO_DIR}`)) {
		const seed = `${DIR}/${SILO_DIR}/.gitignore`;
		const updated = withLines(fs.existsSync(seed) ? await fs.promises.readFile(seed, "utf8") : "", GITIGNORE);

		if (updated !== undefined) {
			await fs.promises.writeFile(seed, updated);
		}
	}

	for (const name of KEPT) {
		const shared = `${SILO_DIR}/${name}`;

		if (!fs.existsSync(`${DIR}/${shared}`)) {
			continue;
		}

		const [row] = await statusMatrix({ "fs": fs, "dir": DIR, "filepaths": [shared] }).catch(() => [[shared, 0, 2, 0] as const]);

		if (row !== undefined && row[1] === 0 && row[3] === 0) {
			const local = `${DIR}/${localOf(shared)}`;

			await fs.promises.mkdir(local.slice(0, local.lastIndexOf("/")), { "recursive": true });
			await fs.promises.writeFile(local, await fs.promises.readFile(`${DIR}/${shared}`));
			await fs.promises.unlink(`${DIR}/${shared}`);
		}
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
 * commit`): `.silo/`'s own `.gitignore` and `.gitattributes` go with it, so `/local/` — a run's traces and values,
 * this machine's alone (RUNTIME-EVIDENCE.md, *Kept across reloads*) — stays out of git wherever `.silo/` is committed.
 */
async function stageSiloSeeds(): Promise<void> {
	for (const seed of [`${SILO_DIR}/.gitignore`, `${SILO_DIR}/.gitattributes`]) {
		if (await readText(seed) !== undefined) {
			await add({ "fs": fs, "dir": DIR, "filepath": seed }).catch(() => undefined);
		}
	}
}

/** A commit made: its oid. */
export interface Committed { "oid": string }

/**
 * The workspace's filesystem keeps no executable bit — whatever writes a file there, it's 0644 — so a file can reach the
 * index as 100644 that HEAD has as 100755 (editor 2be5c8a pushed four scripts that way). Before a commit, a file HEAD has
 * as executable is given its bit back: a script stays one, edited or not. (A new file can't say it's one.)
 */
async function keepExecutables(): Promise<void> {
	if (await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" }).catch(() => undefined) === undefined) {
		return;
	}

	const lost: { "path": string; "oid": string }[] = [];

	await walk({
		"fs": fs,
		"dir": DIR,
		"trees": [TREE({ "ref": "HEAD" }), STAGE()],
		"map": async (path, [head, staged]) => {
			if (head !== null && staged !== null && await head.type() === "blob" && await head.mode() === 0o100755 && await staged.mode() !== 0o100755) {
				lost.push({ "path": path, "oid": await staged.oid() });
			}

			return true;
		}
	});

	for (const { path, oid } of lost) {
		await updateIndex({ "fs": fs, "dir": DIR, "filepath": path, "oid": oid, "mode": 0o100755, "add": true });
	}
}

/** The commit, `.silo/`'s seeds staged with it, and HEAD's executables kept so. */
async function committed(message: string): Promise<Committed> {
	await stageSiloSeeds();
	await keepExecutables();

	return { "oid": await commit({ "fs": fs, "dir": DIR, "message": message, "author": await authorOf().catch(() => undefined) ?? AUTHOR }) };
}

/** Commit what's staged, and only that (`git commit`): the new commit (`Committed`). */
export async function commitIndex(message: string): Promise<Committed> {
	return committed(message);
}

/** One commit, as `git log` shows it. */
export interface LogEntry { "oid": string; "message": string; "author": { "name": string; "email": string; "timestamp": number; "timezoneOffset": number } }

/** The commits from HEAD back, newest first; at most `depth`; only those that changed `path`, when it's given (its
 *  renames followed). None before the first commit. */
export async function history(depth?: number, path?: string): Promise<LogEntry[]> {
	try {
		return (await log({ "fs": fs, "dir": DIR, ...depth === undefined ? {} : { "depth": depth }, ...path === undefined ? {} : { "filepath": path, "follow": true } })).map(({ oid, "commit": entry }) => ({ "oid": oid, "message": entry.message, "author": entry.author }));
	} catch {
		return [];
	}
}

/** The branches, and which one HEAD is on. */
export async function branches(): Promise<{ "current": string | undefined; "all": string[] }> {
	return { "current": await currentBranch({ "fs": fs, "dir": DIR }) || undefined, "all": await listBranches({ "fs": fs, "dir": DIR }) };
}

/** Make a branch at HEAD (without switching to it, as `git branch <name>` does). */
export async function createBranch(name: string): Promise<void> {
	await branch({ "fs": fs, "dir": DIR, "ref": name });
}

/**
 * Switch to the branch `name` — made at HEAD first when `create` (`git switch -c`), which leaves the working tree as it
 * is. An existing one's files are checked out: isomorphic-git refuses when that would overwrite a change.
 */
export async function switchBranch(name: string, create = false): Promise<void> {
	if (create) {
		await branch({ "fs": fs, "dir": DIR, "ref": name, "checkout": true });
	} else {
		await checkout({ "fs": fs, "dir": DIR, "ref": name });
	}
}

/** The repository a remote names on github.com — `https://github.com/<owner>/<repo>.git` — whichever way it was cloned
 *  (straight, through a CORS proxy, or through the API's proxy: `…/github/git/<owner>/<repo>.git`); undefined for a
 *  remote anywhere else, or none. */
export async function githubRemote(remote = "origin"): Promise<string | undefined> {
	const url = await getConfig({ "fs": fs, "dir": DIR, "path": `remote.${remote}.url` }) as string | undefined;
	const repository = /(?:github\.com|\/github\/git)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(url ?? "")?.[1];

	return repository === undefined ? undefined : `https://github.com/${repository}.git`;
}

/** What a push did: the branch, and the remote's answer for it (`ok`, or its error). */
export interface Pushed { "ref": string; "ok": boolean; "error"?: string }

/** Push `ref` (the current branch, by default) to `url` as the same branch, over `http`. A rejected update (not a fast
 *  forward, a protected branch) is said, not thrown. */
export async function push(http: HttpClient, url: string, ref?: string, force = false): Promise<Pushed> {
	const branchName = ref ?? (await currentBranch({ "fs": fs, "dir": DIR }) || undefined);

	if (branchName === undefined) {
		throw new Error("HEAD is on no branch: name one to push");
	}

	// (no CORS proxy: a clone signed out names one in the repository's config, which a push would otherwise go through —
	// the caller's `http` is how it goes)
	const result = await gitPush({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": branchName, "remoteRef": branchName, "force": force });
	const answer = result.refs[`refs/heads/${branchName}`];

	return { "ref": branchName, "ok": result.ok && answer?.ok !== false, ...answer?.error === undefined ? {} : { "error": answer.error } };
}

/**
 * What bringing a branch up to the remote's did (`git pull --ff-only`): `up to date`, nothing new there; `ahead`, only
 * this workspace has commits the other hasn't (a push is a fast-forward); `fast-forwarded`, the branch moved `from` →
 * `to` and the `files` the remote changed written; or nothing done, `diverged` (each has commits the other hasn't:
 * a rebase or a merge, not this) or `conflicts` (the remote changed files this workspace has changes to).
 */
export interface Pulled {
	"ref": string;
	"outcome": "up to date" | "ahead" | "fast-forwarded" | "diverged" | "conflicts";
	"from"?: string;
	"to"?: string;
	"files"?: string[];
	"conflicts"?: string[];
}

/** Fetch `ref` (the current branch, by default) from `url` over `http`, and fast-forward to it if it can
 *  (`fastForward`). A shallow clone fetches what it lacks down to what it has. */
export async function pull(http: HttpClient, url: string, ref?: string): Promise<Pulled> {
	const branchName = ref ?? (await currentBranch({ "fs": fs, "dir": DIR }) || undefined);

	if (branchName === undefined) {
		throw new Error("HEAD is on no branch: name one to bring up to date");
	}

	const fetched = await gitFetch({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": branchName, "remoteRef": branchName, "singleBranch": true, "tags": false });

	if (fetched.fetchHead === null) {
		throw new Error(`the remote has no branch ${branchName}`);
	}

	return fastForward(branchName, fetched.fetchHead);
}

/**
 * Move `branchName` (HEAD's) to `to` when that's a fast-forward, keeping the working tree's changes: the files that
 * changed between the two are written and staged as `to` has them, then the branch moved. Refused — nothing touched —
 * when a file it would write has a change here (staged, unstaged or untracked), as `git merge --ff-only` refuses.
 */
export async function fastForward(branchName: string, to: string): Promise<Pulled> {
	const from = await resolveRef({ "fs": fs, "dir": DIR, "ref": `refs/heads/${branchName}` });
	const descends = async (oid: string, ancestor: string): Promise<boolean> => isDescendent({ "fs": fs, "dir": DIR, "oid": oid, "ancestor": ancestor, "depth": -1 }).catch(() => false);

	if (from === to) {
		return { "ref": branchName, "outcome": "up to date" };
	}

	if (await descends(from, to)) {
		return { "ref": branchName, "outcome": "ahead", "from": from, "to": to };
	}

	if (!await descends(to, from)) {
		return { "ref": branchName, "outcome": "diverged", "from": from, "to": to };
	}

	// (each file that differs between the two commits: what `to` has of it, or nothing — a subtree they share, skipped)
	const changed: { "path": string; "oid"?: string; "mode"?: number }[] = [];

	await walk({
		"fs": fs,
		"dir": DIR,
		"trees": [TREE({ "ref": from }), TREE({ "ref": to })],
		"map": async (path, [ours, theirs]) => {
			const [oursOid, theirsOid] = [await ours?.oid(), await theirs?.oid()];

			if (path === ".") {
				return true;
			}

			if (oursOid === theirsOid && await ours?.mode() === await theirs?.mode()) {
				return null;
			}

			if (await theirs?.type() === "blob") {
				changed.push({ "path": path, "oid": theirsOid, "mode": await theirs?.mode() });
			} else if (await ours?.type() === "blob") {
				changed.push({ "path": path });
			}

			return true;
		}
	});

	const { staged, unstaged } = await status();
	const here = new Set([...staged, ...unstaged].map((change) => change.path));
	const conflicts = changed.filter(({ path }) => here.has(path)).map(({ path }) => path);

	if (conflicts.length > 0) {
		return { "ref": branchName, "outcome": "conflicts", "from": from, "to": to, "conflicts": conflicts };
	}

	for (const { path, oid, mode } of changed) {
		const full = `${DIR}/${path}`;

		if (oid === undefined) {
			await fs.promises.unlink(full).catch(() => undefined);
			await remove({ "fs": fs, "dir": DIR, "filepath": path });
		} else {
			const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid });

			await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { "recursive": true });
			await fs.promises.writeFile(full, blob);
			await updateIndex({ "fs": fs, "dir": DIR, "filepath": path, "oid": oid, ...mode === undefined ? {} : { "mode": mode }, "add": true });
		}
	}

	await writeRef({ "fs": fs, "dir": DIR, "ref": `refs/heads/${branchName}`, "value": to, "force": true });

	return { "ref": branchName, "outcome": "fast-forwarded", "from": from, "to": to, "files": changed.map(({ path }) => path) };
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
	return await fileAt(path, "HEAD") ?? "";
}

/** `path`'s text at `ref` — a branch, HEAD, or a commit's oid, whole or its beginning — or undefined where `ref` isn't a
 *  commit here or hasn't the file. */
export async function fileAt(path: string, ref: string): Promise<string | undefined> {
	try {
		const oid = /^[\da-f]{4,40}$/u.test(ref) ? await expandOid({ "fs": fs, "dir": DIR, "oid": ref }).catch(async () => resolveRef({ "fs": fs, "dir": DIR, "ref": ref })) : await resolveRef({ "fs": fs, "dir": DIR, "ref": ref });
		const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return new TextDecoder().decode(blob);
	} catch {
		return undefined;
	}
}

/** Where a shallow clone's history ends: the commits whose parents it hasn't (`.git/shallow`). None in a whole one. */
export async function shallowEnds(): Promise<string[]> {
	try {
		return (await fs.promises.readFile(DIR + "/.git/shallow", "utf8")).split("\n").filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}
