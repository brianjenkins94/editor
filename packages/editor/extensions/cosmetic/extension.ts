import type { GitFileChange } from "@brianjenkins94/editor-api/git";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";

import { type Asks, changedBetween, type Verdict, verdictsOf } from "./verdicts";

const SETTLE_MS = 2000;

const FIRST_READ_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("cosmetic", vscode);

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	const changed = new vscode.EventEmitter<vscode.Uri[]>();
	let verdicts = new Map<string, Verdict>();
	const root = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;
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
