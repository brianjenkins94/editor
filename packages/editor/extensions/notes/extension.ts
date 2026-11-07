/**
 * Notes on code that stay with it (RUNTIME-EVIDENCE.md, *Durable annotations on spans*). A note is kept on the BABLR span it's
 * about, in `.silo/notes/<author>/<file>.jsonl` (in git, everyone's beside everyone else's), and each time its file is drawn it's
 * found again in the text as it is now. It's shown beside its code in the Margin, not behind a mark to click: something to
 * go and open is too easy to ignore (the user, 2026-11-06, of panels).
 *
 * Found on its span, or followed there: a note of yours followed is rewritten where it landed, so the next look finds it by id.
 * Moved to another file: a note of yours goes with it; anyone else's waits here, saying where. Its code changed, or perhaps moved:
 * shown there, asking to be kept. Gone: it waits in Problems, at its last place. Each is decided from the lightbulb, as a rule placed in the code is.
 * Dismissing writes a tombstone, so a branch merge can't bring it back. Only a note's author changes it.
 */
import type { Resolved, SpanRef } from "@brianjenkins94/editor-api/annotations";
import type { PaneContent, PaneItem } from "@brianjenkins94/editor-api/pane";
import type { Annotation } from "@brianjenkins94/util/silo/annotations";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import { annotationsText, parseAnnotations } from "@brianjenkins94/util/silo/annotations";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { annotationsPath, GITATTRIBUTES, SILO_DIR, withLines } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

type Note = Annotation<{ "text": string }>;

/** A note, who wrote it, and where it was found now: the 0-based line it's on, when that's in this file. */
interface Landing { "note": Note; "owner": string; "resolved": Resolved; "line"?: number }

const VIEW = "notes";
const CODE = /\.[cm]?[jt]sx?$/u;
const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

const textOf = ({ payload }: Note): string => payload?.text ?? "";

