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
import { serve } from "@brianjenkins94/hub";
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

/** Serve `git.status` / `git.file` / `git.diff` / `git.commit` and publish `git.changed` on the given hub — and the same as
 *  commands for extensions (EXTENSION-POINTS 5): `editor.git.status`, `editor.git.file(path)`, `editor.git.commit(message)`.
 *  (An extension learns of a change as VS Code's own git does: a save, or a file watcher — the repository is files too.) */
export function installGitService(vscode: typeof vscodeApi, hub: Hub, log: Logger): void {
	const readWorking = async (path: string): Promise<string> => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));

	const status = async (): Promise<{ "files": GitFileChange[] }> => {
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

		return { "files": [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
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
	vscode.commands.registerCommand("editor.git.file", file);

	const commit = async (request: { "message"?: string; "files"?: engine.CommitFile[] } | null): Promise<engine.Committed> => {
		const message = request?.message?.trim();

		if (message === undefined || message === "") {
			throw new Error("Enter a commit message first.");
		}

		// `files` present → selective commit (the shell's checkbox / line selection); absent → legacy commit-all.
		const made = request?.files !== undefined
			? await engine.commitSelection(message, request.files)
			: await engine.commitAll(message);

		hub.publish("git.changed");
		log.info("git commit (service)", { "oid": made.oid.slice(0, 7), "files": request?.files?.length });

		// Committed all the same, but not silently: its runs weren't shared with it (git-engine.ts shareRuns).
		if (made.unshared !== undefined) {
			log.warn("git commit: runs not shared", { "oid": made.oid.slice(0, 7), "why": made.unshared });
			void vscode.window.showWarningMessage(`Committed ${made.oid.slice(0, 7)}, but its runs weren't shared with it (.silo/traces): ${made.unshared}. Commit again to share them.`);
		}

		return made;
	};

	serve(hub, "git.commit", async (args) => commit(args));
	vscode.commands.registerCommand("editor.git.commit", async (message: unknown) => commit({ "message": typeof message === "string" ? message : undefined }));

	// Discard a file's working-tree changes: whole file (restore HEAD / delete), or a PARTIAL discard when the shell
	// sends the exact post-discard `content` (working with the chosen hunks reverted).
	serve(hub, "git.discard", async (args) => {
		const request = args as { "path"?: string; "content"?: string } | null;

		if (typeof request?.path !== "string") {
			throw new TypeError("git.discard needs a path.");
		}

		if (typeof request.content === "string") {
			await engine.setWorking(request.path, request.content);
		} else {
			await engine.discardFile(request.path);
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
}
