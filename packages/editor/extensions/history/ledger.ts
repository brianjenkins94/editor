/**
 * The feature ledger in the editor (packages/silo/README.md, *The feature ledger*: "In the editor"), what `silo check`
 * says, held to the workspace as it is:
 * - **Drift, in Problems** (lib's util/silo/ledger `drift`, the same checks): each a problem on `.silo/features.json`, at
 *   the entry it's about (a dead end the ledger doesn't name, at its top), with both ways out — and a code file no
 *   feature owns, or two do, on that file (decision 22: all of it, once the ledger declares a feature).
 * - **What's been decided about a file or a name** (`history.decisions`, core's `decisions.for`, agents' `decisions_for`):
 *   the ledger's entries naming it (or whose paths hold the file, or ways in name it), and each line of the docs naming it, under its heading — NEXT.md's items, the design sections — so a reason isn't re-derived.
 * Its ways in are History's reading (the TypeScript server plugin's, edits included); the docs and code it searches are
 * the workspace's files, read once and kept as they change.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

import { decisionsFor, driftOf } from "./ledger-checks";

/** The files drift reads: docs, and code. */
const READ = "**/*.{md,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const EXCLUDE = "**/node_modules/**";

export interface LedgerView {
	/** Check the ledger against the workspace, given its ways in now. */
	"check": (features: ReadonlyMap<string, Feature>) => Promise<void>;
	/** Every file there is, by its path from the root, and the docs' and code's text, as read (reach.ts reads them too). */
	"workspace": () => Promise<{ "files": ReadonlySet<string>; "texts": ReadonlyMap<string, string> }>;
	/** The ledger's text as it is now. */
	"ledgerText": () => Promise<string | undefined>;
}

export function ledgerView(context: vscode.ExtensionContext, root: vscode.Uri): LedgerView {
	const problems = vscode.languages.createDiagnosticCollection("silo");
	const ledgerUri = vscode.Uri.joinPath(root, ledgerPath());
	/** Every file there is, by its path from the root; and the text of the docs and code, once read. */
	let files: Set<string> | undefined;
	const texts = new Map<string, string>();
	const relative = (uri: vscode.Uri): string | undefined => (uri.path.startsWith(root.path + "/")
		? uri.path.slice(root.path.length + 1)
		: undefined);
	const textOf = async (uri: vscode.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	const load = async (): Promise<Set<string>> => {
		if (files === undefined) {
			files = new Set((await vscode.workspace.findFiles("**/*", EXCLUDE)).flatMap((uri) => relative(uri) ?? []));

			for (const uri of await vscode.workspace.findFiles(READ, EXCLUDE)) {
				const path = relative(uri);
				const text = path === undefined
					? undefined
					: await textOf(uri);

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
		const text = path === undefined || files === undefined
			? undefined
			: await textOf(uri);

		if (path !== undefined && text !== undefined) {
			texts.set(path, text);
		}
	};

	context.subscriptions.push(problems, everything, read, everything.onDidCreate((uri) => {
		const path = relative(uri);

		if (path !== undefined && !path.includes("node_modules/")) {
			files?.add(path);
		}
	}), everything.onDidDelete((uri) => {
		const path = relative(uri);

		if (path !== undefined) {
			files?.delete(path);
			texts.delete(path);
		}
	}), read.onDidCreate(reread), read.onDidChange(reread));

	const today = (): string => new Date().toISOString().slice(0, 10);
	const ledgerNow = async (): Promise<string | undefined> => texts.get(ledgerPath()) ?? await textOf(ledgerUri);

	context.subscriptions.push(
		// What's been decided about a file (a path, or a file's name) or a name (an identifier, a feature, a way in's id).
		vscode.commands.registerCommand("history.decisions", async (target: unknown) => {
			await load();

			return decisionsFor(target, await ledgerNow(), texts);
		})
	);

	return {
		"workspace": async () => ({ "files": await load(), "texts": texts }),
		"ledgerText": ledgerNow,
		"check": async (features) => {
			const there = await load();
			const placed = Map.groupBy(driftOf(texts.get(ledgerPath()) ?? await textOf(ledgerUri), there, texts, features, today()), (each) => each.path);

			problems.clear();
			// (the ledger's set even with none: Problems then shows it has none)
			problems.set(ledgerUri, []);

			for (const [path, each] of placed) {
				problems.set(vscode.Uri.joinPath(root, path), each.map(({ line, length, check, message }) => {
					const problem = new vscode.Diagnostic(new vscode.Range(line, 0, line, length), message, vscode.DiagnosticSeverity.Error);

					problem.source = "silo";
					problem.code = check;

					return problem;
				}));
			}
		}
	};
}
