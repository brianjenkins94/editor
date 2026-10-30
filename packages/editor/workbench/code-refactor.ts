/**
 * Refactoring as the editor does it, for agents (NEXT.md item 2, step (c)): `code.references`, `code.rename` and
 * `code.move`, on VS Code's providers — the TypeScript server's answers — and its WorkspaceEdits, so an open editor,
 * undo and the edit history see each change as typing, and every file it touches is saved (workspace-tools.ts
 * `saveDocument`). Their readers: agents' `code_references`, `code_rename` and `code_move`.
 *
 * - `code.references` { path, line, name }: where the name on that line (1-based) is used, each place's file, line,
 *   column and line of text, its declaration included.
 * - `code.rename` { path, line, name, to }: the rename TypeScript makes of it, everywhere it's used.
 * - `code.query` { pattern, paths? }: where a structural pattern matches (`$X` one node, `$$$` a run of a list:
 *   extensions/history/patterns.ts), in the files TypeScript's projects hold — each match's place, text and bindings.
 * - `code.rewrite` { pattern, replace, paths?, preview? }: each outermost match replaced by `replace`, its metavariables
 *   filled in, as one edit (every file saved), or with `preview` the diff it would make.
 * - `code.move` { from, to }: a file moved, with every import of it and its own relative imports changed to match —
 *   TypeScript's edits for the move (history's tsserver plugin, `_history.fileRename`), applied with the move as one
 *   WorkspaceEdit, so nothing asks first (VS Code's own update on a move prompts by default).
 *
 * A file is asked its symbols first, so the TypeScript server holds its project (opening a document doesn't hand it
 * to the server in the browser), the projects told first of the files made since (ts-projects.ts).
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import type { TypeScriptProjects } from "./ts-projects";
import { serve } from "@brianjenkins94/hub";
import { unifiedDiff } from "./git-service";
import { saveDocument } from "./workspace-tools";

const ROOT = "/workspace";

/** The places `code.references` and `code.query` list at most (`total` is all of them). */
const LISTED = 500;

/** How often, and how far apart, history's plugin is asked while its engine is still loading. */
const TRIES = 5;
const TRY_MS = 1500;

/** What history's plugin answers of a structural pattern (`_history.query`). */
interface Queried {
	"ready"?: boolean;
	"error"?: string;
	"searched"?: number;
	"files"?: { "file": string; "matches": { "line": number; "column": number; "text": string; "bindings": Record<string, string> }[]; "edits"?: { "start": number; "end": number; "text": string }[] }[];
}

/** A place in a file: its 1-based line and column, and that line's text. */
interface Place { "file": string; "line": number; "column": number; "text": string }

