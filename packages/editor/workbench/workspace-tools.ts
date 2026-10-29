/**
 * The workspace as an agent works in it — as it would on a local machine (ARCHITECTURE.md, *Workspace tools*;
 * debug-mcp's files_* tools, app/tools/):
 *
 * - `files.read` { path, offset?, limit? }: a file's text, numbered as `cat -n` numbers it — what's open in an editor,
 *   unsaved edits included, else what's on disk;
 * - `files.write` { path, content }: a file made, or its whole text replaced;
 * - `files.edit` { path, old, new, all? }: an exact string replaced — found once, or every time with `all`;
 * - `files.glob` { pattern, limit? }: the workspace's files a glob matches;
 * - `files.grep` { pattern, glob?, ignoreCase?, limit? }: the lines a regular expression matches, in the files a glob
 *   (default: every file) matches.
 *
 * A write or an edit goes through VS Code's documents, as typing would: an open editor shows it, undo takes it back, the
 * edit history records it, and saving runs what saving runs (format on save). Paths are the workspace's: relative to it,
 * or absolute under it. Runs in the workbench realm (core), with its own extension API.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";

const ROOT = "/workspace";

/** Lines read at most, by default; and a line's characters at most (a minified file's one line). */
const READ_LINES = 2000;
const LINE_CHARACTERS = 2000;

/** Matches found, files listed, at most, by default. */
const GREP_RESULTS = 200;
const GLOB_RESULTS = 500;

/** A file grep reads, at most (bigger is data, not code). */
const GREP_BYTES = 1_000_000;

/** Saves tried before an edit says it couldn't be saved (see applyAndSave). */
const SAVE_ATTEMPTS = 3;

/** The files the TypeScript server reads. */
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/** What `files.*` leave out, unless a glob asks for it. */
const EXCLUDE = "{**/node_modules/**,**/.git/**}";

