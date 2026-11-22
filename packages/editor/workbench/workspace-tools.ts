import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { REFS_DIR } from "@brianjenkins94/editor-api/git";
import { serve } from "@brianjenkins94/hub";
import { unifiedDiff } from "./git-service";

const ROOT = "/workspace";

const READ_LINES = 2000;
const LINE_CHARACTERS = 2000;

const GREP_RESULTS = 200;
const GLOB_RESULTS = 500;

const GREP_BYTES = 1_000_000;

const SAVE_ATTEMPTS = 3;

const EXCLUDE = "{**/node_modules/**,**/.git/**}";

const EXCLUDE_REFS = `{**/node_modules/**,**/.git/**,${REFS_DIR}/**}`;

function excludeFor(pattern: string): string | undefined {
	if (/node_modules|\.git\//u.test(pattern)) {
		return undefined;
	}

	return pattern.startsWith(REFS_DIR + "/") ? EXCLUDE : EXCLUDE_REFS;
}

export async function saveDocument(document: vscodeApi.TextDocument, file: string): Promise<void> {
	for (let attempt = 1; !await document.save(); attempt += 1) {
		if (attempt === SAVE_ATTEMPTS) {
			throw new Error(`${file} was edited, but VS Code didn't save it (${SAVE_ATTEMPTS} tries): the change is in its editor, unsaved`);
		}
	}
}

function occurrences(text: string, old: string): number[] {
	const at: number[] = [];

	for (let index = text.indexOf(old); index !== -1; index = text.indexOf(old, index + old.length)) {
		at.push(index);
	}

	return at;
}

