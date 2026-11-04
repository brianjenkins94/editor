/**
 * The feature ledger in the editor (packages/silo/README.md, *The feature ledger*: "In the editor"), what `silo check`
 * says, held to the workspace as it is:
 * - **Drift, in Problems** (lib's util/silo/ledger `drift`, the same checks): each a problem on `.silo/features.json`, at
 *   the entry it's about (a dead end the ledger doesn't name, at its top), with both ways out — and a code file no
 *   feature owns, or two do, on that file (decision 22: the folders `.silo/owned.json` names).
 * - **What's been decided about a file or a name** (`history.decisions`, core's `decisions.for`, agents' `decisions_for`):
 *   the ledger's entries naming it (or whose paths hold the file, or ways in name it), and each line of the docs naming it, under its heading — NEXT.md's items, the design sections — so a reason isn't re-derived.
 * Its ways in are History's reading (the TypeScript server plugin's, edits included); the docs and code it searches are
 * the workspace's files, read once and kept as they change.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { ledgerPath, ownedPath } from "@brianjenkins94/util/silo/layout";
import { drift, parseLedger, parseOwned } from "@brianjenkins94/util/silo/ledger";
import * as vscode from "vscode";

/** The files drift reads: docs, and code. */
const READ = "**/*.{md,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const EXCLUDE = "**/node_modules/**";

/** A code file, as ownership counts one. */
const CODE = /\.[cm]?[jt]sx?$/u;

/** The doc lines `history.decisions` lists, at most. */
const DOC_LINES = 60;

export interface LedgerView {
	/** Check the ledger against the workspace, given its ways in now. */
	"check": (features: ReadonlyMap<string, Feature>) => Promise<void>;
}

