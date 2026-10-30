/**
 * Git service — exposes `git-engine` over the hub: the one git the editor has, read by the
 * shell's GitHub-Desktop-style review panel and by VS Code's Source Control view (the source-control extension). The
 * engine is vscode-free, so each face reads it over the hub without knowing about the other. Runs in the workbench
 * realm (where zen-fs lives); the shell reaches it shell → app → workbench, the Source Control view bridge → workbench.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { DiffRowInfo } from "../shared/git-hunks";
import type { RemoteResponse } from "../shared/git-remote";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import { alignedRows, blameOf, committedContent, hunksOf, rowsOfHunks } from "../shared/git-hunks";
import { remoteHttp } from "../shared/git-remote";
import * as engine from "./git-engine";

const DIR = "/workspace";

/** Past this many changed lines a diff says so rather than listing them (a rewrite, a generated file). */
const MOST_EDITS = 5000;

/** The characters `git.show` gives of a file, at most; and the commits `git.blame` reads back through. */
const MOST_SHOWN = 200_000;
const BLAME_COMMITS = 200;

/** `before` → `after` as a unified diff of `path`, as `git diff` writes one — jsdiff's (`diff`), three lines of context. */
export function unifiedDiff(path: string, before: string, after: string): string {
	if (before === after) {
		return "";
	}

	const [from, to] = [before === "" ? "/dev/null" : `a/${path}`, after === "" ? "/dev/null" : `b/${path}`];
	const patch = structuredPatch(from, to, before, after, undefined, undefined, { "context": 3, "maxEditLength": MOST_EDITS });

	return patch === undefined ? `--- ${from}\n+++ ${to}\n(more than ${MOST_EDITS} lines differ)\n` : formatPatch(patch, FILE_HEADERS_ONLY);
}

/** A file in a commit: its whole change, only the hunks given, or all but the changed rows given (the panel's line picks). */
interface CommitPick { "path": string; "hunks"?: string[]; "except"?: number[] }

/** The changed rows of `rows` that aren't in `picked`. */
const unpicked = (rows: DiffRowInfo[], picked: ReadonlySet<number>): Set<number> => new Set(rows.flatMap((row, index) => (row.type !== "ctx" && !picked.has(index) ? [index] : [])));

/** Serve `git.status` / `git.file` / `git.diff` / `git.commit` and publish `git.changed` on the given hub — and the same as
 *  commands for extensions (ARCHITECTURE.md, *Extension points* 5): `editor.git.status`, `editor.git.file(path)`, `editor.git.commit(message)`.
 *  (An extension learns of a change as VS Code's own git does: a save, or a file watcher — the repository is files too.) */
/** What the service reads the working tree with, for whoever joins more to it (git-review.ts). */
export interface GitReader {
	"status": () => Promise<{ "files": GitFileChange[]; "head"?: string }>;
	"file": (path: unknown) => Promise<{ "head": string; "working": string }>;
}

