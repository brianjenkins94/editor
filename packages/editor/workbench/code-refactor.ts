/**
 * Refactoring, as the editor does it (Refactoring for agents). A file moved or renamed in the Explorer keeps its imports right:
 * every import of it, and its own relative ones, changed as TypeScript works them out (history's tsserver plugin,
 * `_history.fileRename`), once the move's made and TypeScript can say, as VS Code's own TypeScript support does: worked out
 * before it, a slow start lost them (VS Code waits a minute for what a move waits on, then moves without it). And what an agent
 * asks, each the same thing a person does:
 *
 * - `code.references` { path, line, name }: Find All References on the name on that line, each place's file, line, column and
 *   text, its declaration included.
 * - `code.rename` { path, line, name, to }: Rename Symbol, everywhere TypeScript renames it, every file saved.
 * - `code.move` { from, to }: the Explorer's rename, answered once its imports are right as above, every file it touched saved.
 *
 * The projects are told of files made since first (`_history.files`), then the file asked its symbols, so the TypeScript server
 * holds its project: in the browser it isn't told of files made, and opening a document doesn't hand it over.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { saveDocument } from "./workspace-tools";

const ROOT = "/workspace";

/** The places `code.references` lists at most (`total` is all of them). */
const LISTED = 500;

/** How far apart a move's edits are asked for while TypeScript isn't answering or doesn't hold the file yet (a workspace just
 *  opened, its server still starting), and for how long before it's said that they couldn't be worked out. */
const TRY_MS = 1000;
const WAIT_MS = 180_000;

/** What history's plugin answers of a move (`_history.fileRename`). */
interface Moved { "edits"?: { "file": string; "changes": { "start": number; "length": number; "text": string }[] }[]; "outside"?: boolean; "error"?: string }

