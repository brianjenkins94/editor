/**
 * Exceptions: what's outside the dependency baseline and the policy, to look at — a tree view beside Capability calls.
 *
 * The model: the baseline (`.silo/baseline.json`) is what each library's own code can do, by static analysis, as
 * libraries are added (baseline.ts keeps it, lib's syncPackages). The policy is the default stance on a
 * call beyond it — allowed, refused, or asked. Asked at the call, the person's answer is an exception to the policy:
 * allowed once, allowed always (a rule in their policy now, too), or refused — each recorded in its run (an effect's
 * `decided`), so it's on record whether or not their policy is committed.
 *
 * Two kinds of row:
 * - Grew: a library whose newer version can do more than it could when it was added — each capability with the version
 *   that grew it (the baseline's `packages` … `grew`) — or whose use by the code reaches more than it did, the members
 *   the code started using bringing it in (the join's: `consumer` … `grew`). That's outside the baseline, so it asks at
 *   the call unless the policy allows it ("Allow always" there is the approval, in the policy file's commit). A warning
 *   says when one turns up.
 * - Each run's exceptions, newest first: the answers given at the call, by the package (or the program) that made it.
 */
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages, Effect, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import { parseRuns } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, SILO_DIR } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

/** An answer given at the call: an exception to the policy. */
const EXCEPTIONS = new Set<Effect["decided"]>(["once", "always", "refused"]);

/** How an answer reads. */
const ANSWER: Record<string, string> = { "once": "allowed once", "always": "allowed always", "refused": "refused" };

/** A library that grew — a new version of it, or the code's use of it (`by`: what brought it in); an exception given at
 *  the call, in a run. */
type Node = { "kind": "grew"; "name": string; "version"?: string; "grew": Record<string, string>; "by": "version" | "code" } | { "kind": "exceptions"; "by": string; "found": { "effect": Effect; "run": RunEnvelope }[] } | { "kind": "exception"; "effect": Effect; "run": RunEnvelope };

/** What `uri` holds, or undefined when there's nothing there. */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
}

/** Every run committed in `.silo/runs/` (each person's file), and the baseline — undefined when there's none yet. */
async function load(root: vscode.Uri): Promise<{ "runs": RunEnvelope[]; "baseline"?: { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages } }> {
	const folder = vscode.Uri.joinPath(root, SILO_DIR, "runs");
	const names = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.map(([name]) => name), () => [] as string[]);
	const runs = (await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => parseRuns(await textOf(vscode.Uri.joinPath(folder, name)) ?? "")))).flat();
	const baseline = await textOf(vscode.Uri.joinPath(root, baselinePath()));

	return { "runs": runs, ...baseline === undefined ? {} : { "baseline": JSON.parse(baseline) as { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages } } };
}

/** What grew, each capability with what brought it in: `net (1.1.0)`, `net (fetchAll)`. */
const grewOf = (grew: Record<string, string>): string[] => Object.entries(grew).map(([capability, origin]) => `${capability} (${origin})`);