export function installCodeRefactor(vscode: typeof vscodeApi, hub: Hub, projects: TypeScriptProjects): void {
	const uriOf = (path: unknown): vscodeApi.Uri => {
		if (typeof path !== "string" || path === "") {
			throw new TypeError("a path, relative to the workspace or absolute under it");
		}

		const absolute = path.startsWith("/") ? path : `${ROOT}/${path}`;

		if (absolute !== ROOT && !absolute.startsWith(ROOT + "/")) {
			throw new Error(`${path} is outside the workspace`);
		}

		return vscode.Uri.file(absolute);
	};
	const relative = (uri: vscodeApi.Uri): string => (uri.path.startsWith(ROOT + "/") ? uri.path.slice(ROOT.length + 1) : uri.path);
	const held = async (uri: vscodeApi.Uri): Promise<void> => {
		await projects.refresh();
		await Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)).catch(() => undefined);
	};

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

	/** Apply `edit` and save every file it touched; the files, by workspace path. */
	const applyAndSaveAll = async (edit: vscodeApi.WorkspaceEdit, saving: vscodeApi.Uri[]): Promise<string[]> => {
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error("VS Code didn't apply the edit");
		}

		const files = [...new Map(saving.map((uri) => [uri.toString(), uri])).values()];

		for (const uri of files) {
			await saveDocument(await vscode.workspace.openTextDocument(uri), relative(uri));
		}

		return files.map(relative);
	};

	serve(hub, "code.references", async (args) => {
		const { document, position, name } = await at(args);
		const found = await Promise.resolve(vscode.commands.executeCommand<vscodeApi.Location[] | undefined>("vscode.executeReferenceProvider", document.uri, position)) ?? [];
		const texts = new Map<string, vscodeApi.TextDocument>();
		const places: Place[] = [];

		for (const location of found.slice(0, LISTED)) {
			const key = location.uri.toString();
			const text = texts.get(key) ?? await vscode.workspace.openTextDocument(location.uri);

			texts.set(key, text);
			places.push({ "file": relative(location.uri), "line": location.range.start.line + 1, "column": location.range.start.character + 1, "text": text.lineAt(location.range.start.line).text.trim().slice(0, 200) });
		}

		return { "name": name, "places": places, "total": found.length };
	});

	serve(hub, "code.rename", async (args) => {
		const { to } = (args ?? {}) as { "to"?: unknown };

		if (typeof to !== "string" || to === "") {
			throw new TypeError("code.rename takes { path, line, name, to }: the new name");
		}

		const { document, position, name } = await at(args);
		const edit = await Promise.resolve(vscode.commands.executeCommand<vscodeApi.WorkspaceEdit | undefined>("vscode.executeDocumentRenameProvider", document.uri, position, to));

		if (edit === undefined || edit.size === 0) {
			throw new Error(`TypeScript has no rename of ${name} there`);
		}

		const changes = edit.entries().reduce((total, [, edits]) => total + edits.length, 0);

		return { "renamed": name, "to": to, "changes": changes, "files": await applyAndSaveAll(edit, edit.entries().map(([uri]) => uri)) };
	});

	/** history's plugin's answer for a structural pattern (asked again while its engine loads); throws on its error. */
	const queried = async (args: { "pattern": string; "paths"?: unknown; "replace"?: string }): Promise<Required<Pick<Queried, "files" | "searched">>> => {
		await projects.refresh();

		const ask = async (): Promise<Queried | undefined> => (await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Queried } | undefined>("typescript.tsserverRequest", "_history.query", args)).catch(() => undefined))?.body;
		let answer = await ask();

		for (let tried = 1; (answer === undefined || answer.ready === false) && answer?.error === undefined && tried < TRIES; tried += 1) {
			await new Promise((resolve) => {
				setTimeout(resolve, TRY_MS);
			});
			answer = await ask();
		}

		if (answer?.error !== undefined) {
			throw new Error(answer.error);
		}

		if (answer?.ready !== true) {
			throw new Error("the TypeScript server didn't answer (still starting): ask again shortly");
		}

		return { "files": answer.files ?? [], "searched": answer.searched ?? 0 };
	};

	serve(hub, "code.query", async (args) => {
		const { pattern, paths } = (args ?? {}) as { "pattern"?: unknown; "paths"?: unknown };

		if (typeof pattern !== "string" || pattern.trim() === "") {
			throw new TypeError("code.query takes { pattern, paths? }: code, `$X` for any one node, `$$$` for any run of a list");
		}

		const { files, searched } = await queried({ "pattern": pattern, ...Array.isArray(paths) ? { "paths": paths } : {} });
		const matches = files.flatMap(({ file, "matches": found }) => found.map((match) => ({ "file": file, ...match })));

		return { "matches": matches.slice(0, LISTED), "total": matches.length, "searched": searched };
	});

	serve(hub, "code.rewrite", async (args) => {
		const { pattern, replace, paths, preview } = (args ?? {}) as { "pattern"?: unknown; "replace"?: unknown; "paths"?: unknown; "preview"?: unknown };

		if (typeof pattern !== "string" || pattern.trim() === "" || typeof replace !== "string") {
			throw new TypeError("code.rewrite takes { pattern, replace, paths?, preview? }: the pattern, and the code each match becomes ($X for what it bound)");
		}

		const { files, searched } = await queried({ "pattern": pattern, "replace": replace, ...Array.isArray(paths) ? { "paths": paths } : {} });
		const edit = new vscode.WorkspaceEdit();
		const touched: vscodeApi.Uri[] = [];
		const diffs: string[] = [];
		let changes = 0;

		for (const { file, edits = [] } of files) {
			const uri = vscode.Uri.file(`${ROOT}/${file}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const text = document.getText();
			let after = "";
			let from = 0;

			for (const { start, end, "text": replacement } of [...edits].sort((left, right) => left.start - right.start)) {
				edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), replacement);
				after += text.slice(from, start) + replacement;
				from = end;
				changes += 1;
			}

			diffs.push(unifiedDiff(file, text, after + text.slice(from)));
			touched.push(uri);
		}

		if (preview === true || changes === 0) {
			return { "preview": preview === true, "changes": changes, "diff": diffs.join(""), "searched": searched };
		}

		return { "changes": changes, "files": await applyAndSaveAll(edit, touched), "searched": searched };
	});

	serve(hub, "code.move", async (args) => {
		const { from, to } = (args ?? {}) as { "from"?: unknown; "to"?: unknown };
		const source = uriOf(from);
		const target = uriOf(to);

		if (await Promise.resolve(vscode.workspace.fs.stat(target)).then(() => true, () => false)) {
			throw new Error(`${relative(target)} is there already`);
		}

		await held(source);

		const answer = (await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "edits"?: { "file": string; "changes": { "start": number; "length": number; "text": string }[] }[]; "outside"?: boolean; "error"?: string } } | undefined>("typescript.tsserverRequest", "_history.fileRename", { "from": source.path, "to": target.path })).catch(() => undefined))?.body;

		if (answer?.error !== undefined) {
			throw new Error(`TypeScript couldn't work out the move's edits: ${answer.error}`);
		}

		// (its importers' edits and its own, at its old path, then the move: one edit, applied in order)
		const edit = new vscode.WorkspaceEdit();
		const touched: vscodeApi.Uri[] = [];

		for (const { file, changes } of answer?.edits ?? []) {
			const uri = vscode.Uri.file(file);
			const document = await vscode.workspace.openTextDocument(uri);

			for (const change of changes) {
				edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.start + change.length)), change.text);
			}

			touched.push(uri.toString() === source.toString() ? target : uri);
		}

		edit.renameFile(source, target);

		const files = await applyAndSaveAll(edit, touched);

		return { "moved": relative(source), "to": relative(target), "updated": files.filter((file) => file !== relative(target)), ...answer === undefined || answer.outside === true ? { "unchecked": "no TypeScript project holds it: nothing that imports it was changed" } : {} };
	});
}
