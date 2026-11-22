import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import * as vscode from "vscode";

const DIR = "/workspace";
const HEAD_SCHEME = "git-head";
const SETTLE_MS = 300;
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
			"command": { "command": "vscode.diff", "title": "Open Changes", "arguments": [resourceUri.with({ "scheme": HEAD_SCHEME }), resourceUri, change.path + " (Working Tree)"] },
			"decorations": { "strikeThrough": change.status === "D", "tooltip": change.status }
		};
	};

	let refreshing: Promise<boolean> | undefined;
	const refresh = async (): Promise<boolean> => {
		refreshing ??= (async () => {
			try {
				const { files } = await vscode.commands.executeCommand<{ "files": GitFileChange[] }>("editor.git.status");

				staged.resourceStates = files.filter((file) => file.staged).map(stateOf);
				changes.resourceStates = files.filter((file) => file.unstaged).map(stateOf);
				scm.count = files.length;

				return true;
			} catch {
				return false;
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
				const { tests } = await vscode.commands.executeCommand<{ "tests"?: string }>("editor.git.commit", message);

				inputBox.value = "";
				await refresh();

				if (tests !== undefined) {
					void vscode.window.showInformationMessage(tests);
				}
			} catch (error) {
				void vscode.window.showErrorMessage("Commit failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}),
		vscode.commands.registerCommand("sourceControl.refresh", refresh),
		{ "dispose": () => { clearTimeout(timer); } }
	);

	const first = async (): Promise<void> => {
		if (!await refresh()) {
			timer = setTimeout(() => {
				void first();
			}, RETRY_MS);
		}
	};

	void first();
}
