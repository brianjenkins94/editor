/**
 * The terminal's `git`: the workspace's one git (isomorphic-git, git-engine.ts — the same that Source Control and the
 * review panel show), spoken as git is: status, diff, log, add, restore, commit and branch, printed as git prints them.
 * What changes the repository says so (`git.changed`), as git-service does, so Source Control and the review panel
 * refresh. What isn't here yet (switch, stash, push…) says so, and what to do instead.
 *
 * `diff` compares the working tree with HEAD: without `--staged` the files with unstaged changes, with it the staged
 * ones. A file staged and then changed again shows all of its changes either way — the index's own version isn't read.
 */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { version } from "isomorphic-git";
import { defineCommand } from "just-bash/browser";
import * as engine from "../../../git-engine";
import { unifiedDiff } from "../../../git-service";

type Result = { "stdout": string; "stderr": string; "exitCode": number };

const ROOT = "/workspace";
const ok = (stdout: string): Result => ({ "stdout": stdout, "stderr": "", "exitCode": 0 });
const fail = (stderr: string, exitCode = 1): Result => ({ "stdout": "", "stderr": stderr + "\n", "exitCode": exitCode });

/** What isn't here yet, and what to do instead. */
const NOT_HERE: Record<string, string> = {
	"switch": "switching branches isn't here yet — git branch lists them",
	"checkout": "switching branches isn't here yet — git restore <path> undoes a file's changes",
	"merge": "merging isn't here yet",
	"rebase": "rebasing isn't here yet",
	"stash": "stashing isn't here yet — commit, or restore what you don't want",
	"reset": "reset isn't here — git restore --staged <path> unstages, git restore <path> undoes",
	"push": "this workspace's git is local — the Commit button sends it to GitHub",
	"pull": "this workspace's git is local — load the repository again for what's new",
	"fetch": "this workspace's git is local — load the repository again for what's new",
	"clone": "load a repository from the Open button instead",
	"remote": "this workspace's git is local, with no remotes",
	"show": "show isn't here yet — git log lists the commits",
	"rm": "delete the file (rm <path>), then git add it",
	"mv": "move the file (mv <from> <to>), then git add both",
	"init": "this workspace is a repository already"
};

/** `path`, as typed in `cwd`, relative to the repository — or undefined outside it. */
function inRepo(cwd: string, path: string): string | undefined {
	const parts: string[] = [];

	for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "" && part !== ".") {
			parts.push(part);
		}
	}

	const absolute = "/" + parts.join("/");

	return absolute === ROOT ? "" : absolute.startsWith(ROOT + "/") ? absolute.slice(ROOT.length + 1) : undefined;
}

/** Whether `file` is `path` or under it ("" is everything). */
const under = (file: string, path: string): boolean => path === "" || file === path || file.startsWith(path + "/");

const VERBS = { "A": "new file", "M": "modified", "D": "deleted" } as const;

async function status(args: string[]): Promise<Result> {
	const { staged, unstaged } = await engine.status();
	const untracked = unstaged.filter((change) => change.status === "A" && !staged.some((each) => each.path === change.path));
	const changed = unstaged.filter((change) => !untracked.includes(change));

	if (args.includes("-s") || args.includes("--short")) {
		const paths = [...new Set([...staged, ...changed].map((change) => change.path))].sort();

		return ok([...paths.map((path) => `${staged.find((each) => each.path === path)?.status ?? " "}${changed.find((each) => each.path === path)?.status ?? " "} ${path}`), ...untracked.map((change) => `?? ${change.path}`)].map((line) => line + "\n").join(""));
	}

	const lines = [`On branch ${(await engine.branches()).current ?? "(no branch)"}`];

	if (staged.length > 0) {
		lines.push("Changes to be committed:", "  (use \"git restore --staged <file>...\" to unstage)", ...staged.map((change) => `\t${(VERBS[change.status] + ":").padEnd(12)}${change.path}`), "");
	}

	if (changed.length > 0) {
		lines.push("Changes not staged for commit:", "  (use \"git add <file>...\" to update what will be committed)", ...changed.map((change) => `\t${(VERBS[change.status] + ":").padEnd(12)}${change.path}`), "");
	}

	if (untracked.length > 0) {
		lines.push("Untracked files:", "  (use \"git add <file>...\" to include in what will be committed)", ...untracked.map((change) => `\t${change.path}`), "");
	}

	if (staged.length + changed.length + untracked.length === 0) {
		lines.push("nothing to commit, working tree clean");
	}

	return ok(lines.join("\n").replace(/\n?$/u, "\n"));
}

async function diff(args: string[], cwd: string): Promise<Result> {
	const wantStaged = args.includes("--staged") || args.includes("--cached");
	const paths = args.filter((argument) => !argument.startsWith("-")).map((path) => inRepo(cwd, path) ?? "\u0000");
	const { staged, unstaged } = await engine.status();
	const changes = (wantStaged ? staged : unstaged.filter((change) => !(change.status === "A" && !staged.some((each) => each.path === change.path)))).filter((change) => paths.length === 0 || paths.some((path) => under(change.path, path)));
	let out = "";

	for (const change of changes.sort((left, right) => left.path.localeCompare(right.path))) {
		const patch = unifiedDiff(change.path, await engine.headContent(change.path), await engine.workingContent(change.path));

		out += patch === "" ? "" : `diff --git a/${change.path} b/${change.path}\n${patch}`;
	}

	return ok(out);
}

