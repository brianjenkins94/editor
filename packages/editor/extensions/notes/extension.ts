/**
 * Notes on code that stay with it — the first authored kind of durable span annotation (SPAN-ANNOTATIONS.md).
 *
 * A note is kept on the BABLR span it's about, in `.silo/notes/<author>/<file>.jsonl` (silo's annotations layout, in
 * git, everyone's notes beside everyone else's). Each time a file is shown or changes, each note on it is resolved
 * against the text as it is now — by the editor's BABLR, through worker-pod's `editor.annotations.resolve` — and lands:
 *
 *  - on its own span, or followed to it (its code moved or was edited): shown inline, as a comment thread. A note of
 *    yours found any way but its own id is rewritten where it landed, so the next look finds it by id — and one whose
 *    code moved to another (changed, saved) file goes with it; anyone else's waits in Problems, pointing there;
 *  - on a span it probably moved to (`uncertain`): shown there, marked, with Keep Note Here and Re-place;
 *  - nowhere (its code went): kept, and shown in the Problems view at its last place, with Re-place and Dismiss.
 *
 * Dismissing writes a tombstone, so a branch merge can't bring the note back. Only a note's author changes it. Public
 * API only: everything it knows of the code comes from the editor's BABLR, through commands.
 */
import type { Resolved } from "@brianjenkins94/run-contract/annotations";
import { annotations } from "@brianjenkins94/run-contract/annotations";
import type { Annotation, SpanRef } from "@brianjenkins94/util/silo/annotations";
import { annotationsPath, annotationsText, parseAnnotations } from "@brianjenkins94/util/silo/annotations";
import { GITATTRIBUTES, parseEvidence, SILO_DIR, userSlug } from "@brianjenkins94/util/silo/evidence";
import * as vscode from "vscode";

type Note = Annotation<{ "text": string }>;

const COLLECTION = "notes";
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
/** How long to wait after typing stops before resolving a file's notes again (BABLR re-reads the whole file). */
const SETTLE_MS = 600;

