/**
 * The Rules view (RULES.md), as VS Code's own tree view, in the Explorer beside Capability calls: every rule in the
 * policy files — mine first (`.silo/<you>.policy.json`), then the shared contract's (`.silo/policy.json`) — each a
 * sentence in the catalog's words, in the order they're matched: the first that matches decides. A placed rule says the
 * line its statement is on now; one that can't be matched, or whose place is lost, says why.
 *
 * The rules, and what's done with them, are the editor's — its commands (rules-view.ts): `silo.rules.list` lists them as
 * the view shows them; a rule opens in the rule editor (`silo.rules.open`, the Rule view below), *New Rule* starts one,
 * *Remove* takes one of mine out, *Re-place at selection* places a lost one at the code selected. Redrawn as the policy
 * files change, and as files are saved (a placed rule follows its code).
 */
import * as vscode from "vscode";

/** A rule as the editor lists it (`silo.rules.list`). */
interface Listed {
	"whose": "mine" | "shared";
	"file": string;
	"sentence": string;
	"problem"?: string;
	"place"?: { "status": string; "line"?: number };
	"rule": unknown;
}

type Node = { "kind": "group"; "whose": "mine" | "shared"; "file": string; "rules": Listed[] } | { "kind": "rule"; "listed": Listed };

/** How a placed rule was found now, when that's not surely: it doesn't apply until it's placed again. */
function placing(listed: Listed): "lost" | "uncertain" | undefined {
	const status = listed.place?.status;

	return status === "orphaned" ? "lost" : status === "uncertain" ? "uncertain" : undefined;
}

export function registerRulesTree(context: vscode.ExtensionContext): void {
	const changed = new vscode.EventEmitter<void>();
	let listing: Promise<Listed[] | null> | undefined;
	const list = async (): Promise<Listed[] | null> => {
		listing ??= Promise.resolve(vscode.commands.executeCommand<Listed[] | null>("silo.rules.list")).catch(() => null);

		return listing;
	};
	const provider: vscode.TreeDataProvider<Node> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": async (node) => {
			if (node !== undefined) {
				return node.kind === "group" ? node.rules.map((listed) => ({ "kind": "rule", "listed": listed })) : [];
			}

			const rules = await list();

			view.message = rules === null ? "Open a folder to keep rules: they live in its .silo/ folder." : rules.length === 0 ? "None yet — make one with New Rule above, Rule… at a capability stop, or Mock… on process.argv's row." : undefined;

			if (rules === null || rules.length === 0) {
				return [];
			}

			const mine = rules.filter((listed) => listed.whose === "mine");
			const shared = rules.filter((listed) => listed.whose === "shared");

			return [
				...mine.length === 0 ? [] : [{ "kind": "group", "whose": "mine", "file": mine[0]!.file, "rules": mine } as const],
				...shared.length === 0 ? [] : [{ "kind": "group", "whose": "shared", "file": shared[0]!.file, "rules": shared } as const]
			];
		},
		"getTreeItem": (node) => {
			if (node.kind === "group") {
				const item = new vscode.TreeItem(node.whose === "mine" ? "Yours" : "Shared", vscode.TreeItemCollapsibleState.Expanded);

				item.description = node.file;
				item.tooltip = "Matched in this order — yours first, then the shared ones: the first rule that matches decides";
				item.contextValue = `rules.${node.whose}`;

				return item;
			}

			const { listed } = node;
			const found = placing(listed);
			const item = new vscode.TreeItem(listed.sentence, vscode.TreeItemCollapsibleState.None);

			item.iconPath = new vscode.ThemeIcon(listed.problem === undefined ? "law" : "error");
			item.description = listed.place?.line === undefined || listed.problem !== undefined ? undefined : `line ${listed.place.line}${found === "uncertain" ? "?" : ""}`;
			// (the whole sentence — a narrow sidebar cuts the label short — and what's to know about its place)
			const note = listed.problem !== undefined ? "Open it to fix it" : found === "uncertain" ? `Line ${listed.place?.line}, found by a match not sure enough to act on: it doesn't apply until it's placed again` : listed.place?.line !== undefined ? `Its statement is on line ${listed.place.line} now` : undefined;

			item.tooltip = note === undefined ? listed.sentence : `${listed.sentence}\n\n${note}`;
			item.contextValue = `rule.${listed.whose}${found === undefined ? "" : `.${found}`}`;
			item.command = { "command": "silo.rules.open", "title": "Open Rule", "arguments": [listed] };

			return item;
		}
	};
	const view = vscode.window.createTreeView("silo.rules", { "treeDataProvider": provider });
	const refresh = (): void => {
		listing = undefined;
		changed.fire();
	};
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/*policy.json");

	context.subscriptions.push(
		changed,
		view,
		watcher,
		watcher.onDidChange(refresh),
		watcher.onDidCreate(refresh),
		watcher.onDidDelete(refresh),
		// (a placed rule follows its code: where it is now changes as the file's saved)
		vscode.workspace.onDidSaveTextDocument(refresh),
		vscode.commands.registerCommand("silo.rules.refresh", refresh)
	);
}