export function ledgerView(context: vscode.ExtensionContext, root: vscode.Uri): LedgerView {
	const problems = vscode.languages.createDiagnosticCollection("silo");
	const ledgerUri = vscode.Uri.joinPath(root, ledgerPath());
	/** Every file there is, by its path from the root; and the text of the docs and code, once read. */
	let files: Set<string> | undefined;
	const texts = new Map<string, string>();
	const relative = (uri: vscode.Uri): string | undefined => (uri.path.startsWith(root.path + "/") ? uri.path.slice(root.path.length + 1) : undefined);
	const textOf = async (uri: vscode.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	const load = async (): Promise<Set<string>> => {
		if (files === undefined) {
			files = new Set((await vscode.workspace.findFiles("**/*", EXCLUDE)).flatMap((uri) => relative(uri) ?? []));

			for (const uri of await vscode.workspace.findFiles(READ, EXCLUDE)) {
				const path = relative(uri);
				const text = path === undefined ? undefined : await textOf(uri);

				if (path !== undefined && text !== undefined) {
					texts.set(path, text);
				}
			}
		}

		return files;
	};

	// (kept as the workspace changes: a file made, changed or gone)
	const everything = vscode.workspace.createFileSystemWatcher("**/*");
	const read = vscode.workspace.createFileSystemWatcher(READ);
	const reread = async (uri: vscode.Uri): Promise<void> => {
		const path = relative(uri);
		const text = path === undefined || files === undefined ? undefined : await textOf(uri);

		if (path !== undefined && text !== undefined) {
			texts.set(path, text);
		}
	};

	context.subscriptions.push(problems, everything, read,
		everything.onDidCreate((uri) => {
			const path = relative(uri);

			if (path !== undefined && !path.includes("node_modules/")) {
				files?.add(path);
			}
		}),
		everything.onDidDelete((uri) => {
			const path = relative(uri);

			if (path !== undefined) {
				files?.delete(path);
				texts.delete(path);
			}
		}),
		read.onDidCreate(reread),
		read.onDidChange(reread));

	const today = (): string => new Date().toISOString().slice(0, 10);
	const ledgerNow = async (): Promise<string | undefined> => texts.get(ledgerPath()) ?? await textOf(ledgerUri);

	context.subscriptions.push(
		// What's been decided about a file (a path, or a file's name) or a name (an identifier, a feature, a way in's id).
		vscode.commands.registerCommand("history.decisions", async (target: unknown) => {
			if (typeof target !== "string" || target.trim() === "") {
				return undefined;
			}

			const wanted = target.trim().replace(/^\/workspace\//u, "");
			const isPath = wanted.includes("/") || /\.[a-z]+$/u.test(wanted);
			const names = isPath ? [...new Set([wanted, wanted.split("/").at(-1) ?? wanted])] : [wanted];
			const words = names.map((name) => new RegExp(`(?<![\\w$/.-])${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, "u"));
			const said = (text: string | undefined): boolean => text !== undefined && words.some((word) => word.test(text));
			const holds = (paths: string[] | undefined): boolean => isPath && (paths ?? []).some((each) => wanted === each.replace(/\/+$/u, "") || wanted.startsWith(each.replace(/\/+$/u, "") + "/"));

			await load();

			const ledger = parseLedger(await ledgerNow());
			const entries = Object.entries(ledger).filter(([name, entry]) => said(name) || said(entry.why) || said(entry.key) || holds(entry.paths) || (entry.ways ?? []).some((key) => said(key))).map(([name, entry]) => ({ "name": name, ...entry }));
			const docs: { "doc": string; "line": number; "heading": string; "text": string }[] = [];

			for (const [file, text] of [...texts].filter(([path]) => path.endsWith(".md")).sort(([left], [right]) => left.localeCompare(right))) {
				let heading = "";

				for (const [index, line] of text.split("\n").entries()) {
					if (/^#{1,6} /u.test(line)) {
						heading = line.replace(/^#+ /u, "");
					} else if (said(line)) {
						docs.push({ "doc": file, "line": index + 1, "heading": heading, "text": line.trim().slice(0, 240) });
					}
				}
			}

			return { "target": wanted, "ledger": entries, "docs": docs.slice(0, DOC_LINES), "counts": { "docs": docs.length } };
		})
	);

	return {
		"check": async (features) => {
			const there = await load();
			const ledgerText = texts.get(ledgerPath()) ?? await textOf(ledgerUri);
			const ledger = parseLedger(ledgerText);
			const owned = parseOwned(await textOf(vscode.Uri.joinPath(root, ownedPath())));
			const found = drift(ledger, {
				"today": today(),
				"ways": [...features.values()].map((feature) => ({ "key": feature.key, "facet": feature.facet, "id": feature.id, "sides": feature.sides })),
				"exists": (path) => there.has(path) || [...there].some((file) => file.startsWith(path.replace(/\/+$/u, "") + "/")),
				"docs": [...texts].filter(([path]) => path.endsWith(".md")).map(([path, text]) => ({ "file": path, "text": text })),
				"code": [...texts].filter(([path]) => !path.endsWith(".md") && includeByDefault(path)).map(([path, text]) => ({ "file": path, "text": text })),
				...owned.length === 0 ? {} : { "owned": { "scope": owned, "files": [...there].filter((path) => includeByDefault(path) && CODE.test(path)) } }
			});
			const lines = (ledgerText ?? "").split("\n");
			// (a file no feature owns, or two do: on that file — its path the message's start)
			const onFile = found.filter((each) => each.check === "unowned file" || each.check === "owned twice");
			const problemOf = (each: (typeof found)[number], range: vscode.Range): vscode.Diagnostic => {
				const problem = new vscode.Diagnostic(range, `${each.check}: ${each.message} — change the code: ${each.code}; or the decision: ${each.decision}`, vscode.DiagnosticSeverity.Error);

				problem.source = "silo";
				problem.code = each.check;

				return problem;
			};

			problems.clear();

			for (const each of onFile) {
				const uri = vscode.Uri.joinPath(root, each.message.slice(0, each.message.indexOf(" is owned")));

				problems.set(uri, [...problems.get(uri) ?? [], problemOf(each, new vscode.Range(0, 0, 0, 0))]);
			}

			problems.set(ledgerUri, found.filter((each) => !onFile.includes(each)).map((each) => {
				// (at its entry's line in the ledger; a dead end the ledger doesn't name, at the top)
				const line = each.entry === undefined ? -1 : lines.findIndex((text) => text.includes(JSON.stringify(each.entry)));

				return problemOf(each, new vscode.Range(Math.max(0, line), 0, Math.max(0, line), lines[Math.max(0, line)]?.length ?? 0));
			}));
		}
	};
}
