/**
 * Comment-annotations — the first UI consumer of the node-id annotation store. VS Code's native Comments API is the
 * inline surface (gutter "+", threaded widget, markdown, reply); our store (`.git/bablr-annotations/`, keyed by
 * DERIVABLE node ids) is the persistence + move-stable anchor the Comments API deliberately lacks.
 *
 * Division of labour:
 *   - Comments API pins a thread to a `Range`; on edit it drifts and VS Code forgets it on reload.
 *   - We store each thread under a NODE ID (from the history-anchored `.bablr` identity), so a thread follows its line
 *     as the file changes. At render time we resolve node id → current line via the identity's `nodeLines` map; when a
 *     reviewer starts a thread on a line we resolve line → the node id on it and persist under that id.
 *
 * SLICE 1: rehydrate threads on open (and re-place them on save, which recomputes positions from the store for free),
 * and persist on comment create. Reply/resolve and character-precise ranges are a later pass. Runs in the workbench
 * realm (vscode API + zen-fs both live here), so it calls the engine directly — no hub hop.
 */
import type * as vscodeApi from "vscode";
import type { Logger } from "@brianjenkins94/util/logger";
import type { CosmeticClassifier } from "./cosmetic-classifier";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One persisted comment (the annotation value for a node id is an array of these). */
interface StoredComment { "author": string; "body": string; "timestamp": string }

/** Repo-relative path for a workspace file uri, or undefined for anything outside the workspace / not classifiable. */
function repoRelative(uri: vscodeApi.Uri): string | undefined {
	if (uri.scheme !== "file" || !uri.path.startsWith(DIR + "/")) {
		return undefined;
	}

	const path = uri.path.slice(DIR.length + 1);

	return CLASSIFIABLE.test(path) ? path : undefined;
}

