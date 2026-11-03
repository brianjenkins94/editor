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
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as engine from "./git-engine";

const DIR = "/workspace";

/** Past this many changed lines a diff says so rather than listing them (a rewrite, a generated file). */
const MOST_EDITS = 5000;

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
export interface CommitPick { "path": string; "hunks"?: string[]; "except"?: number[] }

/** What the service reads the working tree with, for whoever joins more to it (git-review.ts). */
export interface GitReader {
	/** `whole`: a walk of the whole tree, for whoever acts on what it says (a commit, a checkpoint) — the change watcher
	 *  tells of a write a little after it, so a walk of only what it's told of may not have it yet. */
	"status": (options?: { "whole"?: boolean }) => Promise<{ "files": GitFileChange[]; "head"?: string }>;
	"file": (path: unknown) => Promise<{ "head": string; "working": string }>;
}

/** Part of a file as a commit takes it, for a pick of hunks or rows (the review's, git-review.ts `commitPart`): without
 *  it, a commit takes whole files only. */
export type CommitPart = (pick: CommitPick, whole: engine.CommitFile, file: GitReader["file"]) => Promise<engine.CommitFile | undefined>;

/** Serve `git.status` / `git.file` / `git.commit` and publish `git.changed` on the given hub — and the same as
 *  commands for extensions (ARCHITECTURE.md, *Extension points* 3): `editor.git.status`, `editor.git.file(path)`, `editor.git.commit(message)`.
 *  (An extension learns of a change as VS Code's own git does: a save, or a file watcher — the repository is files too.) */
export function installGitService(vscode: typeof vscodeApi, hub: Hub, log: Logger, { part }: { "part"?: CommitPart } = {}): GitReader {
	const readWorking = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	// What's changed in the working tree since the last walk, relative to the repository — what the next walks again
	// (engine.status); undefined, a walk of the whole tree (the first, or after a change that didn't say where).
	let changedSince: Set<string> | undefined;

	const walk = async (whole: boolean): Promise<{ "files": GitFileChange[]; "head"?: string }> => log.span("editor.workbench.git-service.walk", { "whole": whole }, async (span) => {
		const changed = whole || changedSince === undefined ? undefined : [...changedSince];

		changedSince = new Set();
		span.info("walking", { "count": changed?.length ?? -1 });

		const current = await engine.status(changed);
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

		span.end({ "count": byPath.size });

		return { "files": [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)), ...head === undefined ? {} : { "head": head } };
	});

	// One walk for askers that overlap: the Source Control view and the review panel each ask as the working tree
	// changes, and a walk is a lookup of every file in zen-fs. A walk that began after the last change answers whoever
	// asks while it runs (one asking for a whole walk, only a whole one); one asked after a change, or once it's done,
	// walks again.
	let changes = 0;
	let walking: { "since": number; "whole": boolean; "result": Promise<{ "files": GitFileChange[]; "head"?: string }> } | undefined;

	const status = async ({ whole = false }: { "whole"?: boolean } = {}): Promise<{ "files": GitFileChange[]; "head"?: string }> => {
		if (walking?.since === changes && (walking.whole || !whole)) {
			return walking.result;
		}

		const result = walk(whole);
		const current = { "since": changes, "whole": whole, "result": result };

		walking = current;
		void result.finally(() => {
			if (walking === current) {
				walking = undefined;
			}
		}).catch(() => undefined);

		return result;
	};

	serve(hub, "git.status", async (args) => status({ "whole": (args as { "whole"?: boolean } | null | undefined)?.whole === true }));
	vscode.commands.registerCommand("editor.git.status", async () => status());

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
	vscode.commands.registerCommand("editor.git.file", file);

	// A pick as the engine commits it: the working file, a deletion, or part of it (`part`; undefined when nothing of the
	// file is picked).
	const toCommit = async (pick: CommitPick, changes: ReadonlyMap<string, GitFileChange>): Promise<engine.CommitFile | undefined> => {
		const change = changes.get(pick.path);

		if (change === undefined) {
			throw new Error(`${pick.path} has no change to commit`);
		}

		const whole = { "path": pick.path, ...change.status === "D" ? { "deleted": true } : {} };

		if (pick.hunks === undefined && pick.except === undefined) {
			return whole;
		}

		if (part === undefined) {
			throw new Error(`a commit of part of ${pick.path} is the review's, which isn't here`);
		}

		return part(pick, whole, file);
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
			const changes = new Map((await status({ "whole": true })).files.map((change) => [change.path, change]));
			const picked = await Promise.all(request.files.map(async (pick) => toCommit(pick, changes)));

			made = await engine.commitSelection(message, picked.filter((each) => each !== undefined));
		}

		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": made.oid.slice(0, 7), "files": request?.files?.length });

		return made;
	};

	serve(hub, "git.commit", async (args) => commit(args));
	vscode.commands.registerCommand("editor.git.commit", async (message: unknown) => commit({ "message": typeof message === "string" ? message : undefined }));

	// What only the shell has — the sign-in — asked of it: who a commit is by (shell/git-push.ts).
	const shell = createRpcClient(hub);

	const identity = async (): Promise<{ "name": string; "email": string } | undefined> => {
		try {
			const who = await shell.request("git.identity", undefined, { "timeoutMs": 30_000 }) as { "name": string; "email": string } | null ?? undefined;

			// …and the workspace's git says so too, for what names its author from git's config (notes, runs).
			if (who !== undefined) {
				await engine.recordIdentity(who).catch((error: unknown) => {
					log.warn("couldn't write who you are to the workspace's git config", { "error": error instanceof Error ? error.message : String(error) });
				});
			}

			return who;
		} catch (error) {
			log.warn("who a commit is by: unknown, so it's the placeholder's", { "error": error instanceof Error ? error.message : String(error) });

			return undefined;
		}
	};

	engine.setAuthor(identity);
	// Asked now, so the first commit doesn't wait on GitHub (the shell keeps the answer): asked cold, as a page still
	// loading this repository answered it, it took longer than a commit waited (editor 2be5c8a, by the placeholder).
	void identity();

	// Tell the shell to refresh when the working tree changes (saves, and picker-driven writes).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (changed?: { "uri": { "path": string } } | { "path": string }): void => {
		changes += 1;

		const path = changed === undefined ? undefined : "uri" in changed ? changed.uri.path : changed.path;

		if (path?.startsWith(DIR + "/") === true) {
			changedSince?.add(path.slice(DIR.length + 1));
		} else {
			changedSince = undefined;
		}

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