/** A note as a line can say it. */
const shortly = (note: Note): string => {
	const text = textOf(note);

	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension(VIEW);
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const diagnostics = vscode.languages.createDiagnosticCollection(VIEW);
	/** What each file's notes were last found as: what its lightbulb offers, and what's shown while it can't be parsed. */
	const landed = new Map<string, Landing[]>();
	const read = async (uri: vscode.Uri): Promise<string> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");
	const write = async (uri: vscode.Uri, text: string): Promise<void> => {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	};
	const relative = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, false);

	let user: string | undefined;
	// Who you are to git: `local` until it says, read again until it does, as a sign-in may come after the first note.
	const me = async (): Promise<string> => {
		user ??= userSlug(await read(vscode.Uri.joinPath(root, ".git/config")));

		return user ?? "local";
	};

	/** Everyone's notes on `file`, with who wrote each. */
	const notesOn = async (file: string): Promise<{ "note": Note; "owner": string }[]> => {
		const folder = vscode.Uri.joinPath(root, SILO_DIR, VIEW);
		const owners = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => [] as string[]);
		const found = await Promise.all(owners.map(async (owner) => (parseAnnotations(await read(vscode.Uri.joinPath(folder, owner, `${file}.jsonl`))) as Note[]).map((note) => ({ "note": note, "owner": owner }))));

		return found.flat().filter(({ note }) => note.dismissed !== true);
	};

	/** Write `note`, yours, into your notes on `file`: added, or replacing the version there. They merge line by line across
	 *  branches, as the rest of silo's records do. */
	const save = async (file: string, note: Note): Promise<void> => {
		const uri = vscode.Uri.joinPath(root, annotationsPath(VIEW, await me(), file));
		const attributes = vscode.Uri.joinPath(root, SILO_DIR, ".gitattributes");
		const merged = withLines(await read(attributes), GITATTRIBUTES);

		if (merged !== undefined) {
			await write(attributes, merged);
		}

		await write(uri, annotationsText([...parseAnnotations(await read(uri)).filter((other) => other.id !== note.id), note]));
	};

	const redraw = async (uri?: string): Promise<void> => {
		await refreshPane(vscode.commands, VIEW, uri);
	};

	/** Find `document`'s notes in its text as it is now, and do what that asks: a note of yours is kept where it landed. Undefined:
	 *  that can't be told now (it doesn't parse as it is, often mid-edit, which isn't their being lost). */
	const look = async (document: vscode.TextDocument): Promise<Landing[] | undefined> => {
		const file = relative(document.uri);
		const notes = await notesOn(file);

		if (notes.length === 0) {
			return [];
		}

		const answer = await annotations(vscode.commands).resolve(document.getText(), file, notes.map(({ note }) => note.ref));

		if (!("value" in answer)) {
			return undefined;
		}

		const you = await me();
		const now = new Date().toISOString();

		return Promise.all(notes.map(async ({ note, owner }, index): Promise<Landing> => {
			const resolved: Resolved = answer.value[index] ?? { "status": "orphaned", "alternatives": [] };
			const at = resolved.candidate;
			const here = at?.start !== undefined && at.file === file && resolved.status !== "orphaned";

			if (owner === you && resolved.ref !== undefined && at !== undefined) {
				if (resolved.status === "moved" && at.file !== file) {
					await save(file, { ...note, "dismissed": true, "updatedAt": now });
					await save(at.file, { ...note, "ref": resolved.ref, "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": now });
				} else if (resolved.status === "re-placed" && here) {
					await save(file, { ...note, "ref": resolved.ref, "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": now });
				}
			}

			return { "note": note, "owner": owner, "resolved": resolved, ...here ? { "line": document.positionAt(at.start ?? 0).line } : {} };
		}));
	};

	/** What a note that isn't on its code says, at its last place. */
	const lostProblem = (document: vscode.TextDocument, { note, owner, resolved }: Landing): vscode.Diagnostic => {
		const near = document.positionAt(Math.min(note.ref.baseline?.start ?? 0, document.getText().length));
		const elsewhere = resolved.status === "moved" ? resolved.candidate?.file : undefined;
		const problem = new vscode.Diagnostic(document.lineAt(near.line).range, elsewhere === undefined ? `A note lost its place: "${textOf(note)}". Put the cursor on the code it's about: the lightbulb puts it back, or dismisses it.` : `A note's code moved to ${elsewhere}: "${textOf(note)}". It moves there when ${owner} next opens this file.`, vscode.DiagnosticSeverity.Information);

		problem.source = VIEW;

		return problem;
	};

	/** A note beside its code: yours plain, anyone else's with who wrote it; one whose code changed or perhaps moved asking to be kept. */
	const itemOf = async (uri: string, { note, owner, resolved, line }: Landing): Promise<PaneItem[]> => {
		if (line === undefined) {
			return [];
		}

		const by = owner === await me() ? "" : `**${owner}:** `;
		const unsure = resolved.status === "uncertain";

		return [{
			"id": `note:${note.id}`,
			"at": { "lines": [line, line] },
			"content": { "markdown": `${unsure ? "_Still about this?_ " : ""}${by}${textOf(note)}` },
			"tone": unsure ? "question" : "info",
			...unsure && by === "" ? { "actions": [{ "title": "Keep here", "command": "notes.place", "arguments": [note.id, uri, line], "tooltip": "It's about this code: keep it here" }] } : {}
		}];
	};

	const span = async <T>(word: string, attributes: Record<string, string | number>, work: () => Promise<T>): Promise<T> => (observed === undefined ? work() : observed.log.span(`editor.extensions.notes.${word}`, attributes, work));

	/** A reference to the code selected, or the line the cursor's on. Else, why not. */
	const referAt = async (document: vscode.TextDocument, selection: vscode.Selection): Promise<SpanRef | string> => {
		const { firstNonWhitespaceCharacterIndex, range } = document.lineAt(selection.start.line);
		const start = selection.isEmpty ? document.offsetAt(new vscode.Position(selection.start.line, firstNonWhitespaceCharacterIndex)) : document.offsetAt(selection.start);
		const answer = await annotations(vscode.commands).refer(document.getText(), relative(document.uri), [{ "start": start, "end": document.offsetAt(selection.isEmpty ? range.end : selection.end) }]);

		if ("unparsable" in answer) {
			return `A note can't attach here: this file can't be parsed as it is (${answer.unparsable}).`;
		}

		if ("unavailable" in answer) {
			return `A note can't attach here: the editor's BABLR isn't available (${answer.unavailable}).`;
		}

		return answer.value[0] ?? "A note can't attach here: there's no code there it can stand on. Select a statement or an expression.";
	};

	/** A note of yours this file's lightbulb can act on, by its id. */
	const yours = async (id: string, uri: string): Promise<Note | undefined> => {
		const you = await me();

		return landed.get(uri)?.find(({ note, owner }) => note.id === id && owner === you)?.note;
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/${VIEW}/**/*.jsonl`);
	// Notes changed underneath: a pull, a merge, another window.
	const changed = (): void => {
		void redraw();
	};

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	context.subscriptions.push(
		diagnostics,
		watcher,
		watcher.onDidCreate(changed),
		watcher.onDidChange(changed),
		watcher.onDidDelete(changed),
		// Saved: code moved into this file is on disk now, where a note that lost its place elsewhere looks for it.
		vscode.workspace.onDidSaveTextDocument(changed),
		vscode.commands.registerCommand("notes.paneView", async (uri: unknown): Promise<PaneContent | undefined> => {
			const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

			if (document === undefined || !CODE.test(document.uri.path)) {
				return undefined;
			}

			const { version } = document;
			const found = await span("look", { "path": document.uri.path }, async () => look(document));

			// (edited while it looked, a newer look follows; not parsing, they stay where they're shown)
			if (found !== undefined && document.version === version) {
				landed.set(document.uri.toString(), found);
				diagnostics.set(document.uri, found.filter(({ line }) => line === undefined).map((each) => lostProblem(document, each)));
			}

			const items = await Promise.all((landed.get(document.uri.toString()) ?? []).map(async (each) => itemOf(document.uri.toString(), each)));

			return items.flat().length === 0 ? undefined : { "items": items.flat() };
		}),
		vscode.commands.registerCommand("notes.add", async (given?: unknown) => {
			const editor = vscode.window.activeTextEditor;

			if (editor === undefined || !CODE.test(editor.document.uri.path)) {
				void vscode.window.showInformationMessage("Open the code the note is about first.");

				return undefined;
			}

			const { document, selection } = editor;
			const body = typeof given === "string" ? given : await vscode.window.showInputBox({ "title": "Add note", "prompt": "On the code selected, or this line", "placeHolder": "What should anyone reading this code know?" });

			if (body === undefined || body.trim() === "") {
				return undefined;
			}

			return span("add", { "path": document.uri.path, "bytes": body.length }, async () => {
				const ref = await referAt(document, selection);

				if (typeof ref === "string") {
					void vscode.window.showInformationMessage(ref);

					return undefined;
				}

				const now = new Date().toISOString();
				const note: Note = { "id": crypto.randomUUID(), "kind": "note", "ref": ref, "payload": { "text": body.trim() }, "author": await me(), "createdAt": now, "updatedAt": now };

				await save(relative(document.uri), note);
				await redraw(document.uri.toString());

				return note.id;
			});
		}),
		vscode.commands.registerCommand("notes.dismiss", async (id: string, uri: string) => {
			const note = await yours(id, uri);

			if (note !== undefined) {
				await span("dismiss", { "path": uri }, async () => save(relative(vscode.Uri.parse(uri)), { ...note, "dismissed": true, "updatedAt": new Date().toISOString() }));
				await redraw(uri);
			}
		}),
		// Kept where it's shown, or put back where the cursor is.
		vscode.commands.registerCommand("notes.place", async (id: string, uri: string, line: number) => {
			const note = await yours(id, uri);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));

			if (note !== undefined) {
				const ref = await referAt(document, new vscode.Selection(line, 0, line, 0));

				if (typeof ref === "string") {
					void vscode.window.showInformationMessage(ref);

					return;
				}

				await span("place", { "path": uri, "count": line }, async () => save(relative(document.uri), { ...note, "ref": ref, "placed": { "strategy": "by hand", "score": 1 }, "updatedAt": new Date().toISOString() }));
				await redraw(uri);
			}
		}),
		vscode.languages.registerCodeActionsProvider(LANGUAGES.map((language) => ({ "language": language, "scheme": "file" })), {
			"provideCodeActions": async (document, range) => {
				const uri = document.uri.toString();
				const you = await me();
				const action = (title: string, command: string, ...args: unknown[]): vscode.CodeAction => {
					const made = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					made.command = { "title": title, "command": command, "arguments": args };

					return made;
				};
				const line = range.start.line;

				return [
					...range.isEmpty ? [] : [action("Add note on this code", "notes.add")],
					...(landed.get(uri) ?? []).filter(({ owner }) => owner === you).flatMap(({ note, line: on }) => [
						...on === undefined ? [action(`Put the note back here: ${shortly(note)}`, "notes.place", note.id, uri, line)] : [],
						...on === undefined || on === line ? [action(`Dismiss note: ${shortly(note)}`, "notes.dismiss", note.id, uri)] : []
					])
				];
			}
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] })
	);

	// (it asked before this command was there)
	void redraw();
}