export function installWorkspaceTools(vscode: typeof vscodeApi, hub: Hub): void {
	const decoder = new TextDecoder();

	/** `path`'s file: relative to the workspace, or absolute under it. */
	const uriOf = (path: unknown): vscodeApi.Uri => {
		if (typeof path !== "string" || path === "") {
			throw new TypeError("a path: relative to the workspace, or absolute under it");
		}

		const absolute = vscode.Uri.joinPath(vscode.Uri.file(ROOT), path.startsWith(ROOT) ? path.slice(ROOT.length) : path).path;

		if (absolute !== ROOT && !absolute.startsWith(ROOT + "/")) {
			throw new Error(`${path} is outside the workspace (${ROOT})`);
		}

		return vscode.Uri.file(absolute);
	};

	const relative = (uri: vscodeApi.Uri): string => vscode.workspace.asRelativePath(uri, false);
	/** A file's text as the editor has it: an open document's (unsaved edits included), else what's on disk. */
	const textOf = async (uri: vscodeApi.Uri): Promise<{ "text": string; "dirty": boolean }> => {
		const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

		if (open !== undefined) {
			return { "text": open.getText(), "dirty": open.isDirty };
		}

		try {
			return { "text": decoder.decode(await vscode.workspace.fs.readFile(uri)), "dirty": false };
		} catch {
			throw new Error(`${relative(uri)} doesn't exist`);
		}
	};

	/** Edits to `uri`'s text, as typing makes them (an open editor, undo, the edit history), then saved. */
	const applyAndSave = async (uri: vscodeApi.Uri, edits: (document: vscodeApi.TextDocument) => { "range": vscodeApi.Range; "text": string }[]): Promise<void> => {
		const document = await vscode.workspace.openTextDocument(uri);
		const edit = new vscode.WorkspaceEdit();

		for (const { range, text } of edits(document)) {
			edit.replace(uri, range, text);
		}

		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error(`${relative(uri)} couldn't be edited`);
		}

		// VS Code abandons a save, and `save()` answers false, when its code actions on save are cancelled: getCodeActions
		// cancels itself if a code action provider is registered while it waits, as extensions starting up do, and ESLint's
		// first fix (its worker starting) is a long wait. That save is tried again, so the edit lands on disk.
		for (let attempt = 1; !await document.save(); attempt += 1) {
			if (attempt === SAVE_ATTEMPTS) {
				throw new Error(`${relative(uri)} was edited, but VS Code didn't save it (${SAVE_ATTEMPTS} tries): the change is in its editor, unsaved`);
			}
		}
	};

	serve(hub, "files.read", async (args) => {
		const { path, offset, limit } = (args ?? {}) as { "path"?: unknown; "offset"?: unknown; "limit"?: unknown };
		const uri = uriOf(path);
		const { text, dirty } = await textOf(uri);
		const lines = text.split("\n");
		const from = typeof offset === "number" && offset > 1 ? Math.floor(offset) : 1;
		const count = typeof limit === "number" && limit > 0 ? Math.floor(limit) : READ_LINES;
		const shown = lines.slice(from - 1, from - 1 + count);
		const width = String(from + shown.length - 1).length;

		return {
			"path": relative(uri),
			"lines": lines.length,
			"from": from,
			"to": from + shown.length - 1,
			"dirty": dirty,
			"content": shown.map((line, index) => `${String(from + index).padStart(width)}\t${line.length > LINE_CHARACTERS ? line.slice(0, LINE_CHARACTERS) + "…" : line}`).join("\n")
		};
	});

	serve(hub, "files.write", async (args) => {
		const { path, content } = (args ?? {}) as { "path"?: unknown; "content"?: unknown };
		const uri = uriOf(path);

		if (typeof content !== "string") {
			throw new TypeError("files.write takes { path, content }: the file's whole text");
		}

		const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);

		if (exists) {
			await applyAndSave(uri, (document) => [{ "range": new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), "text": content }]);
		} else {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

			// (a new code file, handed to the TypeScript server: in the browser it doesn't see a file made on disk until a
			// language feature asks of it — NEXT.md, *Watching* — and History, code_problems and code_reach read through it)
			if (CODE_FILE.test(uri.path)) {
				await Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)).catch(() => undefined);
			}
		}

		return { "path": relative(uri), "created": !exists, "lines": content.split("\n").length };
	});

	serve(hub, "files.edit", async (args) => {
		const { path, old, "new": replacement, all } = (args ?? {}) as { "path"?: unknown; "old"?: unknown; "new"?: unknown; "all"?: unknown };
		const uri = uriOf(path);

		if (typeof old !== "string" || old === "" || typeof replacement !== "string") {
			throw new TypeError("files.edit takes { path, old, new, all? }: the exact text to replace, and what replaces it");
		}

		const { text } = await textOf(uri);
		const at: number[] = [];

		for (let index = text.indexOf(old); index !== -1; index = text.indexOf(old, index + old.length)) {
			at.push(index);
		}

		if (at.length === 0) {
			throw new Error(`the text to replace isn't in ${relative(uri)} (it must match exactly — whitespace too)`);
		}

		if (at.length > 1 && all !== true) {
			throw new Error(`the text to replace is in ${relative(uri)} ${at.length} times: give more of it around the one meant, or { all: true } for every one`);
		}

		await applyAndSave(uri, (document) => at.map((index) => ({ "range": new vscode.Range(document.positionAt(index), document.positionAt(index + old.length)), "text": replacement })));

		return { "path": relative(uri), "replaced": at.length };
	});

	serve(hub, "files.glob", async (args) => {
		const { pattern, limit } = (args ?? {}) as { "pattern"?: unknown; "limit"?: unknown };

		if (typeof pattern !== "string" || pattern === "") {
			throw new TypeError("files.glob takes { pattern }: a glob, e.g. src/**/*.ts");
		}

		const most = typeof limit === "number" && limit > 0 ? limit : GLOB_RESULTS;
		const found = await vscode.workspace.findFiles(pattern, /node_modules|\.git\//u.test(pattern) ? undefined : EXCLUDE, most + 1);
		const files = found.map(relative).sort();

		return { "files": files.slice(0, most), "truncated": files.length > most };
	});

	/** What grep searches in `uri`: the open document's text, else the file's — undefined for data, binary or unreadable. */
	const searchableText = async (uri: vscodeApi.Uri): Promise<string | undefined> => {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);

			if (bytes.byteLength > GREP_BYTES || bytes.includes(0)) {
				return undefined; // data, or binary
			}

			return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.getText() ?? decoder.decode(bytes);
		} catch {
			return undefined;
		}
	};

	serve(hub, "files.grep", async (args) => {
		const { pattern, glob, ignoreCase, limit } = (args ?? {}) as { "pattern"?: unknown; "glob"?: unknown; "ignoreCase"?: unknown; "limit"?: unknown };

		if (typeof pattern !== "string" || pattern === "") {
			throw new TypeError("files.grep takes { pattern, glob? }: a regular expression, and the files to look in");
		}

		const expression = new RegExp(pattern, ignoreCase === true ? "iu" : "u");
		const include = typeof glob === "string" && glob !== "" ? glob : "**/*";
		const most = typeof limit === "number" && limit > 0 ? limit : GREP_RESULTS;
		const matches: { "file": string; "line": number; "text": string }[] = [];
		let total = 0;

		for (const uri of (await vscode.workspace.findFiles(include, /node_modules|\.git\//u.test(include) ? undefined : EXCLUDE)).sort((left, right) => left.path.localeCompare(right.path))) {
			const text = await searchableText(uri);

			if (text !== undefined) {
				const lines = text.split("\n");

				for (let index = 0; index < lines.length; index += 1) {
					const line = lines[index];

					if (expression.test(line)) {
						total += 1;

						if (matches.length < most) {
							matches.push({ "file": relative(uri), "line": index + 1, "text": line.length > LINE_CHARACTERS ? line.slice(0, LINE_CHARACTERS) + "…" : line });
						}
					}
				}
			}
		}

		return { "matches": matches, "total": total };
	});
}