export function activate(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const controller = vscode.comments.createCommentController("notes", "Notes");
	const diagnostics = vscode.languages.createDiagnosticCollection("notes");
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	/** What each shown thread and each lost note's diagnostic stands for. */
	const shown = new WeakMap<vscode.CommentThread, { "note": Note; "owner": string; "resolved": Resolved }>();
	const lost = new Map<string, { "note": Note; "owner": string }>();
	const threads = new Map<string, vscode.CommentThread[]>();
	/** The note waiting to be placed by hand (Re-place Note…, then Place Note Here). */
	let pending: { "note": Note; "file": string } | undefined;

	status.command = "notes.placeHere";
	status.text = "$(pin) Place note here";
	status.tooltip = "Attach the note you're re-placing to the selected code";

	let user: Promise<string> | undefined;
	// Who you are to git: a slug of the repo config's user (silo's userSlug), `local` until it says.
	const me = async (): Promise<string> => {
		user ??= Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".git/config"))).then((bytes) => userSlug(new TextDecoder().decode(bytes)) ?? "local", () => "local");

		return user;
	};

	const relative = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, false);
	const text = async (uri: vscode.Uri): Promise<string> => vscode.workspace.fs.readFile(uri).then((bytes) => new TextDecoder().decode(bytes), () => "");

	/** Everyone's notes on `file`, with who wrote each: `.silo/notes/<author>/<file>.jsonl`, read where the layout puts
	 *  them (one folder per author) rather than searched for. */
	const notesOn = async (file: string): Promise<{ "note": Note; "owner": string }[]> => {
		const folder = vscode.Uri.joinPath(root, `${SILO_DIR}/${COLLECTION}`);
		const owners = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => [] as string[]);
		const found: { "note": Note; "owner": string }[] = [];

		for (const owner of owners) {
			for (const note of parseAnnotations(await text(vscode.Uri.joinPath(folder, owner, `${file}.jsonl`))) as Note[]) {
				found.push({ "note": note, "owner": owner });
			}
		}

		return found;
	};

	/** Write `note` (yours) into your notes on `file`: added, or replacing the version there. */
	const save = async (file: string, note: Note): Promise<void> => {
		const uri = vscode.Uri.joinPath(root, annotationsPath(COLLECTION, await me(), file));
		const kept = parseAnnotations(await text(uri)).filter((other) => other.id !== note.id);
		const attributes = vscode.Uri.joinPath(root, `${SILO_DIR}/.gitattributes`);
		const existing = await text(attributes);

		// Notes merge line by line across branches, like the rest of silo's JSONL.
		if (!existing.split("\n").includes(GITATTRIBUTES.trim())) {
			await vscode.workspace.fs.writeFile(attributes, new TextEncoder().encode((existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + GITATTRIBUTES));
		}

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(annotationsText([...kept, note])));
	};

	const comment = (note: Note, owner: string): vscode.Comment => ({ "body": new vscode.MarkdownString(note.payload?.text ?? ""), "mode": vscode.CommentMode.Preview, "author": { "name": owner } });

	/** What TypeScript makes of each of `ranges` in `document` (the capabilities tsserver plugin's `_types.at`); null
	 *  where it can't say, all of them when there's no such plugin. */
	const typesAt = async (document: vscode.TextDocument, ranges: { "start": number; "end": number }[]): Promise<(string | null)[]> => {
		if (ranges.length === 0) {
			return [];
		}

		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "types"?: (string | null)[] } } | undefined>("typescript.tsserverRequest", "_types.at", { "file": document.uri, "ranges": ranges })).catch(() => undefined);

		return ranges.map((_, index) => response?.body?.types?.[index] ?? null);
	};

	/** The type tags runs observed at each span of `file` that's a value site (RUNTIME-EVIDENCE.md): every user's runs
	 *  in every environment, `.silo/evidence/<user>/<environment>/<file>.jsonl`, read where the layout puts them. */
	const observedOf = async (file: string): Promise<Map<string, string[]>> => {
		const folder = vscode.Uri.joinPath(root, `${SILO_DIR}/evidence`);
		const folders = async (uri: vscode.Uri): Promise<string[]> => Promise.resolve(vscode.workspace.fs.readDirectory(uri)).then((entries) => entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name), () => []);
		const tags = new Map<string, Set<string>>();

		for (const user of await folders(folder)) {
			for (const environment of await folders(vscode.Uri.joinPath(folder, user))) {
				for (const observation of parseEvidence(await text(vscode.Uri.joinPath(folder, user, environment, `${file}.jsonl`)))) {
					if (observation.kind === "value") {
						tags.set(observation.span, new Set([...tags.get(observation.span) ?? [], ...Object.keys(observation.tags)]));
					}
				}
			}
		}

		return new Map([...tags].map(([span, kinds]) => [span, [...kinds].sort()]));
	};

	/** `ref`, made in `document`, with what its span is beyond its shape — TypeScript's type, and the kinds of value runs
	 *  saw go through it — the typed strategy's signals for finding it again. */
	const withType = async (ref: SpanRef, document: vscode.TextDocument): Promise<SpanRef> => {
		const [inferred] = ref.baseline === undefined ? [null] : await typesAt(document, [{ "start": ref.baseline.start, "end": ref.baseline.end }]);
		const observed = (await observedOf(ref.file)).get(ref.span);
		// Untyped code (`any`, `unknown`) says nothing about what the span is: not kept.
		const { "inferred": _inferred, "observed": _observed, ...bare } = ref;

		return { ...bare, ...inferred === null || inferred === "any" || inferred === "unknown" ? {} : { "inferred": inferred }, ...observed === undefined ? {} : { "observed": observed } };
	};

	/** Resolve every note on `document` against its text now, and show each where it landed. */
	const show = async (document: vscode.TextDocument): Promise<void> => {
		if (document.uri.scheme !== "file" || !CODE_FILE.test(document.uri.path)) {
			return;
		}

		const file = relative(document.uri);
		const version = document.version;
		const source = document.getText();
		const notes = (await notesOn(file)).filter(({ note }) => note.dismissed !== true);
		const resolve = async (refs: SpanRef[], types?: Record<string, { "inferred"?: string; "observed"?: string[] }>): Promise<Resolved[] | undefined> => annotations(vscode.commands).resolve(source, file, refs, types === undefined ? {} : { "types": types });
		const resolutions = await resolve(notes.map(({ note }) => note.ref)) ?? [];
		// A note found only by its shape (asked about, or lost) that knows what its span was — its type, the kinds of value
		// runs saw there — is looked for again with the same of the places it might be: the typed strategy lifts the one
		// that matches, and lowers the ones that don't.
		const unsure = notes.map((_, index) => index).filter((index) => (notes[index].note.ref.inferred !== undefined || notes[index].note.ref.observed !== undefined) && (resolutions[index]?.status === "uncertain" || resolutions[index]?.status === "orphaned"));
		const places = [...new Map(unsure.flatMap((index) => [resolutions[index]?.candidate, ...resolutions[index]?.alternatives ?? []]).flatMap((found) => (found?.start === undefined || found.end === undefined || found.file !== file ? [] : [[found.span, { "start": found.start, "end": found.end }] as const]))).entries()];

		if (places.length > 0) {
			const inferred = await typesAt(document, places.map(([, range]) => range));
			const observed = await observedOf(file);
			const types = Object.fromEntries(places.map(([span], index) => [span, { ...inferred[index] === null ? {} : { "inferred": inferred[index]! }, ...observed.has(span) ? { "observed": observed.get(span) } : {} }]));
			const again = await resolve(unsure.map((index) => notes[index].note.ref), types);

			unsure.forEach((index, at) => { resolutions[index] = again?.[at] ?? resolutions[index]; });
		}

		const landed = notes.map(({ note, owner }, index) => ({ "note": note, "owner": owner, "resolved": resolutions[index] ?? { "status": "orphaned" as const, "alternatives": [] } }));

		if (document.version !== version) {
			return; // edited while resolving: a newer look follows
		}

		for (const thread of threads.get(document.uri.toString()) ?? []) {
			thread.dispose();
		}

		const fresh: vscode.CommentThread[] = [];
		const orphans: vscode.Diagnostic[] = [];
		const you = await me();

		for (const { note, owner, resolved } of landed) {
			const at = resolved.candidate;

			// Its code moved to another file: a note of yours goes with it (a tombstone here, the note in that file's
			// notes); anyone else's waits here, pointing there, until its author next looks.
			if (resolved.status === "moved" && at?.start !== undefined && at.end !== undefined && at.file !== file) {
				if (owner === you && resolved.ref !== undefined) {
					await save(file, { ...note, "dismissed": true, "updatedAt": new Date().toISOString() });
					await save(at.file, { ...note, "ref": resolved.ref, "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": new Date().toISOString() });

					continue;
				}

				const there = vscode.Uri.joinPath(root, at.file);
				const target = await vscode.workspace.openTextDocument(there).then((opened) => new vscode.Range(opened.positionAt(at.start!), opened.positionAt(at.end!)), () => new vscode.Range(0, 0, 0, 0));
				const near = document.positionAt(Math.min(note.ref.baseline?.start ?? 0, source.length));
				const diagnostic = new vscode.Diagnostic(document.lineAt(near.line).range, `A note's code moved to ${at.file}: "${note.payload?.text ?? ""}" — it moves there when ${owner} next opens this file.`, vscode.DiagnosticSeverity.Information);

				diagnostic.source = "notes";
				diagnostic.code = note.id;
				diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(there, target), "Its code, now")];
				orphans.push(diagnostic);
				lost.set(note.id, { "note": note, "owner": owner });

				continue;
			}

			if (resolved.status === "orphaned" || at?.start === undefined || at.end === undefined || at.file !== file) {
				const near = document.positionAt(Math.min(note.ref.baseline?.start ?? 0, source.length));
				const diagnostic = new vscode.Diagnostic(document.lineAt(near.line).range, `A note lost its place: "${note.payload?.text ?? ""}" — re-place it on the code it's about, or dismiss it.`, vscode.DiagnosticSeverity.Information);

				diagnostic.source = "notes";
				diagnostic.code = note.id;
				orphans.push(diagnostic);
				lost.set(note.id, { "note": note, "owner": owner });

				continue;
			}

			const thread = controller.createCommentThread(document.uri, new vscode.Range(document.positionAt(at.start), document.positionAt(at.end)), [comment(note, owner)]);

			thread.canReply = false;
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			thread.contextValue = resolved.status === "uncertain" ? "note-uncertain" : "note";
			thread.label = resolved.status === "uncertain" ? `Moved here? (${at.strategy}, ${at.score.toFixed(2)})` : resolved.status === "re-placed" ? "Followed its code here" : undefined;
			shown.set(thread, { "note": note, "owner": owner, "resolved": resolved });
			fresh.push(thread);

			// Found by anything but its own id: a note of yours is rewritten where it landed (healed), so the next look
			// finds it by id. An uncertain one waits for you to keep it there.
			if (owner === you && resolved.status === "re-placed" && resolved.ref !== undefined) {
				await save(file, { ...note, "ref": await withType(resolved.ref, document), "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": new Date().toISOString() });
			}
		}

		threads.set(document.uri.toString(), fresh);
		diagnostics.set(document.uri, orphans);
	};

	const showAll = (): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			void show(editor.document);
		}
	};

	/** The note a command was given: a thread's, a lost note's (its id), or the one being placed. */
	const noteOf = (arg: unknown): { "note": Note; "owner": string; "resolved"?: Resolved } | undefined => {
		if (typeof arg === "string") {
			return lost.get(arg);
		}

		return arg !== null && typeof arg === "object" ? shown.get(arg as vscode.CommentThread) : undefined;
	};

	/** A note you may change: yours. */
	const yours = async (found: { "note": Note; "owner": string } | undefined): Promise<Note | undefined> => {
		if (found === undefined) {
			return undefined;
		}

		if (found.owner !== await me()) {
			void vscode.window.showInformationMessage(`Only ${found.owner} can change this note.`);

			return undefined;
		}

		return found.note;
	};

	let typing: ReturnType<typeof setTimeout> | undefined;
	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/${COLLECTION}/**/*.jsonl`);

	context.subscriptions.push(controller, diagnostics, status, watcher,
		vscode.commands.registerCommand("notes.add", async (textArg?: unknown) => {
			const editor = vscode.window.activeTextEditor;

			if (editor === undefined || editor.selection.isEmpty) {
				void vscode.window.showInformationMessage("Select the code the note is about first.");

				return undefined;
			}

			const body = typeof textArg === "string" ? textArg : await vscode.window.showInputBox({ "prompt": "Note", "placeHolder": "What should anyone reading this code know?" });

			if (body === undefined || body.trim() === "") {
				return undefined;
			}

			const file = relative(editor.document.uri);
			const [ref] = await annotations(vscode.commands).refer(editor.document.getText(), file, [{ "start": editor.document.offsetAt(editor.selection.start), "end": editor.document.offsetAt(editor.selection.end) }]) ?? [];

			if (ref === undefined) {
				void vscode.window.showInformationMessage("A note needs BABLR to understand this file, and it can't parse it yet.");

				return undefined;
			}

			const now = new Date().toISOString();
			const note: Note = { "id": crypto.randomUUID(), "kind": "note", "ref": await withType(ref, editor.document), "payload": { "text": body.trim() }, "author": await me(), "createdAt": now, "updatedAt": now };

			await save(file, note);
			await show(editor.document);

			return note.id;
		}),
		vscode.commands.registerCommand("notes.dismiss", async (arg: unknown) => {
			const note = await yours(noteOf(arg));

			if (note !== undefined) {
				await save(note.ref.file, { ...note, "dismissed": true, "updatedAt": new Date().toISOString() });
				lost.delete(note.id);
				showAll();
			}
		}),
		vscode.commands.registerCommand("notes.confirm", async (arg: unknown) => {
			const found = noteOf(arg);
			const note = await yours(found);
			const at = found?.resolved?.candidate;

			if (note !== undefined && found?.resolved?.ref !== undefined && at !== undefined) {
				const document = vscode.workspace.textDocuments.find((open) => relative(open.uri) === found.resolved!.ref!.file);

				await save(note.ref.file, { ...note, "ref": document === undefined ? found.resolved.ref : await withType(found.resolved.ref, document), "placed": { "strategy": at.strategy, "score": at.score }, "updatedAt": new Date().toISOString() });
				showAll();
			}
		}),
		vscode.commands.registerCommand("notes.replace", async (arg: unknown) => {
			const note = await yours(noteOf(arg));

			if (note !== undefined) {
				pending = { "note": note, "file": note.ref.file };
				status.show();
				void vscode.window.showInformationMessage("Select the code this note is about, then choose Place note here in the status bar.");
			}
		}),
		vscode.commands.registerCommand("notes.placeHere", async () => {
			const editor = vscode.window.activeTextEditor;

			if (pending === undefined || editor === undefined || editor.selection.isEmpty) {
				return;
			}

			const file = relative(editor.document.uri);
			const [ref] = await annotations(vscode.commands).refer(editor.document.getText(), file, [{ "start": editor.document.offsetAt(editor.selection.start), "end": editor.document.offsetAt(editor.selection.end) }]) ?? [];

			if (ref !== undefined) {
				const { note } = pending;

				// Placed in another file: it leaves the old file's notes (a tombstone there) and joins this one's.
				if (file !== pending.file) {
					await save(pending.file, { ...note, "dismissed": true, "updatedAt": new Date().toISOString() });
				}

				await save(file, { ...note, "ref": await withType(ref, editor.document), "placed": { "strategy": "by hand", "score": 1 }, "updatedAt": new Date().toISOString() });
				lost.delete(note.id);
				pending = undefined;
				status.hide();
				showAll();
			}
		}),
		// A lost note's two ways out, on its diagnostic.
		vscode.languages.registerCodeActionsProvider({ "scheme": "file" }, {
			"provideCodeActions": (_document, _range, context) => context.diagnostics.filter((diagnostic) => diagnostic.source === "notes").flatMap((diagnostic) => {
				const id = String(diagnostic.code);
				const replace = new vscode.CodeAction("Re-place note…", vscode.CodeActionKind.QuickFix);
				const dismiss = new vscode.CodeAction("Dismiss note", vscode.CodeActionKind.QuickFix);

				replace.command = { "command": "notes.replace", "title": "Re-place note…", "arguments": [id] };
				replace.diagnostics = [diagnostic];
				dismiss.command = { "command": "notes.dismiss", "title": "Dismiss note", "arguments": [id] };
				dismiss.diagnostics = [diagnostic];

				return [replace, dismiss];
			})
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] }),
		vscode.window.onDidChangeVisibleTextEditors(showAll),
		// Saved: code moved into this file is on disk now, where a note that lost its place elsewhere looks for it.
		vscode.workspace.onDidSaveTextDocument(showAll),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				clearTimeout(typing);
				typing = setTimeout(() => { void show(event.document); }, SETTLE_MS);
			}
		}),
		// Notes changed underneath (a pull, a teammate's merge, another window).
		watcher.onDidChange(showAll), watcher.onDidCreate(showAll), watcher.onDidDelete(showAll)
	);

	showAll();
}