/** Install the review-notes comment controller. `bablr.addComment` (contributed by the hello manifest) is the submit. */
export function installCommentAnnotations(vscode: typeof vscodeApi, classifier: CosmeticClassifier, log: Logger): void {
	const controller = vscode.comments.createCommentController("bablr.annotations", "Review notes");

	// Allow a thread to start on any line of a classifiable workspace file (the gutter "+").
	controller.commentingRangeProvider = {
		"provideCommentingRanges": (document) =>
			(repoRelative(document.uri) === undefined ? [] : [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)]),
	};

	// Live threads per uri, so we can dispose + rebuild on rehydrate. The node-line map per uri backs line ↔ node id.
	const threadsByUri = new Map<string, vscodeApi.CommentThread[]>();
	const nodeLinesByUri = new Map<string, Record<string, number>>();

	const toComment = (stored: StoredComment): vscodeApi.Comment => ({
		"body": new vscode.MarkdownString(stored.body),
		"mode": vscode.CommentMode.Preview,
		"author": { "name": stored.author },
		"timestamp": new Date(stored.timestamp),
	});

	// The node id whose current line is `line` (1-based); if none sits exactly on it, the nearest node at or above it
	// (the enclosing/preceding node) — so a comment on a blank/trivia line still anchors to real structure.
	const nodeIdForLine = (nodeLines: Record<string, number>, line: number): string | undefined => {
		let exact: string | undefined;
		let bestBelow: { "id": string; "line": number } | undefined;

		for (const [id, nodeLine] of Object.entries(nodeLines)) {
			if (nodeLine === line) {
				exact ??= id;
			} else if (nodeLine < line && (bestBelow === undefined || nodeLine > bestBelow.line)) {
				bestBelow = { "id": id, "line": nodeLine };
			}
		}

		return exact ?? bestBelow?.id;
	};

	// Derive the current node id → line map for a file (HEAD→working identity — the same ids classify produces).
	const nodeLinesFor = async (path: string): Promise<Record<string, number>> => {
		let working: string;

		try {
			working = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));
		} catch {
			return {};
		}

		const head = await engine.headContent(path);
		const analysis = await classifier.identify([head, working]);

		return analysis.nodeLines;
	};

	// Rebuild a file's threads from the store — dispose the old ones, then re-anchor each stored node id to its current
	// line. Called on open AND save, so a save re-places every thread (positions come back from the identity) for free.
	const rehydrate = async (uri: vscodeApi.Uri): Promise<void> => {
		const path = repoRelative(uri);

		if (path === undefined) {
			return;
		}

		const key = uri.toString();

		const annotations = await engine.readAnnotations(path) as Record<string, StoredComment[]>;
		const ids = Object.keys(annotations);

		for (const thread of threadsByUri.get(key) ?? []) {
			thread.dispose();
		}

		threadsByUri.delete(key);

		if (ids.length === 0) {
			nodeLinesByUri.delete(key);

			return; // nothing pinned here — skip the parse entirely
		}

		const nodeLines = await nodeLinesFor(path);

		nodeLinesByUri.set(key, nodeLines);

		const threads: vscodeApi.CommentThread[] = [];

		for (const id of ids) {
			const line = nodeLines[id];
			const comments = annotations[id];

			if (line === undefined || comments.length === 0) {
				continue; // the node no longer exists in the working file (deleted) — keep the data, just don't show it
			}

			const range = new vscode.Range(line - 1, 0, line - 1, 0);
			const thread = controller.createCommentThread(uri, range, comments.map(toComment));

			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			threads.push(thread);
		}

		threadsByUri.set(key, threads);
		log.info("comment annotations rehydrated", { "path": path, "threads": threads.length });
	};

	// Submit handler for the gutter "+" (contributed to comments/commentThread/context in the hello manifest). Resolve
	// the thread's line → the node id on it, append the comment under that id, and persist.
	const addComment = async (reply: vscodeApi.CommentReply): Promise<void> => {
		const uri = reply.thread.uri;
		const path = repoRelative(uri);

		if (path === undefined) {
			return;
		}

		const key = uri.toString();
		let nodeLines = nodeLinesByUri.get(key);

		if (nodeLines === undefined) {
			nodeLines = await nodeLinesFor(path);
			nodeLinesByUri.set(key, nodeLines);
		}

		const line = reply.thread.range.start.line + 1; // 1-based
		const nodeId = nodeIdForLine(nodeLines, line);

		if (nodeId === undefined) {
			void vscode.window.showWarningMessage("Couldn't anchor this note to a code node — try a line with code on it.");
			reply.thread.dispose();

			return;
		}

		const existing = await engine.readAnnotations(path) as Record<string, StoredComment[]>;
		const stored: StoredComment[] = [...(existing[nodeId] ?? []), { "author": "You", "body": reply.text, "timestamp": new Date().toISOString() }];

		await engine.setAnnotation(path, nodeId, stored);

		// Reflect it in the widget immediately, and remember the thread so a later rehydrate can replace it.
		reply.thread.comments = stored.map(toComment);
		reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

		const threads = threadsByUri.get(key) ?? [];

		if (!threads.includes(reply.thread)) {
			threads.push(reply.thread);
		}

		threadsByUri.set(key, threads);
		log.info("comment annotation saved", { "path": path, "nodeId": nodeId });
	};

	vscode.commands.registerCommand("bablr.addComment", (reply: vscodeApi.CommentReply) => {
		void addComment(reply).catch((error: unknown) => { log.error("addComment failed", { "error": errText(error) }); });
	});

	// Rehydrate the editors already open, then any that open later, and re-place on save.
	const refresh = (uri: vscodeApi.Uri): void => { void rehydrate(uri).catch((error: unknown) => { log.error("rehydrate failed", { "error": errText(error) }); }); };

	for (const editor of vscode.window.visibleTextEditors) {
		refresh(editor.document.uri);
	}

	vscode.workspace.onDidOpenTextDocument((document) => { refresh(document.uri); });
	vscode.workspace.onDidSaveTextDocument((document) => { refresh(document.uri); });

	log.info("comment annotations installed");
}
