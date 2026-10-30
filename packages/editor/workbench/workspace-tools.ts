/**
 * The workspace as an agent works in it — as it would on a local machine (ARCHITECTURE.md, *Workspace tools*;
 * debug-mcp's files_* tools, app/tools/):
 *
 * - `files.read` { path, offset?, limit? }: a file's text, numbered as `cat -n` numbers it — what's open in an editor,
 *   unsaved edits included, else what's on disk;
 * - `files.write` { path, content }: a file made, or its whole text replaced;
 * - `files.edit` { path, old, new, all? }: an exact string replaced — found once, or every time with `all`;
 * - `files.replace` { edits: [{ path, old, new, all?, count? }], preview? }: exact strings replaced across files, all or
 *   nothing — each must be found as it says (once, `count` times, or every time with `all`) and none may overlap
 *   another, or nothing changes and the answer says each that didn't hold; then one edit, every file saved. With
 *   `preview`, the diff it would make, and nothing changed;
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
import { unifiedDiff } from "./git-service";

const ROOT = "/workspace";

/** Lines read at most, by default; and a line's characters at most (a minified file's one line). */
const READ_LINES = 2000;
const LINE_CHARACTERS = 2000;

/** Matches found, files listed, at most, by default. */
const GREP_RESULTS = 200;
const GLOB_RESULTS = 500;

/** A file grep reads, at most (bigger is data, not code). */
const GREP_BYTES = 1_000_000;

/** Saves tried before an edit says it couldn't be saved (see saveDocument). */
const SAVE_ATTEMPTS = 3;

/** What `files.*` leave out, unless a glob asks for it. */
const EXCLUDE = "{**/node_modules/**,**/.git/**}";

/**
 * Save `document`, as the workspace's tools save an edit: VS Code abandons a save, and `save()` answers false, when its
 * code actions on save are cancelled — getCodeActions cancels itself if a code action provider is registered while it
 * waits, as extensions starting up do, and ESLint's first fix (its worker starting) is a long wait. That save is tried
 * again, so the edit lands on disk; one that still doesn't throws, naming `file`.
 */
export async function saveDocument(document: vscodeApi.TextDocument, file: string): Promise<void> {
	for (let attempt = 1; !await document.save(); attempt += 1) {
		if (attempt === SAVE_ATTEMPTS) {
			throw new Error(`${file} was edited, but VS Code didn't save it (${SAVE_ATTEMPTS} tries): the change is in its editor, unsaved`);
		}
	}
}

/** Where `old` is in `text`: each start, none overlapping. */
function occurrences(text: string, old: string): number[] {
	const at: number[] = [];

	for (let index = text.indexOf(old); index !== -1; index = text.indexOf(old, index + old.length)) {
		at.push(index);
	}

	return at;
}

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

		await saveDocument(document, relative(uri));
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
		const at = occurrences(text, old);

		if (at.length === 0) {
			throw new Error(`the text to replace isn't in ${relative(uri)} (it must match exactly — whitespace too)`);
		}

		if (at.length > 1 && all !== true) {
			throw new Error(`the text to replace is in ${relative(uri)} ${at.length} times: give more of it around the one meant, or { all: true } for every one`);
		}

		await applyAndSave(uri, (document) => at.map((index) => ({ "range": new vscode.Range(document.positionAt(index), document.positionAt(index + old.length)), "text": replacement })));

		return { "path": relative(uri), "replaced": at.length };
	});

	serve(hub, "files.replace", async (args) => {
		const { edits, preview } = (args ?? {}) as { "edits"?: unknown; "preview"?: unknown };

		if (!Array.isArray(edits) || edits.length === 0) {
			throw new TypeError("files.replace takes { edits: [{ path, old, new, all?, count? }] }: the exact texts to replace, in which files");
		}

		// Every edit checked against its file as the editor has it now, before any is made.
		const texts = new Map<string, string>();
		const planned: { "uri": vscodeApi.Uri; "start": number; "end": number; "text": string; "edit": number }[] = [];
		const problems: string[] = [];

		for (const [index, each] of (edits as Record<string, unknown>[]).entries()) {
			const { path, old, "new": replacement, all, count } = each ?? {};
			const which = `edit ${String(index + 1)}`;

			if (typeof path !== "string" || typeof old !== "string" || old === "" || typeof replacement !== "string") {
				problems.push(`${which}: it takes { path, old, new, all?, count? }`);
				continue;
			}

			let uri: vscodeApi.Uri;

			try {
				uri = uriOf(path);
				texts.set(uri.toString(), texts.get(uri.toString()) ?? (await textOf(uri)).text);
			} catch (error) {
				problems.push(`${which}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}

			const at = occurrences(texts.get(uri.toString()) ?? "", old);
			const wanted = typeof count === "number" ? count : all === true ? undefined : 1;

			if (at.length === 0) {
				problems.push(`${which}: its text isn't in ${relative(uri)} (it must match exactly — whitespace too)`);
			} else if (wanted !== undefined && at.length !== wanted) {
				problems.push(`${which}: its text is in ${relative(uri)} ${String(at.length)} times, not ${String(wanted)}`);
			} else {
				planned.push(...at.map((start) => ({ "uri": uri, "start": start, "end": start + old.length, "text": replacement, "edit": index + 1 })));
			}
		}

		// (two edits on the same text: which wins isn't the agent's to guess)
		planned.sort((left, right) => left.uri.toString().localeCompare(right.uri.toString()) || left.start - right.start);

		for (const [index, each] of planned.entries()) {
			const before = planned[index - 1];

			if (before !== undefined && before.uri.toString() === each.uri.toString() && each.start < before.end) {
				problems.push(`edits ${String(before.edit)} and ${String(each.edit)} overlap in ${relative(each.uri)}`);
			}
		}

		if (problems.length > 0) {
			throw new Error(`nothing was changed: ${problems.join("; ")}`);
		}

		// (a preview: each file as the edit would leave it, as git's diff, and nothing changed)
		if (preview === true) {
			const diffs: string[] = [];

			for (const key of [...new Set(planned.map(({ uri }) => uri.toString()))]) {
				const text = texts.get(key) ?? "";
				const mine = planned.filter(({ uri }) => uri.toString() === key);
				let after = "";
				let from = 0;

				for (const { start, end, "text": replacement } of mine) {
					after += text.slice(from, start) + replacement;
					from = end;
				}

				diffs.push(unifiedDiff(relative(mine[0].uri), text, after + text.slice(from)));
			}

			return { "preview": true, "replaced": planned.length, "diff": diffs.join("") };
		}

		const edit = new vscode.WorkspaceEdit();
		const documents = new Map<string, vscodeApi.TextDocument>();

		for (const { uri, start, end, text } of planned) {
			const document = documents.get(uri.toString()) ?? await vscode.workspace.openTextDocument(uri);

			documents.set(uri.toString(), document);
			edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
		}

		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error("VS Code didn't apply the edit: nothing was changed");
		}

		for (const document of documents.values()) {
			await saveDocument(document, relative(document.uri));
		}

		return {
			"files": [...documents.values()].map((document) => ({ "path": relative(document.uri), "replaced": planned.filter(({ uri }) => uri.toString() === document.uri.toString()).length })),
			"replaced": planned.length
		};
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
