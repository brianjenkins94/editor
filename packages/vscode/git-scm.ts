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
import type { CosmeticClassifier } from "./cosmetic-classifier";
import * as engine from "./git-engine";

const DIR = "/workspace";
/** A read-only scheme serving each file's HEAD version, for quick-diff gutters and the diff editor. */
const HEAD_SCHEME = "git-head";

/** Install the git SourceControl into the running workbench. `vscode` is the captured extension API; `classifier`
 *  is the shared cosmetic classifier (also used by the git service). */
export async function installGitScm(vscode: typeof vscodeApi, log: Logger, classifier: CosmeticClassifier): Promise<void> {
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

	// ── cosmetic vs semantic classification ───────────────────────────────────────────────────────────────────
	// The verdict is a git-agnostic service (worker + read-through cache in cosmetic-classifier.ts, backed by the
	// durable `.git/bablr/` store), shared with the git service; this binding just asks it about each MODIFIED file and
	// paints a faded "cosmetic only" badge for the cosmetic ones — a cache hit, so it re-runs no BABLR on refresh.
	const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
	const cosmeticPaths = new Set<string>(); // paths whose CURRENT working content is cosmetic-only

	const toState = (change: engine.GitChange): vscodeApi.SourceControlResourceState => {
		const resourceUri = vscode.Uri.file(DIR + "/" + change.path);
		const original = resourceUri.with({ "scheme": HEAD_SCHEME });
		const cosmetic = cosmeticPaths.has(change.path);

		return {
			"resourceUri": resourceUri,
			// Clicking a change opens the diff (HEAD ↔ working tree), the standard SCM gesture.
			"command": { "command": "vscode.diff", "title": "Open Changes", "arguments": [original, resourceUri, change.path + " (Working Tree)"] },
			"decorations": {
				"strikeThrough": change.status === "D",
				// A cosmetic-only change is dimmed with a hover note — the "these are just formatting" signal.
				"faded": cosmetic,
				"tooltip": cosmetic ? "Cosmetic — formatting / comments only" : change.status
			}
		};
	};

	let lastStatus: engine.GitStatus = { "staged": [], "unstaged": [] };

	const render = (): void => {
		stagedGroup.resourceStates = lastStatus.staged.map(toState);
		changesGroup.resourceStates = lastStatus.unstaged.map(toState);
		scm.count = lastStatus.staged.length + lastStatus.unstaged.length;
	};

	/** Classify every MODIFIED, classifiable file (HEAD vs working) off-thread, then re-render with the badges. */
	const classifyModified = async (status: engine.GitStatus): Promise<void> => {
		const modified = [...new Map([...status.unstaged, ...status.staged].map((change) => [change.path, change])).values()]
			.filter((change) => change.status === "M" && CLASSIFIABLE.test(change.path));

		await Promise.all(modified.map(async (change) => {
			try {
				const before = await engine.headContent(change.path);
				const after = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + change.path)));

				if ((await classifier.verdict(before, after)).verdict === "cosmetic") {
					cosmeticPaths.add(change.path);
				} else {
					cosmeticPaths.delete(change.path);
				}
			} catch { /* best-effort: a file we can't read/classify just gets no badge */ }
		}));

		render();
	};

	let refreshing = false;

	const refresh = async (): Promise<void> => {
		if (refreshing) {
			return;
		}

		refreshing = true;

		try {
			lastStatus = await engine.status();
			render(); // paint immediately with whatever verdicts are cached; badges fill in when classification lands
			void classifyModified(lastStatus);
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