export function installCodeRefactor(vscode: typeof vscodeApi, hub: Hub, log: Observed["log"]): void {
	const uriOf = (path: unknown): vscodeApi.Uri => {
		if (typeof path !== "string" || path === "") {
			throw new TypeError("a path, relative to the workspace or absolute under it");
		}

		const absolute = path.startsWith("/") ? path : `${ROOT}/${path}`;

		if (absolute !== ROOT && !absolute.startsWith(`${ROOT}/`)) {
			throw new Error(`${path} is outside the workspace`);
		}

		return vscode.Uri.file(absolute);
	};
	const relative = (uri: vscodeApi.Uri): string => (uri.path.startsWith(`${ROOT}/`) ? uri.path.slice(ROOT.length + 1) : uri.path);
	// (the projects told of files made since, then the file asked its symbols, so the server holds its project)
	const held = async (uri: vscodeApi.Uri): Promise<void> => {
		await Promise.resolve(vscode.commands.executeCommand("typescript.tsserverRequest", "_history.files", {})).catch(() => undefined);
		await Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)).catch(() => undefined);
	};

	/** Each move's import edits under way, by the move (`from to`): what `code.move` waits on and saves. */
	const following = new Map<string, Promise<vscodeApi.Uri[]>>();

	/** Keep the imports right once `oldUri` is at `newUri`: TypeScript's edits, asked for until it can say, applied as one edit.
	 *  The files changed. */
	const follow = async (oldUri: vscodeApi.Uri, newUri: vscodeApi.Uri): Promise<vscodeApi.Uri[]> => log.span("editor.workbench.code-refactor.move", { "path": oldUri.path }, async () => {
		const deadline = Date.now() + WAIT_MS;
		let answer: Moved | undefined;

		for (let tries = 1; Date.now() < deadline && (answer === undefined || answer.outside === true); tries += 1) {
			if (tries > 1) {
				await new Promise((resolve) => {
					setTimeout(resolve, TRY_MS);
				});
			}

			await held(newUri);
			answer = (await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Moved } | undefined>("typescript.tsserverRequest", "_history.fileRename", { "from": oldUri.path, "to": newUri.path })).catch(() => undefined))?.body;
		}

		if (answer?.error !== undefined || answer === undefined || answer.outside === true) {
			log.warn("a move's import edits couldn't be worked out", { "path": oldUri.path, "error": answer?.error ?? (answer === undefined ? "TypeScript didn't answer" : "no project holds it") });

			return [];
		}

		const edit = new vscode.WorkspaceEdit();
		const touched: vscodeApi.Uri[] = [];

		for (const { file, changes } of answer.edits ?? []) {
			const uri = vscode.Uri.file(file.startsWith(`${oldUri.path}/`) || file === oldUri.path ? file.replace(oldUri.path, newUri.path) : file);
			const document = await vscode.workspace.openTextDocument(uri);

			for (const change of changes) {
				edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.start + change.length)), change.text);
			}

			touched.push(uri);
		}

		if (edit.size > 0 && !await vscode.workspace.applyEdit(edit)) {
			log.warn("a move's import edits weren't applied", { "path": oldUri.path });

			return [];
		}

		return touched;
	});

	/** Where `name` is on `line` (1-based) of `path`: the document and the position of its first character. */
	const at = async (args: unknown): Promise<{ "document": vscodeApi.TextDocument; "position": vscodeApi.Position; "name": string }> => {
		const { path, line, name } = (args ?? {}) as { "path"?: unknown; "line"?: unknown; "name"?: unknown };

		if (typeof line !== "number" || typeof name !== "string" || name === "") {
			throw new TypeError("a place is { path, line, name }: the file, a 1-based line, and the name on it");
		}

		const document = await vscode.workspace.openTextDocument(uriOf(path));

		if (line < 1 || line > document.lineCount) {
			throw new Error(`${relative(document.uri)} has ${String(document.lineCount)} lines, not ${String(line)}`);
		}

		const text = document.lineAt(line - 1).text;
		const column = new RegExp(`(?<![\\w$])${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, "u").exec(text)?.index;

		if (column === undefined) {
			throw new Error(`${relative(document.uri)}:${String(line)} has no ${name}: ${text.trim()}`);
		}

		await held(document.uri);

		return { "document": document, "position": new vscode.Position(line - 1, column), "name": name };
	};

	/** Save each of `uris` that's open with changes. */
	const saveAll = async (uris: vscodeApi.Uri[]): Promise<string[]> => {
		const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];

		for (const uri of unique) {
			await saveDocument(await vscode.workspace.openTextDocument(uri), relative(uri));
		}

		return unique.map(relative);
	};

	// The Explorer's moves and renames, and anything else's (an extension's edit, code.move): their imports kept right.
	vscode.workspace.onDidRenameFiles((event) => {
		for (const { oldUri, newUri } of event.files) {
			if (oldUri.scheme === "file" && !/\.(?:json|md|txt|css|html)$/u.test(oldUri.path)) {
				const key = `${oldUri.path} ${newUri.path}`;
				const followed = follow(oldUri, newUri).catch((error: unknown) => {
					log.warn("a move's import edits failed", { "path": oldUri.path, "error": String(error) });

					return [];
				});

				following.set(key, followed);
				void followed.finally(() => {
					if (following.get(key) === followed) {
						following.delete(key);
					}
				});
			}
		}
	});

	serve(hub, "code.references", async (args) => {
		const { document, position, name } = await at(args);
		const found = await Promise.resolve(vscode.commands.executeCommand<vscodeApi.Location[] | undefined>("vscode.executeReferenceProvider", document.uri, position)) ?? [];
		const places = await Promise.all(found.slice(0, LISTED).map(async (location) => ({ "file": relative(location.uri), "line": location.range.start.line + 1, "column": location.range.start.character + 1, "text": (await vscode.workspace.openTextDocument(location.uri)).lineAt(location.range.start.line).text.trim().slice(0, 200) })));

		return { "name": name, "places": places, "total": found.length };
	});

	serve(hub, "code.rename", async (args) => {
		const { to } = (args ?? {}) as { "to"?: unknown };

		if (typeof to !== "string" || to === "") {
			throw new TypeError("code.rename takes { path, line, name, to }: the new name");
		}

		const { document, position, name } = await at(args);

		return log.span("editor.workbench.code-refactor.rename", { "caller": "agent", "path": document.uri.path }, async () => {
			const edit = await Promise.resolve(vscode.commands.executeCommand<vscodeApi.WorkspaceEdit | undefined>("vscode.executeDocumentRenameProvider", document.uri, position, to));

			if (edit === undefined || edit.size === 0) {
				throw new Error(`TypeScript has no rename of ${name} there`);
			}

			if (!await vscode.workspace.applyEdit(edit)) {
				throw new Error("VS Code didn't apply the rename");
			}

			return { "renamed": name, "to": to, "changes": edit.entries().reduce((total, [, edits]) => total + edits.length, 0), "files": await saveAll(edit.entries().map(([uri]) => uri)) };
		});
	});

	serve(hub, "code.move", async (args) => {
		const { from, to } = (args ?? {}) as { "from"?: unknown; "to"?: unknown };
		const source = uriOf(from);
		const target = uriOf(to);

		if (await Promise.resolve(vscode.workspace.fs.stat(target)).then(() => true, () => false)) {
			throw new Error(`${relative(target)} is there already`);
		}

		const edit = new vscode.WorkspaceEdit();

		edit.renameFile(source, target);

		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error("VS Code didn't make the move");
		}

		// (its imports, once TypeScript says: the rename's own listener is under way by now)
		const updated = await saveAll(await following.get(`${source.path} ${target.path}`) ?? []);

		return { "moved": relative(source), "to": relative(target), "updated": updated.filter((file) => file !== relative(target)) };
	});
}