export function installGitService(vscode: typeof vscodeApi, hub: Hub, log: Logger): GitReader {
	const readWorking = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	const status = async (): Promise<{ "files": GitFileChange[]; "head"?: string }> => {
		const current = await engine.status();
		const byPath = new Map<string, GitFileChange>();

		const record = (change: engine.GitChange, kind: "staged" | "unstaged"): void => {
			let entry = byPath.get(change.path);

			if (entry === undefined) {
				entry = { "path": change.path, "status": change.status, "staged": false, "unstaged": false };
				byPath.set(change.path, entry);
			}

			entry[kind] = true;
			entry.status = change.status;
		};

		for (const change of current.staged) {
			record(change, "staged");
		}

		for (const change of current.unstaged) {
			record(change, "unstaged");
		}

		const head = await engine.headCommit();

		return { "files": [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)), ...head === undefined ? {} : { "head": head } };
	};

	serve(hub, "git.status", status);
	vscode.commands.registerCommand("editor.git.status", status);

	// What changed, as `git diff HEAD` says it: one file's (`path`), or every changed file's — a unified diff of the
	// working tree against the last commit (debug-mcp's git tool).
	serve(hub, "git.diff", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;
		const current = typeof path === "string" && path !== "" ? undefined : await engine.status();
		const paths = current === undefined ? [path] : [...current.unstaged, ...current.staged].map((change) => change.path);
		const diffs = await Promise.all([...new Set(paths)].sort().map(async (each) => unifiedDiff(each, await engine.headContent(each).catch(() => ""), await readWorking(each).catch(() => ""))));

		return { "diff": diffs.join("") };
	});
	const file = async (path: unknown): Promise<{ "head": string; "working": string }> => {
		if (typeof path !== "string") {
			return { "head": "", "working": "" };
		}

		let working = "";

		try {
			working = await readWorking(path);
		} catch { /* deleted in the working tree */ }

		// The two texts only: what BABLR says of the change is the classifier's (annotations.classify), asked by whoever shows it.
		return { "head": await engine.headContent(path), "working": working };
	};

	serve(hub, "git.file", async (args) => file((args as { "path"?: string } | null)?.path));

	// History, as `git log`, `git show <rev>:<path>` and `git blame` say it — what a shallow clone holds of it, and where
	// that ends, said (agents' git_log, git_show, git_blame).
	const shortOf = (oid: string): string => oid.slice(0, 8);
	const summary = (entry: engine.LogEntry): { "oid": string; "short": string; "message": string; "author": string; "date": string } => ({ "oid": entry.oid, "short": shortOf(entry.oid), "message": entry.message.split("\n")[0], "author": entry.author.name, "date": new Date(entry.author.timestamp * 1000).toISOString() });
	const ends = async (commits: engine.LogEntry[]): Promise<{ "shallow"?: string }> => {
		const shallow = await engine.shallowEnds();
		const last = commits.at(-1);

		return last !== undefined && shallow.includes(last.oid) ? { "shallow": `this clone's history ends at ${shortOf(last.oid)}: older commits aren't here` } : {};
	};

	serve(hub, "git.log", async (args) => {
		const { path, limit } = (args ?? {}) as { "path"?: unknown; "limit"?: unknown };
		const most = typeof limit === "number" && limit > 0 ? Math.min(limit, 500) : 20;
		const commits = await engine.history(most, typeof path === "string" && path !== "" ? path : undefined);

		return { "commits": commits.map(summary), ...await ends(commits) };
	});

	serve(hub, "git.show", async (args) => {
		const { path, rev } = (args ?? {}) as { "path"?: unknown; "rev"?: unknown };

		if (typeof path !== "string" || path === "" || typeof rev !== "string" || rev === "") {
			throw new TypeError("git.show takes { path, rev }: a file, and a commit (its oid, or its beginning), a branch or HEAD");
		}

		const text = await engine.fileAt(path, rev);

		if (text === undefined) {
			throw new Error(`${rev} has no ${path} here (or isn't a commit this clone has)`);
		}

		return { "path": path, "rev": rev, "lines": text.split("\n").length, "content": text.length > MOST_SHOWN ? text.slice(0, MOST_SHOWN) : text, ...text.length > MOST_SHOWN ? { "truncated": true } : {} };
	});

	serve(hub, "git.blame", async (args) => {
		const { path, from, to } = (args ?? {}) as { "path"?: unknown; "from"?: unknown; "to"?: unknown };

		if (typeof path !== "string" || path === "") {
			throw new TypeError("git.blame takes { path, from?, to? }: a file, and the lines (1-based) to say");
		}

		const commits = await engine.history(BLAME_COMMITS, path);
		const versions: { "oid": string; "text": string }[] = [{ "oid": "working", "text": await readWorking(path).catch(() => "") }];

		// (each commit's version of it, back until one hasn't it here: renamed before then, or past the clone's start)
		for (const commit of commits) {
			const text = await engine.fileAt(path, commit.oid);

			if (text === undefined) {
				break;
			}

			versions.push({ "oid": commit.oid, "text": text });
		}

		const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
		const first = typeof from === "number" && from > 0 ? from : 1;
		const last = typeof to === "number" && to >= first ? to : Number.POSITIVE_INFINITY;
		const runs: { "from": number; "to": number; "commit": string; "boundary"?: boolean; "message"?: string; "author"?: string; "date"?: string }[] = [];

		for (const { line, oid, boundary } of blameOf(versions)) {
			if (line < first || line > last) {
				continue;
			}

			const run = runs.at(-1);

			if (run !== undefined && run.commit === (oid === "working" ? "working" : shortOf(oid)) && run.to === line - 1) {
				run.to = line;
			} else {
				const commit = byOid.get(oid);

				runs.push({ "from": line, "to": line, "commit": oid === "working" ? "working" : shortOf(oid), ...boundary ? { "boundary": true } : {}, ...commit === undefined ? {} : { "message": commit.message.split("\n")[0], "author": commit.author.name, "date": new Date(commit.author.timestamp * 1000).toISOString() } });
			}
		}

		return { "path": path, "runs": runs, "versions": versions.length - 1, ...runs.some((run) => run.boundary === true) ? { "boundary": "lines marked boundary are as old as the oldest version read, or older: the history here ends there" } : {}, ...await ends(commits) };
	});
	vscode.commands.registerCommand("editor.git.file", file);

	// A pick as the engine commits it: the working file, a deletion, or the text HEAD becomes with only the picked rows
	// (undefined when nothing of the file is picked).
	const toCommit = async (pick: CommitPick, changes: ReadonlyMap<string, GitFileChange>): Promise<engine.CommitFile | undefined> => {
		const change = changes.get(pick.path);

		if (change === undefined) {
			throw new Error(`${pick.path} has no change to commit`);
		}

		const whole = { "path": pick.path, ...change.status === "D" ? { "deleted": true } : {} };

		if (pick.hunks === undefined && pick.except === undefined) {
			return whole;
		}

		const { head, working } = await file(pick.path);
		const rows = alignedRows(head, working);
		const left = pick.hunks === undefined ? new Set(pick.except) : unpicked(rows, rowsOfHunks(pick.path, hunksOf(pick.path, head, working, rows), pick.hunks));

		if (left.size === 0) {
			return whole;
		}

		return unpicked(rows, left).size === 0 ? undefined : { "path": pick.path, "content": committedContent(head, working, rows, left) };
	};

	const commit = async (request: { "message"?: string; "files"?: CommitPick[] } | null): Promise<engine.Committed> => {
		const message = request?.message?.trim();

		if (message === undefined || message === "") {
			throw new Error("Enter a commit message first.");
		}

		let made: engine.Committed;

		// `files` present → a selective commit (the panel's picks, an agent's files or hunks); absent → every change.
		if (request?.files === undefined) {
			made = await engine.commitAll(message);
		} else {
			const changes = new Map((await status()).files.map((change) => [change.path, change]));
			const picked = await Promise.all(request.files.map(async (pick) => toCommit(pick, changes)));

			made = await engine.commitSelection(message, picked.filter((each) => each !== undefined));
		}

		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": made.oid.slice(0, 7), "files": request?.files?.length });

		return made;
	};

	serve(hub, "git.commit", async (args) => commit(args));
	vscode.commands.registerCommand("editor.git.commit", async (message: unknown) => commit({ "message": typeof message === "string" ? message : undefined }));

	// What only the shell has — the sign-in — asked of it: who a commit is by, and a push's requests (shell/git-push.ts).
	const shell = createRpcClient(hub);

	const identity = async (): Promise<{ "name": string; "email": string } | undefined> => {
		try {
			return await shell.request("git.identity", undefined, { "timeoutMs": 30_000 }) as { "name": string; "email": string } | null ?? undefined;
		} catch (error) {
			log.warn("who a commit is by: unknown, so it's the placeholder's", { "error": error instanceof Error ? error.message : String(error) });

			return undefined;
		}
	};

	engine.setAuthor(identity);
	// Asked now, so the first commit doesn't wait on GitHub (the shell keeps the answer): asked cold, as a page still
	// loading this repository answered it, it took longer than a commit waited (editor 2be5c8a, by the placeholder).
	void identity();

	// The branches; with a `name`, one made at HEAD (`git branch <name>`).
	serve(hub, "git.branch", async (args) => {
		const name = (args as { "name"?: unknown } | null)?.name;

		if (typeof name === "string" && name !== "") {
			await engine.createBranch(name);
		}

		return engine.branches();
	});
	// Onto another branch — made at HEAD first with `create` (`git switch -c`), the working tree as it is.
	serve(hub, "git.checkout", async (args) => {
		const { name, create } = (args ?? {}) as { "name"?: unknown; "create"?: unknown };

		if (typeof name !== "string" || name === "") {
			throw new TypeError("git.checkout needs a branch name.");
		}

		await engine.switchBranch(name, create === true);
		hub.publish("git.changed");

		return engine.branches();
	});
	// A branch (the current one, by default) pushed to the repository it was cloned from, through the shell.
	serve(hub, "git.push", async (args) => {
		const { ref, force } = (args ?? {}) as { "ref"?: unknown; "force"?: unknown };
		const url = await engine.githubRemote();

		if (url === undefined) {
			throw new Error("this workspace wasn't loaded from a GitHub repository, so there's nowhere to push it");
		}

		const pushed = await engine.push(remoteHttp(async (request) => await shell.request("git.remote", request, { "timeoutMs": 300_000 }) as RemoteResponse), url, typeof ref === "string" && ref !== "" ? ref : undefined, force === true);

		log.info("git push", { "ref": pushed.ref, "ok": pushed.ok });

		return { ...pushed, "url": url };
	});

	// Discard a file's working-tree changes: all of them (back to HEAD, or gone), or only the hunks given (`hunks`) or
	// the changed rows given (`rows`, the panel's).
	serve(hub, "git.discard", async (args) => {
		const request = args as { "path"?: string; "hunks"?: string[]; "rows"?: number[] } | null;

		if (typeof request?.path !== "string") {
			throw new TypeError("git.discard needs a path.");
		}

		if (request.hunks === undefined && request.rows === undefined) {
			await engine.discardFile(request.path);
		} else {
			const { head, working } = await file(request.path);
			const rows = alignedRows(head, working);
			const reverted = request.hunks === undefined ? new Set(request.rows) : rowsOfHunks(request.path, hunksOf(request.path, head, working, rows), request.hunks);

			await (unpicked(rows, reverted).size === 0 ? engine.discardFile(request.path) : engine.setWorking(request.path, committedContent(head, working, rows, reverted)));
		}

		hub.publish("git.changed");

		return { "ok": true };
	});

	// Tell the shell to refresh when the working tree changes (saves, and picker-driven writes).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			hub.publish("git.changed");
		}, 300);
	};

	vscode.workspace.onDidSaveTextDocument(schedule);

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	watcher.onDidDelete(schedule);

	log.info("git service installed");

	// Announce readiness once there's a repository (made here if the workspace has none): both faces subscribe
	// `git.changed`, so this prompts their first load the moment the serves are live.
	void engine.ensureRepo().then(() => {
		hub.publish("git.changed");
	}, (error: unknown) => {
		// (an Error, else whatever was thrown — a primitive)
		const thrown = error as Error | string | number | boolean | null | undefined;

		log.error("git repository unavailable", { "error": thrown instanceof Error ? thrown.message : String(thrown) });
	});

	return { "status": status, "file": file };
}
