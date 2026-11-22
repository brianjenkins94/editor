import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { saveDocument } from "./workspace-tools";

const ROOT = "/workspace";

const LISTED = 500;

const TRY_MS = 1000;
const WAIT_MS = 180_000;

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
	const held = async (uri: vscodeApi.Uri): Promise<void> => {
		await Promise.resolve(vscode.commands.executeCommand("typescript.tsserverRequest", "_history.files", {})).catch(() => undefined);
		await Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)).catch(() => undefined);
	};

	const following = new Map<string, Promise<vscodeApi.Uri[]>>();

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

	const saveAll = async (uris: vscodeApi.Uri[]): Promise<string[]> => {
		const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];

		for (const uri of unique) {
			await saveDocument(await vscode.workspace.openTextDocument(uri), relative(uri));
		}

		return unique.map(relative);
	};

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

		const updated = await saveAll(await following.get(`${source.path} ${target.path}`) ?? []);

		return { "moved": relative(source), "to": relative(target), "updated": updated.filter((file) => file !== relative(target)) };
	});
}
