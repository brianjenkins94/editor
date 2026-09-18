/**
 * Comment-annotations — the UI consumer of the durable annotation store. VS Code's native Comments API is the inline
 * surface (gutter "+", threaded widget, markdown); the store is the persistence + move-stable anchor it lacks.
 *
 * Division of labour:
 *   - The Comments API pins a thread to a `Range`; on edit it drifts and VS Code forgets it on reload.
 *   - We persist each thread under a CONTENT-ADDRESSED SPAN-ANCHOR ID (bablr `spanAnchors`): a hash of the span's node
 *     type + trivia-insensitive content. It's move-stable (survives edits elsewhere, reindent, and even moving the
 *     span to another file) and self-edit-aware (editing the span itself mints a new id). On open we RE-DERIVE the
 *     span anchors of the current file and look each stored id up → its line; an id that's gone ORPHANS (kept on disk,
 *     just not shown). When a reviewer starts a thread on a line we resolve line → the span id there and persist it.
 *
 * The store lives in `.silo/notes/`, one file PER SPAN ID (never named by a file path) — so a rename is a non-problem
 * (there's no path in the key to migrate) and distinct notes don't merge-conflict. Committed, so notes travel with the
 * repo. Runs in the workbench realm (vscode API + zen-fs live here) → calls the engine directly.
 */
import type * as vscodeApi from "vscode";
import type { Logger } from "@brianjenkins94/util/logger";
import type { CosmeticClassifier, SpanAnchorLine } from "./cosmetic-classifier";
import * as engine from "./git-engine";

const DIR = "/workspace";
const CLASSIFIABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One persisted comment (the annotation value for a span id is an array of these). */
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

	// Live threads per uri, so we can dispose + rebuild on rehydrate. The span anchors per uri back line ↔ span id.
	const threadsByUri = new Map<string, vscodeApi.CommentThread[]>();
	const anchorsByUri = new Map<string, SpanAnchorLine[]>();

	const toComment = (stored: StoredComment): vscodeApi.Comment => ({
		"body": new vscode.MarkdownString(stored.body),
		"mode": vscode.CommentMode.Preview,
		"author": { "name": stored.author },
		"timestamp": new Date(stored.timestamp),
	});

	// The span-anchor id for a comment on `line` (1-based): the statement STARTING there, else the smallest statement
	// covering it (multi-line), so a comment on any of a statement's lines pins to that statement.
	const spanIdForLine = (anchors: SpanAnchorLine[], line: number): string | undefined => {
		const starting = anchors.find((anchor) => anchor.startLine === line);

		if (starting !== undefined) {
			return starting.id;
		}

		let covering: SpanAnchorLine | undefined;

		for (const anchor of anchors) {
			if (anchor.startLine <= line && line <= anchor.endLine && (covering === undefined || anchor.endLine - anchor.startLine < covering.endLine - covering.startLine)) {
				covering = anchor;
			}
		}

		return covering?.id;
	};

	// The current span anchors for a file — via the CONTENT-ADDRESSED `.git/bablr/<blobOid>.json` cache (a hit skips the
	// parse), else derive off-thread and cache. Keyed by the working blob oid, so it survives renames + dedups content.
	const anchorsFor = async (path: string): Promise<SpanAnchorLine[]> => {
		let working: string;

		try {
			working = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(DIR + "/" + path)));
		} catch {
			return [];
		}

		const blob = await engine.blobOid(working);
		const cached = await engine.readBablr(blob);

		if (Array.isArray(cached)) {
			return cached as SpanAnchorLine[];
		}

		const anchors = await classifier.anchors(working);

		void engine.writeBablr(blob, anchors).catch(() => { /* best-effort cache */ });

		return anchors;
	};

	// Rebuild a file's threads from the store — dispose the old ones, then re-anchor each stored SPAN ID to its current
	// line via freshly-derived anchors. Called on open AND save, so a save re-places every thread for free; a stored id
	// whose span no longer exists orphans (its data is kept, just not shown).
	const rehydrate = async (uri: vscodeApi.Uri): Promise<void> => {
		const path = repoRelative(uri);

		if (path === undefined) {
			return;
		}

		const key = uri.toString();
		const annotatedIds = new Set(await engine.annotatedSpanIds());

		for (const thread of threadsByUri.get(key) ?? []) {
			thread.dispose();
		}

		threadsByUri.delete(key);

		if (annotatedIds.size === 0) {
			anchorsByUri.delete(key);

			return; // no notes anywhere — skip the parse entirely
		}

		const anchors = await anchorsFor(path);

		anchorsByUri.set(key, anchors);

		const threads: vscodeApi.CommentThread[] = [];

		// Show a thread on every span of THIS file that carries a note; a note whose span is gone (edited away / lives in
		// another file) simply isn't matched here — no path lookup, so it's found wherever its span turns up.
		for (const anchor of anchors) {
			if (!annotatedIds.has(anchor.id)) {
				continue;
			}

			const comments = await engine.readNote(anchor.id) as StoredComment[] | undefined;

			if (comments === undefined || comments.length === 0) {
				continue;
			}

			const range = new vscode.Range(anchor.startLine - 1, 0, anchor.startLine - 1, 0);
			const thread = controller.createCommentThread(uri, range, comments.map(toComment));

			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			threads.push(thread);
		}

		threadsByUri.set(key, threads);
		log.info("comment annotations rehydrated", { "path": path, "threads": threads.length });
	};

	// Submit handler for the gutter "+" (contributed to comments/commentThread/context in the hello manifest). Resolve
	// the thread's line → the span id there, append the comment under that id, and persist to `.silo/`.
	const addComment = async (reply: vscodeApi.CommentReply): Promise<void> => {
		const uri = reply.thread.uri;
		const path = repoRelative(uri);

		if (path === undefined) {
			return;
		}

		const key = uri.toString();
		let anchors = anchorsByUri.get(key);

		if (anchors === undefined) {
			anchors = await anchorsFor(path);
			anchorsByUri.set(key, anchors);
		}

		const spanId = spanIdForLine(anchors, reply.thread.range.start.line + 1);

		if (spanId === undefined) {
			void vscode.window.showWarningMessage("Couldn't anchor this note to a statement — try a line with code on it.");
			reply.thread.dispose();

			return;
		}

		const existing = await engine.readNote(spanId) as StoredComment[] | undefined;
		const stored: StoredComment[] = [...(existing ?? []), { "author": "You", "body": reply.text, "timestamp": new Date().toISOString() }];

		await engine.setNote(spanId, stored);

		// Reflect it in the widget immediately, and remember the thread so a later rehydrate can replace it.
		reply.thread.comments = stored.map(toComment);
		reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

		const threads = threadsByUri.get(key) ?? [];

		if (!threads.includes(reply.thread)) {
			threads.push(reply.thread);
		}

		threadsByUri.set(key, threads);
		log.info("comment annotation saved", { "path": path, "spanId": spanId });
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
