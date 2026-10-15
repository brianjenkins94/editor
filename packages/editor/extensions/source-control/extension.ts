/**
 * VS Code's Source Control view for the workspace's git: its staged and unstaged changes, the HEAD side of each for the
 * diff editor and the gutters, and commit-all from the input box. (A change that's formatting or comments only is marked
 * by the cosmetic extension, over any git.)
 *
 * Git is the editor's (git-engine.ts, isomorphic-git on the shared workspace, behind git-service.ts — the shell's review
 * panel reads it too); this is its VS Code face, through the commands the editor documents (EXTENSION-POINTS 5):
 * `editor.git.status`, `editor.git.file`, `editor.git.commit`. It learns of a change as VS Code's own git does: a save, or
 * a file watcher — the repository is files too. A browser build's: a desktop build has git of its own.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import * as vscode from "vscode";

const DIR = "/workspace";
/** A read-only scheme serving each file's HEAD version, for the gutters and the diff editor. */
const HEAD_SCHEME = "git-head";
/** How long after a change the view refreshes (a burst of writes is one refresh). */
const SETTLE_MS = 300;
/** Until the editor's git answers the first time (it starts after this extension can), how often to ask again. */
const RETRY_MS = 2000;

export function activate(context: vscode.ExtensionContext): void {
	const scm = vscode.scm.createSourceControl("git", "Git", vscode.Uri.file(DIR));
	const staged = scm.createResourceGroup("staged", "Staged Changes");
	const changes = scm.createResourceGroup("changes", "Changes");

	staged.hideWhenEmpty = true;
	scm.inputBox.placeholder = "Message (Ctrl+Enter to commit all)";
	scm.acceptInputCommand = { "command": "sourceControl.commit", "title": "Commit" };
	scm.quickDiffProvider = { "provideOriginalResource": (uri) => uri.with({ "scheme": HEAD_SCHEME }) };

	const stateOf = (change: GitFileChange): vscode.SourceControlResourceState => {
		const resourceUri = vscode.Uri.file(DIR + "/" + change.path);

		return {
			"resourceUri": resourceUri,
			// Clicking a change opens the diff (HEAD ↔ working tree), the standard SCM gesture.
			"command": { "command": "vscode.diff", "title": "Open Changes", "arguments": [resourceUri.with({ "scheme": HEAD_SCHEME }), resourceUri, change.path + " (Working Tree)"] },
			// (whether it's cosmetic is the cosmetic extension's, a file decoration of its own)
			"decorations": { "strikeThrough": change.status === "D", "tooltip": change.status }
		};
	};

	let refreshing: Promise<boolean> | undefined;
	/** Whether the editor's git answered. */
	const refresh = async (): Promise<boolean> => {
		refreshing ??= (async () => {
			try {
				const { files } = await vscode.commands.executeCommand<{ "files": GitFileChange[] }>("editor.git.status");

				staged.resourceStates = files.filter((file) => file.staged).map(stateOf);
				changes.resourceStates = files.filter((file) => file.unstaged).map(stateOf);
				scm.count = files.length;

				return true;
			} catch {
				return false; // no repository yet, or the editor's git isn't up: the next change refreshes
			} finally {
				refreshing = undefined;
			}
		})();

		return refreshing;
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const soon = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void refresh();
		}, SETTLE_MS);
	};

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	context.subscriptions.push(
		scm,
		watcher,
		watcher.onDidChange(soon),
		watcher.onDidCreate(soon),
		watcher.onDidDelete(soon),
		vscode.workspace.onDidSaveTextDocument(soon),
		// The HEAD side of a file, for the diff editor and the gutters.
		vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, {
			"provideTextDocumentContent": async (uri) => (await vscode.commands.executeCommand<{ "head": string }>("editor.git.file", uri.path.replace(DIR + "/", ""))).head
		}),
		vscode.commands.registerCommand("sourceControl.commit", async () => {
			const { inputBox } = scm;
			const message = inputBox.value.trim();

			if (message === "") {
				void vscode.window.showWarningMessage("Enter a commit message first.");

				return;
			}

			try {
				await vscode.commands.executeCommand("editor.git.commit", message);
				inputBox.value = "";
				await refresh();
			} catch (error) {
				void vscode.window.showErrorMessage("Commit failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}),
		vscode.commands.registerCommand("sourceControl.refresh", refresh),
		{ "dispose": () => { clearTimeout(timer); } }
	);

	// The first load, once the editor's git answers.
	const first = async (): Promise<void> => {
		if (!await refresh()) {
			timer = setTimeout(() => {
				void first();
			}, RETRY_MS);
		}
	};

	void first();
}
