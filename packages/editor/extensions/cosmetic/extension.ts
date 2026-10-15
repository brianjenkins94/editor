/**
 * Cosmetic changes (ARCHITECTURE.md's worked example, the classifier as an extension of its own): a changed file whose
 * change is formatting or comments only — by BABLR's verdict of HEAD against the working tree — marked with a file
 * decoration (a ≈ badge, its name dimmed), which VS Code draws wherever the file is listed: Source Control, the Explorer,
 * tabs. Knows nothing of how git is kept: the changes come through the editor's git commands, the verdicts through the
 * editor's BABLR (`editor.annotations.classify`, sharing its cached parses) — EXTENSION-POINTS 5.
 *
 * `cosmetic.list`: each changed code file's verdict, as last read.
 */
import type { ChangeVerdict, GitFileChange } from "@brianjenkins94/editor-api/git";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import * as vscode from "vscode";

/** The files BABLR reads: code. */
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** How long after a change the files are read again. */
const SETTLE_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
	const changed = new vscode.EventEmitter<vscode.Uri[]>();
	/** Each changed code file's verdict, by URI. */
	let verdicts = new Map<string, ChangeVerdict["verdict"]>();
	const root = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;

	/** Every modified code file's verdict, read again — the files whose mark changed told. */
	const read = async (): Promise<void> => {
		const folder = root();
		const status = await Promise.resolve(vscode.commands.executeCommand<{ "files": GitFileChange[] } | undefined>("editor.git.status")).catch(() => undefined);

		if (folder === undefined || status === undefined) {
			return;
		}

		const next = new Map<string, ChangeVerdict["verdict"]>();

		// One at a time: BABLR's worker queues them anyway, and a verdict over texts it has parsed is quick.
		for (const file of status.files.filter((each) => each.status === "M" && CODE.test(each.path))) {
			const texts = await Promise.resolve(vscode.commands.executeCommand<{ "head": string; "working": string }>("editor.git.file", file.path)).catch(() => undefined);
			const answer = texts === undefined ? undefined : await annotations(vscode.commands).classify(texts.head, texts.working);

			next.set(vscode.Uri.joinPath(folder, file.path).toString(), answer !== undefined && "value" in answer ? answer.value.verdict : "none");
		}

		const touched = [...new Set([...verdicts.keys(), ...next.keys()])].filter((uri) => verdicts.get(uri) !== next.get(uri));

		verdicts = next;
		changed.fire(touched.map((uri) => vscode.Uri.parse(uri)));
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const later = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void read();
		}, SETTLE_MS);
	};

	const watcher = vscode.workspace.createFileSystemWatcher("**/*");

	context.subscriptions.push(
		changed,
		watcher,
		vscode.window.registerFileDecorationProvider({
			"onDidChangeFileDecorations": changed.event,
			"provideFileDecoration": (uri) => (verdicts.get(uri.toString()) === "cosmetic" ? { "badge": "≈", "tooltip": "Cosmetic — formatting or comments only", "color": new vscode.ThemeColor("disabledForeground") } : undefined)
		}),
		// (a save, or any file the repository changes — a commit too: git's own files are files)
		vscode.workspace.onDidSaveTextDocument(later),
		watcher.onDidChange(later),
		watcher.onDidCreate(later),
		watcher.onDidDelete(later),
		vscode.commands.registerCommand("cosmetic.list", () => Object.fromEntries([...verdicts].map(([uri, verdict]) => [vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false), verdict])))
	);

	later();
}
