/**
 * silo's reading of git: the `git` on the PATH, or — where nothing can be spawned (the editor's debugger, whose
 * child_process says ENOSYS) — the repository's own .git through isomorphic-git, over `node:fs` (there, the workspace).
 * Reads only: what silo writes to git (a feature's restore) still asks the `git` on the PATH.
 */
import type { Ignore } from "ignore";

import { execFileSync } from "node:child_process";
// eslint-disable-next-line ts/no-restricted-imports -- isomorphic-git takes Node's own fs (its promises and callbacks), which the util wrapper isn't
import * as nodeFs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

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

	const tracked = await (await isomorphicGit()).listFiles({ "fs": nodeFs, "dir": repo });

	if (options.untracked !== true) {
		return tracked;
	}

	return sorted([
		...tracked,
		...untrackedOf(repo, new Set(tracked))
	]);
}

/** A folder's ignore rules (its .gitignore, or the repository's own excludes), with the folder they're relative to. */
interface Rules { "base": string; "rules": Ignore }

/** Whether `file` (a folder: ending in `/`) is ignored by `stack`, from the top down: the deeper folder's word last. */
function ignoredBy(stack: Rules[], file: string): boolean {
	let ignored = false;

	for (const { base, rules } of stack) {
		const tested = rules.test(base === "" ? file : file.slice(base.length + 1));

		ignored = ignored ? !tested.unignored : tested.ignored;
	}

	return ignored;
}

/**
 * What git doesn't track and doesn't ignore either (`git ls-files --others --exclude-standard`, but for the user's own
 * excludes file): the working tree walked once — a read of each folder, and of each .gitignore there is — not into an
 * ignored folder, nor .git. Not isomorphic-git's walk and isIgnored, which read the excludes and every parent's
 * .gitignore again for each file (52,000 failed reads of this repository's): each a round trip in the editor's debugger.
 * Only reads, as `git ls-files` does (statusMatrix writes the index's refreshed stats back).
 */
function untrackedOf(repo: string, tracked: Set<string>): string[] {
	const read = (file: string): string | undefined => (nodeFs.existsSync(path.join(repo, file)) ? nodeFs.readFileSync(path.join(repo, file), "utf8") : undefined);
	const untracked: string[] = [];
	const visit = (folder: string, above: Rules[]): void => {
		const entries = nodeFs.readdirSync(path.join(repo, folder), { "withFileTypes": true });
		// (the top's is among the rules it starts with)
		const own = folder !== "" && entries.some((entry) => entry.name === ".gitignore" && !entry.isDirectory());
		const stack = own ? [...above, { "base": folder, "rules": ignore().add(nodeFs.readFileSync(path.join(repo, folder, ".gitignore"), "utf8")) }] : above;

		for (const entry of entries.filter((each) => each.name !== ".git")) {
			const file = folder === "" ? entry.name : folder + "/" + entry.name;

			if (entry.isDirectory()) {
				if (!ignoredBy(stack, file + "/")) {
					visit(file, stack);
				}
			} else if (!tracked.has(file) && !ignoredBy(stack, file)) {
				untracked.push(file);
			}
		}
	};

	// (the top's rules: .git/info/exclude, then its .gitignore — both relative to the top)
	visit("", [{ "base": "", "rules": ignore().add(read(".git/info/exclude") ?? "").add(read(".gitignore") ?? "") }]);

	return untracked;
}

/** HEAD's commit, abbreviated (`git rev-parse --short HEAD`). */
export async function headOf(repo: string): Promise<string> {
	const head = spawned(repo, ["rev-parse", "--short", "HEAD"]);

	return head?.trim() ?? (await (await isomorphicGit()).resolveRef({ "fs": nodeFs, "dir": repo, "ref": "HEAD" })).slice(0, 7);
}
