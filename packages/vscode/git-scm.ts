/**
 * vscode SCM binding for the git engine — lights up the STANDARD Source Control viewlet (staged/unstaged groups,
 * commit box, diff gutters). Deliberately thin: all git logic lives in git-engine (no vscode dep), and this only
 * maps engine ↔ `vscode.scm`. That's the seam that lets a custom shell SCM/history UI replace this later while the
 * engine stays put — and it's why we build on the vscode SCM machinery even if its default look isn't the endgame.
 *
 * Phase-1 scope: show changes and commit-all via the input box. Per-file stage/unstage inline buttons need a real
 * extension MANIFEST (contributes.menus) — a follow-up; this runs in the workbench realm (where zen-fs + the vscode
 * API both live) to prove the engine, not as a packaged extension yet.
 */
import type * as vscodeApi from "vscode";
import type { Logger } from "@brianjenkins94/util/logger";
import * as engine from "./git-engine";

const DIR = "/workspace";
/** A read-only scheme serving each file's HEAD version, for quick-diff gutters and the diff editor. */
const HEAD_SCHEME = "git-head";

/** Install the git SourceControl into the running workbench. `vscode` is the captured extension API. */
export async function installGitScm(vscode: typeof vscodeApi, log: Logger): Promise<void> {
	await engine.ensureRepo();

	const scm = vscode.scm.createSourceControl("git", "Git", vscode.Uri.file(DIR));
	const stagedGroup = scm.createResourceGroup("staged", "Staged Changes");
	const changesGroup = scm.createResourceGroup("changes", "Changes");

	stagedGroup.hideWhenEmpty = true;
	scm.inputBox.placeholder = "Message (Ctrl+Enter to commit all)";
	scm.acceptInputCommand = { "command": "editor.git.commit", "title": "Commit" };
	scm.quickDiffProvider = { "provideOriginalResource": (uri) => uri.with({ "scheme": HEAD_SCHEME }) };

	// Serve HEAD content so the diff editor + gutter compare working tree vs HEAD.
	vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, {
		"provideTextDocumentContent": (uri) => engine.headContent(uri.path.replace(DIR + "/", ""))
	});

	const toState = (change: engine.GitChange): vscodeApi.SourceControlResourceState => {
		const resourceUri = vscode.Uri.file(DIR + "/" + change.path);
		const original = resourceUri.with({ "scheme": HEAD_SCHEME });

		return {
			"resourceUri": resourceUri,
			// Clicking a change opens the diff (HEAD ↔ working tree), the standard SCM gesture.
			"command": { "command": "vscode.diff", "title": "Open Changes", "arguments": [original, resourceUri, change.path + " (Working Tree)"] },
			"decorations": { "strikeThrough": change.status === "D", "tooltip": change.status }
		};
	};

	let refreshing = false;

	const refresh = async (): Promise<void> => {
		if (refreshing) {
			return;
		}

		refreshing = true;

		try {
			const status = await engine.status();

			stagedGroup.resourceStates = status.staged.map(toState);
			changesGroup.resourceStates = status.unstaged.map(toState);
			scm.count = status.staged.length + status.unstaged.length;
		} catch (error) {
			log.error("git status failed", { "error": error instanceof Error ? error.message : String(error) });
		} finally {
			refreshing = false;
		}
	};

	vscode.commands.registerCommand("editor.git.commit", async (messageArg?: unknown) => {
		// Message from the arg (programmatic callers) or the input box (the accept button / Cmd+Enter).
		const message = (typeof messageArg === "string" ? messageArg : scm.inputBox.value).trim();

		if (message === "") {
			void vscode.window.showWarningMessage("Enter a commit message first.");

			return;
		}

		try {
			const oid = await engine.commitAll(message);

			scm.inputBox.value = "";
			log.info("git commit", { "oid": oid.slice(0, 7) });
			await refresh();
		} catch (error) {
			void vscode.window.showErrorMessage("Commit failed: " + (error instanceof Error ? error.message : String(error)));
		}
	});

	vscode.commands.registerCommand("editor.git.refresh", refresh);

	// Refresh on saves and on any workspace file change (covers picker-driven writes), debounced so a burst of
	// writes coalesces into one status pass.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => { void refresh(); }, 300);
	};

	vscode.workspace.onDidSaveTextDocument(schedule);

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	watcher.onDidChange(schedule);
	watcher.onDidCreate(schedule);
	watcher.onDidDelete(schedule);

	await refresh();
	log.info("git SCM installed");
}
