/**
 * The feature ledger's drift, in Problems (packages/silo/README.md, *The feature ledger*: "In the editor"): what `silo
 * check` says — lib's util/silo/ledger `drift`, the same checks, held to the workspace as it is — each a problem on
 * `.silo/features.json`, at the entry it's about (a dead end the ledger doesn't name, at its top), with both ways out.
 * Its ways in are History's reading (the TypeScript server plugin's, edits included); the docs and code it searches are
 * the workspace's files, read once and kept as they change.
 */
import type { FoundWay } from "@brianjenkins94/util/silo/ledger";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { drift, parseLedger } from "@brianjenkins94/util/silo/ledger";
import * as vscode from "vscode";

/** The files drift reads: docs, and code. */
const READ = "**/*.{md,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const EXCLUDE = "**/node_modules/**";

export interface LedgerDrift {
	/** Check the ledger against the workspace, given its ways in now. */
	"check": (ways: FoundWay[]) => Promise<void>;
}

export function ledgerDrift(context: vscode.ExtensionContext, root: vscode.Uri): LedgerDrift {
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

	return {
		"check": async (ways) => {
			const there = await load();
			const ledgerText = texts.get(ledgerPath()) ?? await textOf(ledgerUri);
			const found = drift(parseLedger(ledgerText), {
				"today": new Date().toISOString().slice(0, 10),
				"ways": ways,
				"exists": (path) => there.has(path) || [...there].some((file) => file.startsWith(path.replace(/\/+$/u, "") + "/")),
				"docs": [...texts].filter(([path]) => path.endsWith(".md")).map(([path, text]) => ({ "file": path, "text": text })),
				"code": [...texts].filter(([path]) => !path.endsWith(".md") && includeByDefault(path)).map(([path, text]) => ({ "file": path, "text": text }))
			});
			const lines = (ledgerText ?? "").split("\n");

			problems.set(ledgerUri, found.map((each) => {
				// (at its entry's line in the ledger; a dead end the ledger doesn't name, at the top)
				const line = each.entry === undefined ? -1 : lines.findIndex((text) => text.includes(JSON.stringify(each.entry)));
				const problem = new vscode.Diagnostic(new vscode.Range(Math.max(0, line), 0, Math.max(0, line), lines[Math.max(0, line)]?.length ?? 0), `${each.check}: ${each.message} — change the code: ${each.code}; or the decision: ${each.decision}`, vscode.DiagnosticSeverity.Error);

				problem.source = "silo";
				problem.code = each.check;

				return problem;
			}));
		}
	};
}
