/**
 * Cosmetic changes (ARCHITECTURE.md's worked example, the classifier as an extension of its own): a changed file whose
 * change is formatting or comments only — by BABLR's verdict of HEAD against the working tree — marked with a file
 * decoration (a ≈ badge, its name dimmed), which VS Code draws wherever the file is listed: Source Control, the Explorer,
 * tabs. Knows nothing of how git is kept: the changes come through the editor's git commands, the verdicts through the
 * editor's BABLR (`editor.annotations.classify`, sharing its cached parses) — ARCHITECTURE.md, *Extension points* 5.
 *
 * `cosmetic.list`: each changed code file's verdict, as last read.
 */
import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";

import { type Asks, changedBetween, type Verdict, verdictsOf } from "./verdicts";

/** How long after a change the files are read again. */
const SETTLE_MS = 2000;

/** How long after the editor starts before the first read: a git status and BABLR's parses are work the boot (and
 *  TypeScript's first answers) shouldn't share a thread with, and a change made sooner is read as it's saved. */
const FIRST_READ_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("cosmetic", vscode);

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	const changed = new vscode.EventEmitter<vscode.Uri[]>();
	/** Each changed code file's verdict, by its path. */
	let verdicts = new Map<string, Verdict>();
	const root = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;
	/** What a reading asks the editor: its git, and its BABLR. */
	const asks: Asks = {
		"status": async () => vscode.commands.executeCommand<{ "files": GitFileChange[] } | undefined>("editor.git.status"),
		"file": async (path) => vscode.commands.executeCommand<{ "head": string; "working": string }>("editor.git.file", path),
		"classify": async (head, working) => {
			const answer = await annotations(vscode.commands).classify(head, working);

			return answer !== undefined && "value" in answer
				? answer.value.verdict
				: undefined;
		}
	};

	/** Every modified code file's verdict, read again — the files whose mark changed told. */
	const readNow = async (): Promise<void> => {
		const folder = root();
		const next = folder === undefined
			? undefined
			: await verdictsOf(asks);

		if (folder === undefined || next === undefined) {
			return;
		}

		const touched = changedBetween(verdicts, next);

		verdicts = next;
		changed.fire(touched.map((path) => vscode.Uri.joinPath(folder, path)));
	};

	const read = async (): Promise<void> => {
		const log = observed?.log;

		return log === undefined
			? readNow()
			: log.span("editor.extensions.cosmetic.read", {}, readNow);
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const later = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void read();
		}, SETTLE_MS);
	};

	/** Whether to follow file changes yet: not while the workspace is still being written at boot. */
	let following = false;
	const follow = (): void => {
		following = true;
		later();
	};

	const changedFile = (): void => {
		if (following) {
			later();
		}
	};

	// (what can change a verdict: a code file, or git's HEAD and refs, a commit or a checkout — not every file a run or a
	// tool writes, each of which would read every changed file again)
	const watcher = vscode.workspace.createFileSystemWatcher("{**/*.{ts,tsx,js,jsx,mjs,cjs},.git/HEAD,.git/refs/**}");

	context.subscriptions.push(
		changed,
		watcher,
		vscode.window.registerFileDecorationProvider({
			"onDidChangeFileDecorations": changed.event,
			"provideFileDecoration": (uri) => (verdicts.get(vscode.workspace.asRelativePath(uri, false)) === "cosmetic"
				? {
						"badge": "≈",
						"tooltip": "Cosmetic — formatting or comments only",
						"color": new vscode.ThemeColor("disabledForeground")
					}
				: undefined)
		}),
		// (a save, a code file the repository changes, or a commit or checkout: git's HEAD and refs)
		vscode.workspace.onDidSaveTextDocument(follow),
		watcher.onDidChange(changedFile),
		watcher.onDidCreate(changedFile),
		watcher.onDidDelete(changedFile),
		vscode.commands.registerCommand("cosmetic.list", () => Object.fromEntries(verdicts))
	);

	const first = setTimeout(follow, FIRST_READ_MS);

	context.subscriptions.push({
		"dispose": () => {
			clearTimeout(first);
			clearTimeout(timer);
		}
	});
}