async function log(args: string[]): Promise<Result> {
	const count = args.find((argument) => /^-\d+$/u.test(argument))?.slice(1) ?? args[args.indexOf("-n") + 1];
	const entries = await engine.history(args.includes("-n") || args.some((argument) => /^-\d+$/u.test(argument)) ? Number(count) : undefined);

	if (entries.length === 0) {
		return fail("fatal: your current branch does not have any commits yet", 128);
	}

	if (args.includes("--oneline")) {
		return ok(entries.map((entry) => `${entry.oid.slice(0, 7)} ${entry.message.split("\n")[0]}\n`).join(""));
	}

	return ok(entries.map((entry) => `commit ${entry.oid}\nAuthor: ${entry.author.name} <${entry.author.email}>\nDate:   ${new Date(entry.author.timestamp * 1000).toString()}\n\n${entry.message.trimEnd().split("\n").map((line) => "    " + line).join("\n")}\n`).join("\n"));
}

/** The changed files `paths` (as typed in `cwd`) name: a file, a folder's changed files, `.` — or an error. */
async function changedUnder(paths: string[], cwd: string): Promise<string[] | Result> {
	const { unstaged } = await engine.status();
	const files: string[] = [];

	for (const path of paths) {
		const relative = inRepo(cwd, path);

		if (relative === undefined) {
			return fail(`fatal: ${path}: '${path}' is outside repository at '${ROOT}'`, 128);
		}

		const matched = unstaged.filter((change) => under(change.path, relative)).map((change) => change.path);

		if (matched.length === 0 && !(await engine.workingContent(relative) !== "" || unstaged.some((change) => change.path === relative))) {
			return fail(`fatal: pathspec '${path}' did not match any files`, 128);
		}

		files.push(...matched);
	}

	return [...new Set(files)];
}

export function create({ hub }: CommandHost): Command {
	const changed = (): void => { hub.publish("git.changed"); };

	return defineCommand("git", async (args, ctx) => {
		const [subcommand, ...rest] = args;

		try {
			switch (subcommand) {
				case undefined:
					return fail("usage: git status | diff | log | add | restore | commit | branch (git --help for more)");
				case "--version":
				case "version":
					return ok(`git version isomorphic-git ${version()}\n`);
				case "status":
					return await status(rest);
				case "diff":
					return await diff(rest, ctx.cwd);
				case "log":
					return await log(rest);
				case "add": {
					const paths = rest.includes("-A") || rest.includes("--all") ? ["/workspace"] : rest.filter((argument) => !argument.startsWith("-"));

					if (paths.length === 0) {
						return fail("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?");
					}

					const files = await changedUnder(paths, ctx.cwd);

					if (!Array.isArray(files)) {
						return files;
					}

					await engine.stagePaths(files);
					changed();

					return ok("");
				}
				case "restore": {
					const staged = rest.includes("--staged") || rest.includes("-S");
					const paths = rest.filter((argument) => !argument.startsWith("-"));

					if (paths.length === 0) {
						return fail("fatal: you must specify path(s) to restore");
					}

					const { staged: stagedChanges, unstaged } = await engine.status();

					for (const path of paths) {
						const relative = inRepo(ctx.cwd, path) ?? "\u0000";
						const files = (staged ? stagedChanges : unstaged).filter((change) => under(change.path, relative) && (staged || !(change.status === "A" && !stagedChanges.some((each) => each.path === change.path))));

						if (files.length === 0) {
							return fail(`error: pathspec '${path}' did not match any file(s) known to git`);
						}

						for (const file of files) {
							await (staged ? engine.unstage(file.path) : engine.discardFile(file.path));
						}
					}

					changed();

					return ok("");
				}
				case "commit": {
					const messages = rest.flatMap((argument, index) => (rest[index - 1] === "-m" || rest[index - 1] === "--message" ? [argument] : []));

					if (rest.includes("--amend")) {
						return fail("git: --amend isn't here yet");
					}

					if (messages.length === 0) {
						return fail("git: commit needs a message here (-m \"…\") — there's no editor to write one in");
					}

					if (rest.includes("-a") || rest.includes("--all")) {
						const { unstaged, staged } = await engine.status();

						await engine.stagePaths(unstaged.filter((change) => !(change.status === "A" && !staged.some((each) => each.path === change.path))).map((change) => change.path));
					}

					const { staged } = await engine.status();

					if (staged.length === 0) {
						return fail("nothing added to commit (use \"git add\" to stage, or git commit -a)");
					}

					const oid = await engine.commitIndex(messages.join("\n\n"));

					changed();

					return ok(`[${(await engine.branches()).current ?? "HEAD"} ${oid.slice(0, 7)}] ${messages[0]!.split("\n")[0]}\n ${staged.length} file${staged.length === 1 ? "" : "s"} changed\n`);
				}
				case "branch": {
					const name = rest.find((argument) => !argument.startsWith("-"));

					if (name !== undefined) {
						await engine.createBranch(name);
						changed();

						return ok("");
					}

					const { current, all } = await engine.branches();

					return ok(all.map((each) => `${each === current ? "*" : " "} ${each}\n`).join(""));
				}
				default:
					return fail(subcommand in NOT_HERE ? `git ${subcommand}: ${NOT_HERE[subcommand]}` : `git: '${subcommand}' is not a git command here — status, diff, log, add, restore, commit and branch are`);
			}
		} catch (error) {
			return fail(`fatal: ${error instanceof Error ? error.message : String(error)}`, 128);
		}
	});
}
