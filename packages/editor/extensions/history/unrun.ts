import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import type { LedgerView } from "./ledger";
import type { Unrun, UnrunKind } from "./unrun-of";
import { evidenceStore } from "@brianjenkins94/editor-api/evidence";
import { lastRunReachPath } from "@brianjenkins94/util/silo/layout";
import { ownersOf, parseLedger } from "@brianjenkins94/util/silo/ledger";
import { ranByLine } from "@brianjenkins94/util/silo/observed";
import * as vscode from "vscode";
import { unrunOf } from "./unrun-of";

const GROUPS: [UnrunKind, string][] = [
	["nothing", "Nothing calls it, nothing ran it"],
	["exported", "Exported, nothing here names it or ran it"],
	["called", "Called, but nothing ran it"],
	["used", "Ran in use, no test runs it"]
];

export interface UnrunView {
	"read": (graph: DeclarationGraph, analyses: ReadonlyMap<string, FileAnalysis>) => void;
}

export function unrunView(context: vscode.ExtensionContext, root: vscode.Uri, ledger: LedgerView): UnrunView {
	let program: { "graph": DeclarationGraph; "analyses": ReadonlyMap<string, FileAnalysis> } | undefined;
	const store = evidenceStore(vscode, context.subscriptions);
	const textOf = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	const testedLines = async (): Promise<{ "tested": Record<string, Set<number>>; "at"?: string }> => {
		const record = await textOf(lastRunReachPath());
		const byLine = ranByLine(record);
		const at = (() => {
			try {
				return (JSON.parse(record ?? "") as { "at"?: string }).at;
			} catch {
				return undefined;
			}
		})();

		return { "tested": Object.fromEntries(Object.entries(byLine).map(([file, lines]) => [file, new Set(Object.keys(lines).map(Number))])), ...at === undefined ? {} : { "at": at } };
	};

	const usedRanges = async (files: string[], texts: ReadonlyMap<string, string>): Promise<Record<string, [number, number][]>> => {
		const used: Record<string, [number, number][]> = {};
		const evidenced = new Set(await store.files());

		for (const file of files.filter((each) => evidenced.has(each))) {
			const placed = await store.placedIn(file, texts.get(file) ?? "");

			used[file] = placed.filter(({ evidence }) => (evidence.reached?.ever ?? 0) > 0 || (evidence.value?.seen ?? 0) > 0 || (evidence.branch?.arms.some((count) => count > 0) ?? false)).map(({ start, end }) => [start, end]);
		}

		return used;
	};

	async function show(): Promise<void> {
		if (program === undefined) {
			void vscode.window.showInformationMessage("The program isn't read yet: TypeScript's server is still reading it. Try again in a moment.");

			return;
		}

		const { graph, analyses } = program;
		const listed = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": "What nothing ran: reading the tests' reach and what runs did" }, async () => {
			const { texts } = await ledger.workspace();
			const { tested, at } = await testedLines();
			const untested = unrunOf({ graph, analyses, texts, tested, "used": {} });
			const used = await usedRanges([...new Set(untested.map(({ file }) => file))], texts);

			return { "unrun": unrunOf({ graph, analyses, texts, tested, used }), "at": at };
		});
		const parsed = parseLedger(await ledger.ledgerText());
		const featureOf = (file: string): string => ownersOf(parsed, file).join(", ") || "no feature";

		type Item = vscode.QuickPickItem & { "place"?: Unrun };
		const items: Item[] = GROUPS.flatMap(([kind, label]): Item[] => {
			const these = listed.unrun.filter((each) => each.kind === kind);

			return these.length === 0
				? []
				: [
						{ "label": `${label} (${String(these.length)})`, "kind": vscode.QuickPickItemKind.Separator },
						...these.map((each) => ({
							"label": each.name,
							"description": `${each.file}:${String(each.line)} · ${featureOf(each.file)}${kind === "called" ? ` · ${String(each.callers)} caller${each.callers === 1 ? "" : "s"}` : ""}`,
							"detail": each.text,
							"place": each
						}))
					];
		});
		const open = async (place: Unrun, preview: boolean): Promise<void> => {
			const at = new vscode.Position(place.line - 1, 0);

			await vscode.window.showTextDocument(vscode.Uri.joinPath(root, place.file), { "selection": new vscode.Range(at, at), "preview": true, "preserveFocus": preview });
		};
		const pick = vscode.window.createQuickPick<Item>();

		pick.title = `What nothing ran: ${String(listed.unrun.length)} declarations no test ran${listed.at === undefined ? "" : `, by the tests' reach of ${listed.at}`}, and what runs in this editor did`;
		pick.placeholder = "A declaration, a file or a feature";
		pick.matchOnDescription = true;
		pick.matchOnDetail = true;
		pick.items = items;
		pick.onDidChangeActive(([item]) => {
			if (item?.place !== undefined) {
				void open(item.place, true);
			}
		});
		pick.onDidAccept(() => {
			const [item] = pick.selectedItems;

			pick.hide();

			if (item?.place !== undefined) {
				void open(item.place, false);
			}
		});
		pick.onDidHide(() => {
			pick.dispose();
		});
		pick.show();
	}

	context.subscriptions.push(vscode.commands.registerCommand("history.unrun.show", show));

	return {
		"read": (graph, analyses) => {
			program = { "graph": graph, "analyses": analyses };
		}
	};
}
