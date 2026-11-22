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
import { commentAt } from "./comments";

type Note = Annotation<{ "text": string; "wrote"?: string[] }>;

interface Landing { "note": Note; "owner": string; "resolved": Resolved; "line"?: number }

const VIEW = "notes";
const REPOSITORY = "repository";
const CODE = /\.[cm]?[jt]sx?$/u;
const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

const textOf = ({ payload }: Note): string => payload?.text ?? "";

const shortly = (note: Note): string => {
	const text = textOf(note);

	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension(VIEW, vscode);
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const diagnostics = vscode.languages.createDiagnosticCollection(VIEW);
	const landed = new Map<string, Landing[]>();
	const read = async (uri: vscode.Uri): Promise<string> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");
	const write = async (uri: vscode.Uri, text: string): Promise<void> => {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	};
	const relative = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, false);

	let user: string | undefined;
	const me = async (): Promise<string> => {
		user ??= userSlug(await read(vscode.Uri.joinPath(root, ".git/config")));

		return user ?? "local";
	};

	const notesOn = async (file: string): Promise<{ "note": Note; "owner": string }[]> => {
		const folder = vscode.Uri.joinPath(root, SILO_DIR, VIEW);
		const owners = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => [] as string[]);
		const found = await Promise.all(owners.map(async (owner) => (parseAnnotations(await read(vscode.Uri.joinPath(folder, owner, `${file}.jsonl`))) as Note[]).map((note) => ({ "note": note, "owner": owner }))));

		return found.flat().filter(({ note }) => note.dismissed !== true);
	};

	const mine = (owner: string, you: string): boolean => owner === you || owner === REPOSITORY;

	const save = async (file: string, note: Note, owner?: string): Promise<void> => {
		const uri = vscode.Uri.joinPath(root, annotationsPath(VIEW, owner ?? await me(), file));
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

			if (mine(owner, you) && resolved.ref !== undefined && at !== undefined) {
				if (resolved.status === "moved" && at.file !== file) {
					await save(file, { ...note, "dismissed": true, "updatedAt": now }, owner);
					await save(at.file, { ...note, "ref": resolved.ref, "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": now }, owner);
				} else if (resolved.status === "re-placed" && here) {
					await save(file, { ...note, "ref": resolved.ref, "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": now }, owner);
				}
			}

			return { "note": note, "owner": owner, "resolved": resolved, ...here ? { "line": document.positionAt(at.start ?? 0).line } : {} };
		}));
	};

	const lostProblem = (document: vscode.TextDocument, { note, owner, resolved }: Landing): vscode.Diagnostic => {
		const near = document.positionAt(Math.min(note.ref.baseline?.start ?? 0, document.getText().length));
		const elsewhere = resolved.status === "moved" ? resolved.candidate?.file : undefined;
		const problem = new vscode.Diagnostic(document.lineAt(near.line).range, elsewhere === undefined ? `A note lost its place: "${textOf(note)}". Put the cursor on the code it's about: the lightbulb puts it back, or dismisses it.` : `A note's code moved to ${elsewhere}: "${textOf(note)}". It moves there when ${owner === REPOSITORY ? "this file is next opened" : `${owner} next opens this file`}.`, vscode.DiagnosticSeverity.Information);

		problem.source = VIEW;

		return problem;
	};

	const itemOf = async (uri: string, { note, owner, resolved, line }: Landing): Promise<PaneItem[]> => {
		if (line === undefined) {
			return [];
		}

		const by = mine(owner, await me()) ? "" : `**${owner}:** `;
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

	const yours = async (id: string, uri: string): Promise<{ "note": Note; "owner": string } | undefined> => {
		const you = await me();

		return landed.get(uri)?.find(({ note, owner }) => note.id === id && mine(owner, you));
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/${VIEW}/**/*.jsonl`);
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
		vscode.workspace.onDidSaveTextDocument(changed),
		vscode.commands.registerCommand("notes.on", async (path: unknown): Promise<{ "line"?: number; "text": string; "by": string; "status": Resolved["status"] }[]> => {
			const uri = vscode.Uri.joinPath(root, String(path).replace(/^\/workspace\//u, ""));

			if (!CODE.test(uri.path) || (await notesOn(relative(uri))).length === 0) {
				return [];
			}

			const found = await span("look", { "path": uri.path }, async () => look(await vscode.workspace.openTextDocument(uri))) ?? landed.get(uri.toString()) ?? [];

			return found.map(({ note, owner, resolved, line }) => ({ ...line === undefined ? {} : { "line": line + 1 }, "text": textOf(note), "by": owner, "status": resolved.status }));
		}),
		vscode.commands.registerCommand("notes.paneView", async (uri: unknown): Promise<PaneContent | undefined> => {
			const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

			if (document === undefined || !CODE.test(document.uri.path)) {
				return undefined;
			}

			const { version } = document;
			const found = await span("look", { "path": document.uri.path }, async () => look(document));

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
		vscode.commands.registerCommand("notes.fromComment", async (given?: unknown, at?: unknown) => {
			const editor = vscode.window.activeTextEditor;
			const document = typeof given === "string" ? await vscode.workspace.openTextDocument(vscode.Uri.parse(given)) : editor?.document;

			if (document === undefined || !CODE.test(document.uri.path)) {
				void vscode.window.showInformationMessage("Open the code the comment is in first.");

				return undefined;
			}

			const lines = document.getText().split("\n");
			const comment = commentAt(lines, typeof at === "number" ? at : editor?.selection.active.line ?? 0);

			if (comment === undefined) {
				void vscode.window.showInformationMessage("There's no comment here a note can take: put the cursor in a comment on its own lines, above the code it's about (one for a tool, an eslint-disable or a license, stays a comment).");

				return undefined;
			}

			const file = relative(document.uri);

			return span("fromComment", { "path": file, "count": comment.to - comment.from + 1 }, async () => {
				// (a comment beside code leaves its line, less the comment; one on lines of its own, those lines)
				const kept = comment.column === undefined ? undefined : lines[comment.from]!.slice(0, comment.column).trimEnd();
				const after = kept === undefined ? [...lines.slice(0, comment.from), ...lines.slice(comment.to + 1)] : lines.map((each, at) => (at === comment.from ? kept : each));
				const on = kept === undefined ? comment.below - (comment.to - comment.from + 1) : comment.from;
				const start = after.slice(0, on).reduce((sum, each) => sum + each.length + 1, 0);
				const code = after[on]!;
				const answer = await annotations(vscode.commands).refer(after.join("\n"), file, [{ "start": start + (code.length - code.trimStart().length), "end": start + code.trimEnd().length }]);
				const ref = "value" in answer ? answer.value[0] : undefined;

				if (ref === undefined) {
					void vscode.window.showInformationMessage(`A note can't attach to the code below this comment${"unparsable" in answer ? `: this file can't be parsed as it is (${answer.unparsable})` : "unavailable" in answer ? `: the editor's BABLR isn't available (${answer.unavailable})` : ""}.`);

					return undefined;
				}

				// (a `//` line inside a string or a template — code carried as text, an embedded page's script — reads as a
				// comment line by line, and what's below it is the string's: not a comment, nothing a note can stand on)
				if (/String|Template/u.test(ref.shape?.type ?? "")) {
					void vscode.window.showInformationMessage("That's inside a string, not a comment: it's left as it is.");

					return undefined;
				}

				const wrote = await Promise.resolve(vscode.commands.executeCommand<string[]>("editor.git.authorsOf", file, comment.from + 1, comment.to + 1)).then((authors) => (Array.isArray(authors) ? authors : []), () => []);
				const edit = new vscode.WorkspaceEdit();

				edit.delete(document.uri, kept === undefined ? new vscode.Range(comment.from, 0, comment.to + 1, 0) : new vscode.Range(comment.from, kept.length, comment.from, lines[comment.from]!.length));

				if (!await vscode.workspace.applyEdit(edit)) {
					return undefined;
				}

				const now = new Date().toISOString();
				const note: Note = { "id": crypto.randomUUID(), "kind": "note", "ref": ref, "payload": { "text": comment.text, ...wrote.length === 0 ? {} : { "wrote": wrote } }, "author": await me(), "createdAt": now, "updatedAt": now };

				await save(file, note, REPOSITORY);
				await redraw(document.uri.toString());

				return note.id;
			});
		}),
		vscode.commands.registerCommand("notes.dismiss", async (id: string, uri: string) => {
			const found = await yours(id, uri);

			if (found !== undefined) {
				await span("dismiss", { "path": uri }, async () => save(relative(vscode.Uri.parse(uri)), { ...found.note, "dismissed": true, "updatedAt": new Date().toISOString() }, found.owner));
				await redraw(uri);
			}
		}),
		vscode.commands.registerCommand("notes.place", async (id: string, uri: string, line: number) => {
			const found = await yours(id, uri);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));

			if (found !== undefined) {
				const ref = await referAt(document, new vscode.Selection(line, 0, line, 0));

				if (typeof ref === "string") {
					void vscode.window.showInformationMessage(ref);

					return;
				}

				await span("place", { "path": uri, "count": line }, async () => save(relative(document.uri), { ...found.note, "ref": ref, "placed": { "strategy": "by hand", "score": 1 }, "updatedAt": new Date().toISOString() }, found.owner));
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
				const comment = commentAt(document.getText().split("\n"), line);

				return [
					...range.isEmpty ? [] : [action("Add note on this code", "notes.add")],
					...comment === undefined ? [] : [action("Make this comment a note", "notes.fromComment", uri, comment.from)],
					...(landed.get(uri) ?? []).filter(({ owner }) => mine(owner, you)).flatMap(({ note, line: on }) => [
						...on === undefined ? [action(`Put the note back here: ${shortly(note)}`, "notes.place", note.id, uri, line)] : [],
						...on === undefined || on === line ? [action(`Dismiss note: ${shortly(note)}`, "notes.dismiss", note.id, uri)] : []
					])
				];
			}
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] })
	);

	void redraw();
}
