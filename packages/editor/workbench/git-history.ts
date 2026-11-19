/**
 * What changed and when, as `git diff`, `git log`, `git show <rev>:<path>` and `git blame` say it — over the hub for
 * agents' git_diff, git_log, git_show and git_blame (app/tools/git), and the blame as a person reads it too: Git: Show
 * Blame for This File, beside the code. What a shallow clone holds of the history, and where
 * that ends, said.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { HttpClient } from "isomorphic-git";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { blameOf } from "../shared/git-hunks";
import * as engine from "./git-engine";
import { unifiedDiff } from "./git-service";

const DIR = "/workspace";

/** The characters `git.show` gives of a file, at most; and the commits `git.blame` reads back through. */
const MOST_SHOWN = 200_000;
const BLAME_COMMITS = 200;

/** Serve `git.diff`, `git.log`, `git.show` and `git.blame` on `hub`; `remote`, where `git.show` fetches a branch or tag
 *  the clone hasn't (git-push.ts' — without it, only what's here). */
/** A run of lines one commit last changed (`working`: not committed yet). */
interface BlameRun { "from": number; "to": number; "commit": string; "boundary"?: boolean; "message"?: string; "author"?: string; "date"?: string }

/** What a run says beside its first line: the commit, when and who — `working`, a change not yet committed. */
function labelOf(run: BlameRun): string {
	return run.commit === "working" ? "working" : `${run.commit} ${run.date?.slice(0, 10) ?? ""} ${run.author ?? ""}${run.boundary === true ? " (or older)" : ""}`.trimEnd();
}

export function installGitHistory(vscode: typeof vscodeApi, hub: Hub, remote?: HttpClient): void {
	const readWorking = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	// What changed, as `git diff HEAD` says it: one file's (`path`), or every changed file's — a unified diff of the
	// working tree against the last commit.
	serve(hub, "git.diff", async (args) => {
		const path = (args as { "path"?: string } | null)?.path;
		const current = typeof path === "string" && path !== "" ? undefined : await engine.status();
		const paths = current === undefined ? [path] : [...current.unstaged, ...current.staged].map((change) => change.path);
		const diffs = await Promise.all([...new Set(paths)].sort().map(async (each) => unifiedDiff(each, await engine.headContent(each).catch(() => ""), await readWorking(each).catch(() => ""))));

		return { "diff": diffs.join("") };
	});

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

		let text = await engine.fileAt(path, rev);

		// A branch or a tag the clone hasn't (it's one commit deep): fetched from the repository, then read.
		if (text === undefined && remote !== undefined && !/^[\da-f]{4,40}$/u.test(rev) && rev !== "HEAD") {
			const url = await engine.githubRemote();

			if (url !== undefined && await engine.fetchRef(remote, url, rev).catch(() => false)) {
				text = await engine.fileAt(path, rev);
			}
		}

		if (text === undefined) {
			throw new Error(`${rev} has no ${path} here (or isn't a commit, branch or tag this clone has or could fetch)`);
		}

		return { "path": path, "rev": rev, "lines": text.split("\n").length, "content": text.length > MOST_SHOWN ? text.slice(0, MOST_SHOWN) : text, ...text.length > MOST_SHOWN ? { "truncated": true } : {} };
	});

	/** Which commit last changed each line of `path`, as runs of lines from `first` to `last` (both 1-based). */
	const blame = async (path: string, first = 1, last = Number.POSITIVE_INFINITY): Promise<{ "path": string; "runs": BlameRun[]; "versions": number; "boundary"?: string; "working": string }> => {
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
		const runs: BlameRun[] = [];

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

		return { "path": path, "runs": runs, "versions": versions.length - 1, "working": versions[0].text, ...runs.some((run) => run.boundary === true) ? { "boundary": "lines marked boundary are as old as the oldest version read, or older: the history here ends there" } : {}, ...await ends(commits) };
	};

	serve(hub, "git.blame", async (args) => {
		const { path, from, to } = (args ?? {}) as { "path"?: unknown; "from"?: unknown; "to"?: unknown };

		if (typeof path !== "string" || path === "") {
			throw new TypeError("git.blame takes { path, from?, to? }: a file, and the lines (1-based) to say");
		}

		const first = typeof from === "number" && from > 0 ? from : 1;
		const { working, ...said } = await blame(path, first, typeof to === "number" && to >= first ? to : Number.POSITIVE_INFINITY);

		return said;
	});

	// A person's: each line of the file in front beside the commit that last changed it, read-only, beside it — what
	// agents' git_blame asks (`git.blame`).
	const shown = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscodeApi.Uri>();

	vscode.workspace.registerTextDocumentContentProvider("editor-blame", { "onDidChange": changed.event, "provideTextDocumentContent": (uri) => shown.get(uri.toString()) ?? "" });
	vscode.commands.registerCommand("editor.git.blame", async () => {
		const editor = vscode.window.activeTextEditor;

		if (editor?.document.uri.scheme !== "file") {
			void vscode.window.showInformationMessage("Git: Show Blame — open a file of the workspace first.");

			return;
		}

		const path = vscode.workspace.asRelativePath(editor.document.uri, false);
		const said = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Window, "title": `Blame of ${path}` }, async () => blame(path));
		const lines = said.working.split("\n");
		const width = Math.max(...said.runs.map((run) => labelOf(run).length), 0);
		const text = said.runs.flatMap((run) => Array.from({ "length": run.to - run.from + 1 }, (_, index) => `${(index === 0 ? labelOf(run) : "").padEnd(width)} │ ${lines[run.from - 1 + index] ?? ""}`));
		// (named as no language's file: `kept.ts` would be TypeScript's, taken into its server as a file of its own)
		const uri = vscode.Uri.from({ "scheme": "editor-blame", "path": `/${path}.blame` });

		shown.set(uri.toString(), [...text, ...said.boundary === undefined ? [] : ["", `(${said.boundary})`]].join("\n"));
		changed.fire(uri);
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { "viewColumn": vscode.ViewColumn.Beside, "preview": true });
	});
}
