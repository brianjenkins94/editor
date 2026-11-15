/**
 * silo's reading of git: the `git` on the PATH, or — where nothing can be spawned (the editor's debugger, whose
 * child_process says ENOSYS) — the repository's own .git through isomorphic-git, over `node:fs` (there, the workspace).
 * Reads only: what silo writes to git (a feature's restore) still asks the `git` on the PATH.
 */
import { execFileSync } from "node:child_process";
// eslint-disable-next-line ts/no-restricted-imports -- isomorphic-git takes Node's own fs (its promises and callbacks), which the util wrapper isn't
import * as nodeFs from "node:fs";
import * as path from "node:path";

/** Whether `error` is a spawn where none can be (not git's own failure, which is still thrown). */
const unspawnable = (error: unknown): boolean => (error as { "code"?: string } | undefined)?.code === "ENOSYS";

/** isomorphic-git, loaded only where it's needed. */
async function isomorphicGit(): Promise<typeof import("isomorphic-git")> {
	const loaded = await import("isomorphic-git");

	return (loaded as unknown as { "default"?: typeof loaded }).default ?? loaded;
}

/** `git <args>`'s output, or undefined where nothing can be spawned (or `SILO_GIT=isomorphic` says not to). */
function spawned(cwd: string, args: string[]): string | undefined {
	if (process.env["SILO_GIT"] === "isomorphic") {
		return undefined;
	}

	try {
		return execFileSync("git", args, { "cwd": cwd, "encoding": "utf8", "maxBuffer": 1 << 28 });
	} catch (error) {
		if (unspawnable(error)) {
			return undefined;
		}

		throw error;
	}
}

/** The repository a path is in: its top folder. */
export async function repoOf(directory: string): Promise<string> {
	const top = spawned(path.resolve(directory), ["rev-parse", "--show-toplevel"]);

	// (resolved, as git gives it: `/private/var/…` on a Mac for `/var/…`)
	return top?.trim() ?? nodeFs.realpathSync(await (await isomorphicGit()).findRoot({
		"fs": nodeFs,
		"filepath": path.resolve(directory)
	}));
}

/** `files` in byte order, as git sorts its index. */
function sorted(files: string[]): string[] {
	return files.sort((a, b) => (a < b
		? -1
		: a > b
			? 1
			: 0));
}

/**
 * The repository's files, by their paths from its top: what git tracks — and with `untracked`, what it doesn't but
 * doesn't ignore either (`git ls-files --cached --others --exclude-standard`). Sorted by path (git lists the untracked
 * apart), so the order doesn't depend on which git read them.
 */
export async function filesOf(repo: string, options: { "untracked"?: boolean } = {}): Promise<string[]> {
	const listed = spawned(repo, [
		"ls-files",
		...options.untracked === true
			? ["--cached", "--others", "--exclude-standard"]
			: []
	]);

	if (listed !== undefined) {
		return sorted(listed.split("\n").filter((file) => file !== ""));
	}

	const git = await isomorphicGit();
	const tracked = await git.listFiles({ "fs": nodeFs, "dir": repo });

	if (options.untracked !== true) {
		return tracked;
	}

	// (statusMatrix leaves out what .gitignore ignores; untracked is in neither HEAD nor the index)
	const known = new Set(tracked);
	const untracked = (await git.statusMatrix({ "fs": nodeFs, "dir": repo })).filter(([file, head, , stage]) => head === 0 && stage === 0 && !known.has(file)).map(([file]) => file);

	return sorted([
		...tracked,
		...untracked
	]);
}

/** HEAD's commit, abbreviated (`git rev-parse --short HEAD`). */
export async function headOf(repo: string): Promise<string> {
	const head = spawned(repo, ["rev-parse", "--short", "HEAD"]);

	return head?.trim() ?? (await (await isomorphicGit()).resolveRef({ "fs": nodeFs, "dir": repo, "ref": "HEAD" })).slice(0, 7);
}
