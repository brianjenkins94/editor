/**
 * VS Code's Source Control view for the workspace's git: its staged and unstaged changes (a cosmetic-only change dimmed
 * — formatting or comments, by BABLR's verdict), the HEAD side of each for the diff editor and the gutters, and
 * commit-all from the input box.
 *
 * Git is the core runtime's: one engine (git-engine.ts, isomorphic-git on the shared workspace) behind one service
 * (git-service.ts) on the hub, which the shell's review panel reads too. This is that service's VS Code face — the
 * bridge's part is the crossing: `git.status`, `git.file`, `git.commit` over the hub, and `git.changed` to refresh.
 */
import type { GitFileChange } from "../../git-service";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { podHub } from "./pod";

const DIR = "/workspace";
/** A read-only scheme serving each file's HEAD version, for the gutters and the diff editor. */
const HEAD_SCHEME = "git-head";

export function registerSourceControl(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);
	const scm = vscode.scm.createSourceControl("git", "Git", vscode.Uri.file(DIR));
	const staged = scm.createResourceGroup("staged", "Staged Changes");
	const changes = scm.createResourceGroup("changes", "Changes");

	staged.hideWhenEmpty = true;
	scm.inputBox.placeholder = "Message (Ctrl+Enter to commit all)";
	scm.acceptInputCommand = { "command": "editor.git.commit", "title": "Commit" };
	scm.quickDiffProvider = { "provideOriginalResource": (uri) => uri.with({ "scheme": HEAD_SCHEME }) };

	const stateOf = (change: GitFileChange): vscode.SourceControlResourceState => {
		const resourceUri = vscode.Uri.file(DIR + "/" + change.path);

		return {
			"resourceUri": resourceUri,
			// Clicking a change opens the diff (HEAD ↔ working tree), the standard SCM gesture.
			"command": { "command": "vscode.diff", "title": "Open Changes", "arguments": [resourceUri.with({ "scheme": HEAD_SCHEME }), resourceUri, change.path + " (Working Tree)"] },
			"decorations": { "strikeThrough": change.status === "D", "faded": change.cosmetic, "tooltip": change.cosmetic ? "Cosmetic — formatting / comments only" : change.status }
		};
	};

	let refreshing: Promise<void> | undefined;
	const refresh = async (): Promise<void> => {
		refreshing ??= (async () => {
			try {
				const { files } = await rpc.request("git.status", undefined, { "timeoutMs": 60_000, "waitForResponderMs": 30_000 }) as { "files": GitFileChange[] };

				staged.resourceStates = files.filter((file) => file.staged).map(stateOf);
				changes.resourceStates = files.filter((file) => file.unstaged).map(stateOf);
				scm.count = files.length;
			} catch { /* no repository yet, or the service isn't up: the next change refreshes */ } finally {
				refreshing = undefined;
			}
		})();

		return refreshing;
	};

	context.subscriptions.push(
		scm,
		// The HEAD side of a file, for the diff editor and the gutters.
		vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, {
			"provideTextDocumentContent": async (uri) => ((await rpc.request("git.file", { "path": uri.path.replace(DIR + "/", "") }, { "timeoutMs": 30_000, "waitForResponderMs": 30_000 })) as { "head": string }).head
		}),
		vscode.commands.registerCommand("editor.git.commit", async (messageArg?: unknown) => {
			// The message from the arg (a programmatic caller) or the input box (the accept button, Ctrl+Enter).
			const message = (typeof messageArg === "string" ? messageArg : scm.inputBox.value).trim();

			if (message === "") {
				void vscode.window.showWarningMessage("Enter a commit message first.");

				return;
			}

			try {
				await rpc.request("git.commit", { "message": message }, { "timeoutMs": 60_000 });
				scm.inputBox.value = "";
			} catch (error) {
				void vscode.window.showErrorMessage("Commit failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}),
		vscode.commands.registerCommand("editor.git.refresh", refresh),
		// The service says when the working tree (or the repository) changed.
		{ "dispose": podHub.subscribe("git.changed", () => { void refresh(); }) }
	);

	void refresh();
}
