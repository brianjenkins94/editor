import type { Feature } from "@brianjenkins94/util/silo/features";
import { lastRunReachPath, ledgerPath } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

import { decisionsFor, driftOf } from "./ledger-checks";

const READ = "**/*.{md,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const EXCLUDE = "**/node_modules/**";

export interface LedgerView {
	"check": (features: ReadonlyMap<string, Feature>) => Promise<void>;
	"workspace": () => Promise<{ "files": ReadonlySet<string>; "texts": ReadonlyMap<string, string> }>;
	"ledgerText": () => Promise<string | undefined>;
}

export function ledgerView(context: vscode.ExtensionContext, root: vscode.Uri): LedgerView {
	const problems = vscode.languages.createDiagnosticCollection("silo");
	const ledgerUri = vscode.Uri.joinPath(root, ledgerPath());
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
			const placed = Map.groupBy(driftOf(texts.get(ledgerPath()) ?? await textOf(ledgerUri), there, texts, features, today(), await textOf(vscode.Uri.joinPath(root, lastRunReachPath()))), (each) => each.path);

			problems.clear();
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
