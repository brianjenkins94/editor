/**
 * The terminal's `git`: the workspace's one git (isomorphic-git, git-engine.ts — the same that Source Control and the
 * review panel show), spoken as git is: status, diff, log, add, restore, commit and branch, printed as git prints them,
 * each a subcommand juvy routes and parses (command.ts — where what isn't here yet, switch, stash, push…, says what to do
 * instead). What changes the repository says so (`git.changed`), as git-service does, so Source Control and the review
 * panel refresh.
 *
 * `diff` compares the working tree with HEAD: without `--staged` the files with unstaged changes, with it the staged
 * ones. A file staged and then changed again shows all of its changes either way — the index's own version isn't read.
 */
import type { Juvy } from "@brianjenkins94/util/juvy";
import type { CommandHost, CommandResult, Handler } from "../../catalog";
import { createRpcClient } from "@brianjenkins94/hub";
import { version } from "isomorphic-git";
import * as engine from "../../../git-engine";
import { unifiedDiff } from "../../../git-service";

type Result = CommandResult;

const ROOT = "/workspace";
const ok = (stdout: string): Result => ({ "stdout": stdout, "stderr": "", "exitCode": 0 });
const fail = (stderr: string, exitCode = 1): Result => ({ "stdout": "", "stderr": stderr + "\n", "exitCode": exitCode });

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

	if (absolute === ROOT) {
		return "";
	}

	return absolute.startsWith(ROOT + "/") ? absolute.slice(ROOT.length + 1) : undefined;
}

/** Whether `file` is `path` or under it ("" is everything). */
const under = (file: string, path: string): boolean => path === "" || file === path || file.startsWith(path + "/");

const VERBS = { "A": "new file", "M": "modified", "D": "deleted" } as const;

async function status(config: Juvy): Promise<Result> {
	const { staged, unstaged } = await engine.status();
	const untracked = unstaged.filter((change) => change.status === "A" && !staged.some((each) => each.path === change.path));
	const changed = unstaged.filter((change) => !untracked.includes(change));

	if (config.get("short") === true) {
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

async function diff(config: Juvy, cwd: string): Promise<Result> {
	const wantStaged = config.get("staged") === true || config.get("cached") === true;
	const paths = (config.get("paths") as string[]).map((path) => inRepo(cwd, path) ?? "\u0000");
	const { staged, unstaged } = await engine.status();
	const changes = (wantStaged ? staged : unstaged.filter((change) => !(change.status === "A" && !staged.some((each) => each.path === change.path)))).filter((change) => paths.length === 0 || paths.some((path) => under(change.path, path)));
	let out = "";

	for (const change of changes.sort((left, right) => left.path.localeCompare(right.path))) {
		const patch = unifiedDiff(change.path, await engine.headContent(change.path), await engine.workingContent(change.path));

		out += patch === "" ? "" : `diff --git a/${change.path} b/${change.path}\n${patch}`;
	}

	return ok(out);
}

async function log(config: Juvy): Promise<Result> {
	const count = config.get("maxCount") as string;

	if (count !== "" && !/^\d+$/u.test(count)) {
		return fail(`fatal: '${count}': not an integer`, 128);
	}

	const entries = await engine.history(count === "" ? undefined : Number(count));

	if (entries.length === 0) {
		return fail("fatal: your current branch does not have any commits yet", 128);
	}

	if (config.get("oneline") === true) {
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

export function create({ hub }: CommandHost): Record<string, Handler> {
	const changed = (): void => {
		hub.publish("git.changed");
	};

	/** `git switch [-c] <name>`, `git checkout [-b] <name>`. */
	const switchTo = async (config: Juvy): Promise<Result> => {
		const name = config.get("name") as string;
		const create = config.get("create") === true;

		if (name === "") {
			return fail("fatal: missing branch name", 128);
		}

		if (!create && !(await engine.branches()).all.includes(name)) {
			return fail(`fatal: invalid reference: ${name} (git switch -c ${name} makes it; git restore <path> undoes a file's changes)`, 128);
		}

		await engine.switchBranch(name, create);
		changed();

		return { "stdout": "", "stderr": `Switched to ${create ? "a new " : ""}branch '${name}'\n`, "exitCode": 0 };
	};

	// Each handler's failure is git's: `fatal: …`, 128.
	const guarded = (handler: Handler): Handler => async (config, ctx) => {
		try {
			return await handler(config, ctx);
		} catch (error) {
			return fail(`fatal: ${error instanceof Error ? error.message : String(error)}`, 128);
		}
	};

	return Object.fromEntries(Object.entries({
		"version": () => Promise.resolve(ok(`git version isomorphic-git ${version()}\n`)),
		"status": async (config) => status(config),
		"diff": async (config, ctx) => diff(config, ctx.cwd),
		"log": async (config) => log(config),
		"add": async (config, ctx) => {
			const paths = config.get("all") === true ? ["/workspace"] : config.get("paths") as string[];

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
		},
		"restore": async (config, ctx) => {
			const staged = config.get("staged") === true;
			const paths = config.get("paths") as string[];

			if (paths.length === 0) {
				return fail("fatal: you must specify path(s) to restore");
			}

			const { "staged": stagedChanges, unstaged } = await engine.status();

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
		},
		"commit": async (config) => {
			const message = config.get("message") as string;

			if (config.get("amend") === true) {
				return fail("git: --amend isn't here yet");
			}

			if (message === "") {
				return fail("git: commit needs a message here (-m \"…\") — there's no editor to write one in");
			}

			if (config.get("all") === true) {
				const { unstaged, staged } = await engine.status();

				await engine.stagePaths(unstaged.filter((change) => !(change.status === "A" && !staged.some((each) => each.path === change.path))).map((change) => change.path));
			}

			const { staged } = await engine.status();

			if (staged.length === 0) {
				return fail("nothing added to commit (use \"git add\" to stage, or git commit -a)");
			}

			const { oid } = await engine.commitIndex(message);

			changed();

			return ok(`[${(await engine.branches()).current ?? "HEAD"} ${oid.slice(0, 7)}] ${message.split("\n")[0]}\n ${staged.length} file${staged.length === 1 ? "" : "s"} changed\n`);
		},
		"branch": async (config) => {
			const name = config.get("name") as string;

			if (name !== "") {
				await engine.createBranch(name);
				changed();

				return ok("");
			}

			const { current, all } = await engine.branches();

			return ok(all.map((each) => `${each === current ? "*" : " "} ${each}\n`).join(""));
		},
		"switch": async (config) => switchTo(config),
		"checkout": async (config) => switchTo(config),
		"push": async (config) => {
			if (config.get("remote") !== "origin") {
				return fail(`fatal: '${config.get("remote") as string}' does not appear to be a git repository — this workspace has origin, where it was loaded from`, 128);
			}

			const branch = config.get("branch") as string;
			// (the git service's push: it asks the shell, which has the sign-in, to send it)
			const pushed = await createRpcClient(hub).request("git.push", { ...branch === "" ? {} : { "ref": branch }, "force": config.get("force") === true }, { "timeoutMs": 300_000 }) as { "ref": string; "ok": boolean; "error"?: string; "url": string };

			return pushed.ok
				? { "stdout": "", "stderr": `To ${pushed.url}\n   ${pushed.ref} -> ${pushed.ref}\n`, "exitCode": 0 }
				: fail(`To ${pushed.url}\n ! [rejected]        ${pushed.ref} -> ${pushed.ref} (${pushed.error ?? "refused"})\nerror: failed to push some refs to '${pushed.url}'`);
		}
	} satisfies Record<string, Handler>).map(([name, handler]) => [name, guarded(handler)]));
}