export function registerExceptions(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const changed = new vscode.EventEmitter<void>();
	let rows: Node[] = [];
	/** The growth already told of (undefined before the first look: what grew before then isn't news). */
	let known: Set<string> | undefined;

	const provider: vscode.TreeDataProvider<Node> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (node) => {
			if (node === undefined) {
				return rows;
			}

			return node.kind === "exceptions" ? node.found.map(({ effect, run }) => ({ "kind": "exception", "effect": effect, "run": run }) as const) : [];
		},
		"getTreeItem": (node) => {
			if (node.kind === "grew") {
				const item = new vscode.TreeItem(`${node.name} ${node.version ?? ""}`, vscode.TreeItemCollapsibleState.None);

				item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
				item.description = `${node.by === "code" ? "your use grew" : "grew"}: ${grewOf(node.grew).join(", ")}`;
				item.tooltip = node.by === "code" ? `Your code's use of ${node.name} reaches more than it did: ${grewOf(node.grew).join(", ")} — the members it started using. That asks at the call unless your policy allows it.` : `${node.name} can do more than when it was added: ${grewOf(node.grew).join(", ")}. That asks at the call unless your policy allows it.`;

				return item;
			}

			if (node.kind === "exceptions") {
				const item = new vscode.TreeItem(node.by, vscode.TreeItemCollapsibleState.Expanded);

				item.iconPath = new vscode.ThemeIcon(node.by === "the program" ? "file-code" : "package");
				item.description = `${node.found.length} exception${node.found.length === 1 ? "" : "s"} to the policy`;

				return item;
			}

			const { effect, run } = node;
			const item = new vscode.TreeItem(`${effect.capability}${effect.resource === "" ? "" : " " + effect.resource}`, vscode.TreeItemCollapsibleState.None);

			item.iconPath = new vscode.ThemeIcon(effect.decided === "refused" ? "circle-slash" : "pass");
			item.description = `${ANSWER[effect.decided ?? ""] ?? effect.decided} × ${effect.calls} · ${run.entry} · ${run.user} · ${run.endedAt.slice(0, 10)}`;
			item.tooltip = `${ANSWER[effect.decided ?? ""] ?? effect.decided}, ${effect.calls} time${effect.calls === 1 ? "" : "s"}, in run ${run.id} (${run.title}, by ${run.user}, ${run.endedAt})${effect.decided === "always" ? " — a rule in their policy now" : ""}`;

			return item;
		}
	};
	const view = vscode.window.createTreeView("silo.exceptions", { "treeDataProvider": provider });

	const refresh = async (): Promise<void> => {
		if (root === undefined) {
			view.message = "Open a folder: runs and the baseline live in its .silo/ folder.";

			return;
		}

		const { runs, baseline } = await load(root);
		const grew: Extract<Node, { "kind": "grew" }>[] = [
			...Object.entries(baseline?.packages ?? {}).filter(([, entry]) => entry.grew !== undefined).map(([name, entry]) => ({ "kind": "grew", "name": name, ...entry.version === undefined ? {} : { "version": entry.version }, "grew": entry.grew ?? {}, "by": "version" }) as const),
			// (the code's use, by workspace: `spec` in a workspace other than the root's says which)
			...Object.entries(baseline?.consumer ?? {}).flatMap(([workspace, entries]) => Object.entries(entries).filter(([, entry]) => entry.grew !== undefined).map(([spec, entry]) => ({ "kind": "grew", "name": workspace === "." ? spec : `${spec} (${workspace})`, ...entry.version === undefined ? {} : { "version": entry.version }, "grew": entry.grew ?? {}, "by": "code" }) as const))
		];
		const byWhom = new Map<string, { "effect": Effect; "run": RunEnvelope }[]>();

		for (const run of runs.toSorted((one, other) => other.endedAt.localeCompare(one.endedAt))) {
			for (const effect of run.effects ?? []) {
				if (EXCEPTIONS.has(effect.decided)) {
					const by = effect.package ?? "the program";

					byWhom.set(by, [...byWhom.get(by) ?? [], { "effect": effect, "run": run }]);
				}
			}
		}

		rows = [...grew.toSorted((one, other) => one.name.localeCompare(other.name)), ...[...byWhom].toSorted(([one], [other]) => one.localeCompare(other)).map(([by, found]) => ({ "kind": "exceptions", "by": by, "found": found }) as const)];
		if (baseline === undefined) {
			view.message = "No baseline: .silo/baseline.json, what each dependency's own code can do, is made as the project's dependencies are read — unless silo.baseline is off. Without it, the policy decides every package's call.";
		} else {
			view.message = rows.length === 0 ? "No library grew, and no exceptions to the policy." : undefined;
		}

		changed.fire();

		// Growth, said once (what grew before the view first looks isn't news — unless there was no baseline then).
		const now = new Set(grew.flatMap((row) => grewOf(row.grew).map((each) => `${row.name} ${each}`)));
		const told = known;

		known = baseline === undefined ? new Set() : now;

		const fresh = told === undefined ? [] : [...now].filter((each) => !told.has(each));

		if (fresh.length > 0 && await vscode.window.showWarningMessage(`${fresh[0]} — a library grew a capability: that asks at the call unless your policy allows it.${fresh.length > 1 ? ` (${fresh.length - 1} more)` : ""}`, "Show") === "Show") {
			await vscode.commands.executeCommand("silo.exceptions.focus");
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/{baseline.json,runs/*.jsonl}`);
	const again = (): void => {
		void refresh().catch(() => undefined);
	};

	context.subscriptions.push(changed, view, watcher, watcher.onDidCreate(again), watcher.onDidChange(again), watcher.onDidDelete(again));
	again();
}