export function installWorkspaceTools(vscode: typeof vscodeApi, hub: Hub): void {
	const decoder = new TextDecoder();

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
	const textOf = async (uri: vscodeApi.Uri): Promise<{ "text": string; "dirty": boolean }> => {
		const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

		if (open?.isDirty === true) {
			return { "text": open.getText(), "dirty": open.isDirty };
		}

		try {
			return { "text": decoder.decode(await vscode.workspace.fs.readFile(uri)), "dirty": false };
		} catch {
			throw new Error(`${relative(uri)} doesn't exist`);
		}
	};

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

	const notesOn = async (uri: vscodeApi.Uri): Promise<{ "line"?: number; "text": string; "by": string }[]> => await Promise.resolve(vscode.commands.executeCommand<{ "line"?: number; "text": string; "by": string }[]>("notes.on", relative(uri))).catch(() => undefined) ?? [];

	const orphaning = async <T extends object>(uris: vscodeApi.Uri[], edit: () => Promise<T>): Promise<T & { "orphaned"?: { "path": string; "text": string; "by": string }[] }> => {
		const before = new Map<string, { "line"?: number; "text": string; "by": string }[]>();

		for (const uri of uris) {
			const placed = (await notesOn(uri)).filter(({ line }) => line !== undefined);

			if (placed.length > 0) {
				before.set(uri.toString(), placed);
			}
		}

		const answer = await edit();
		const orphaned = [];

		for (const uri of uris.filter((each) => before.has(each.toString()))) {
			const lost = (await notesOn(uri)).filter(({ line }) => line === undefined);

			for (const note of before.get(uri.toString()) ?? []) {
				if (lost.some(({ text, by }) => text === note.text && by === note.by)) {
					orphaned.push({ "path": relative(uri), "text": note.text, "by": note.by });
				}
			}
		}

		return orphaned.length === 0 ? answer : { ...answer, "orphaned": orphaned };
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
		const notes = (await notesOn(uri)).filter(({ line }) => line === undefined || (line >= from && line < from + shown.length));

		return {
			"path": relative(uri),
			"lines": lines.length,
			"from": from,
			"to": from + shown.length - 1,
			"dirty": dirty,
			"content": shown.map((line, index) => `${String(from + index).padStart(width)}\t${line.length > LINE_CHARACTERS ? line.slice(0, LINE_CHARACTERS) + "…" : line}`).join("\n"),
			...notes.length === 0 ? {} : { "notes": notes }
		};
	});

	serve(hub, "files.write", async (args) => {
		const { path, content } = (args ?? {}) as { "path"?: unknown; "content"?: unknown };
		const uri = uriOf(path);

		if (typeof content !== "string") {
			throw new TypeError("files.write takes { path, content }: the file's whole text");
		}

		const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);

		if (!exists) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

			return { "path": relative(uri), "created": true, "lines": content.split("\n").length };
		}

		return orphaning([uri], async () => {
			await applyAndSave(uri, (document) => [{ "range": new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), "text": content }]);

			return { "path": relative(uri), "created": false, "lines": content.split("\n").length };
		});
	});

	serve(hub, "notes.add", async (args) => {
		const { path, at, text } = (args ?? {}) as { "path"?: unknown; "at"?: unknown; "text"?: unknown };
		const uri = uriOf(path);

		if (typeof at !== "string" || at === "" || typeof text !== "string" || text.trim() === "") {
			throw new TypeError("notes.add takes { path, at, text }: the code the note is about, as it's written, and the note");
		}

		const document = await vscode.workspace.openTextDocument(uri);
		const found = occurrences(document.getText(), at);

		if (found.length !== 1) {
			throw new Error(found.length === 0 ? `${relative(uri)} has no ${JSON.stringify(at.slice(0, 60))}` : `${relative(uri)} has that code ${String(found.length)} times: give more of it`);
		}

		const editor = await vscode.window.showTextDocument(document, { "preview": false });

		editor.selection = new vscode.Selection(document.positionAt(found[0]), document.positionAt(found[0] + at.length));

		const added = await vscode.commands.executeCommand<unknown>("notes.add", text);

		if (added === undefined) {
			throw new Error("the note wasn't added: no code there it can stand on (a statement or an expression)");
		}

		return { "path": relative(uri), "line": document.positionAt(found[0]).line + 1 };
	});

	serve(hub, "files.delete", async (args) => {
		const { path } = (args ?? {}) as { "path"?: unknown };
		const uri = uriOf(path);
		const at = relative(uri);

		if (at === "" || at === ".git" || at.startsWith(".git/")) {
			throw new Error(`${at === "" ? "the workspace itself" : at} isn't deleted here: the git tools change git's own files`);
		}

		const stat = await vscode.workspace.fs.stat(uri).then((found) => found, () => undefined);

		if (stat === undefined) {
			throw new Error(`there's no ${at} to delete`);
		}

		await vscode.workspace.fs.delete(uri, { "recursive": true, "useTrash": false });

		return { "path": at, "folder": stat.type === vscode.FileType.Directory };
	});

	serve(hub, "files.edit", async (args) => {
		const { path, old, "new": replacement, all, lines } = (args ?? {}) as { "path"?: unknown; "old"?: unknown; "new"?: unknown; "all"?: unknown; "lines"?: unknown };
		const uri = uriOf(path);

		if (Array.isArray(lines)) {
			const [from, to] = lines as unknown[];

			if (typeof replacement !== "string" || !Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 1 || (to as number) < (from as number)) {
				throw new TypeError("files.edit takes { path, lines: [from, to], new }: lines from and to (1-based, both in), and what replaces them whole");
			}

			const { text } = await textOf(uri);
			const all = text.split("\n");
			const count = text.endsWith("\n") ? all.length - 1 : all.length;

			if ((to as number) > count) {
				throw new Error(`${relative(uri)} has ${String(count)} line${count === 1 ? "" : "s"}, not ${String(to)}`);
			}

			const start = all.slice(0, (from as number) - 1).reduce((at, line) => at + line.length + 1, 0);
			const end = Math.min(text.length, all.slice(0, to as number).reduce((at, line) => at + line.length + 1, 0));
			const cut = text.slice(start, end).split("\n");

			return orphaning([uri], async () => {
				await applyAndSave(uri, (document) => [{ "range": new vscode.Range(document.positionAt(start), document.positionAt(end)), "text": replacement }]);

				return { "path": relative(uri), "replaced": 1, "lines": (to as number) - (from as number) + 1, "first": cut[0], "last": cut.at(cut.at(-1) === "" ? -2 : -1) };
			});
		}

		if (typeof old !== "string" || old === "" || typeof replacement !== "string") {
			throw new TypeError("files.edit takes { path, old, new, all? }: the exact text to replace, and what replaces it — or { path, lines: [from, to], new }");
		}

		const { text } = await textOf(uri);
		const at = occurrences(text, old);

		if (at.length === 0) {
			throw new Error(`the text to replace isn't in ${relative(uri)} (it must match exactly — whitespace too)`);
		}

		if (at.length > 1 && all !== true) {
			throw new Error(`the text to replace is in ${relative(uri)} ${at.length} times: give more of it around the one meant, or { all: true } for every one`);
		}

		return orphaning([uri], async () => {
			await applyAndSave(uri, (document) => at.map((index) => ({ "range": new vscode.Range(document.positionAt(index), document.positionAt(index + old.length)), "text": replacement })));

			return { "path": relative(uri), "replaced": at.length };
		});
	});

	serve(hub, "files.replace", async (args) => {
		const { edits, preview } = (args ?? {}) as { "edits"?: unknown; "preview"?: unknown };

		if (!Array.isArray(edits) || edits.length === 0) {
			throw new TypeError("files.replace takes { edits: [{ path, old, new, all?, count? }] }: the exact texts to replace, in which files");
		}

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

		const touched = [...new Map(planned.map(({ uri }) => [uri.toString(), uri])).values()];

		return orphaning(touched, async () => {
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
	});

	serve(hub, "files.glob", async (args) => {
		const { pattern, limit } = (args ?? {}) as { "pattern"?: unknown; "limit"?: unknown };

		if (typeof pattern !== "string" || pattern === "") {
			throw new TypeError("files.glob takes { pattern }: a glob, e.g. src/**/*.ts");
		}

		const most = typeof limit === "number" && limit > 0 ? limit : GLOB_RESULTS;
		const found = await vscode.workspace.findFiles(pattern, excludeFor(pattern), most + 1);
		const files = found.map(relative).sort();

		return { "files": files.slice(0, most), "truncated": files.length > most };
	});

	const searchableText = async (uri: vscodeApi.Uri): Promise<string | undefined> => {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);

			if (bytes.byteLength > GREP_BYTES || bytes.includes(0)) {
				return undefined;
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
		const named = typeof glob === "string" && glob !== "" ? glob.replace(/^\/workspace\//u, "").replace(/\/+$/u, "") : undefined;
		const folder = named !== undefined && !/[*?{[]/u.test(named) && await Promise.resolve(vscode.workspace.fs.stat(uriOf(named))).then((stat) => stat.type === vscode.FileType.Directory, () => false);
		const include = named === undefined ? "**/*" : folder ? `${named}/**/*` : named;
		const most = typeof limit === "number" && limit > 0 ? limit : GREP_RESULTS;
		const matches: { "file": string; "line": number; "text": string }[] = [];
		let total = 0;

		for (const uri of (await vscode.workspace.findFiles(include, excludeFor(include))).sort((left, right) => left.path.localeCompare(right.path))) {
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
