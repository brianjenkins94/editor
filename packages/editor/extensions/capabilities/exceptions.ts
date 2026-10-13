/**
 * Exceptions: what's outside the dependency baseline and the policy, to look at — a tree view beside Capability calls.
 *
 * The model: the baseline (`.silo/baseline.json`) is what each library's own code can do, by static analysis, as
 * libraries are added (the workbench's baseline.ts keeps it, lib's syncPackages). The policy is the default stance on a
 * call beyond it — allowed, refused, or asked. Asked at the call, the person's answer is an exception to the policy:
 * allowed once, allowed always (a rule in their policy now, too), or refused — each recorded in its run (an effect's
 * `decided`), so it's on record whether or not their policy is committed.
 *
 * Two kinds of row:
 * - Pending acceptance: a library's newer version that can do more than what was accepted of it. What's new in it asks
 *   at the call until it's accepted (Accept: lib's acceptPending — the approval a person makes, never a run). A warning
 *   says when one turns up.
 * - Each run's exceptions, newest first: the answers given at the call, by the package (or the program) that made it.
 */
import type { AcceptedPackages, Effect, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import { acceptPending, covers, parseRuns } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, SILO_DIR } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

/** An answer given at the call: an exception to the policy. */
const EXCEPTIONS = new Set<Effect["decided"]>(["once", "always", "refused"]);

/** How an answer reads. */
const ANSWER: Record<string, string> = { "once": "allowed once", "always": "allowed always", "refused": "refused" };

/** A library whose newer version waits for acceptance; an exception given at the call, in a run. */
type Node = { "kind": "pending"; "name": string; "accepted": AcceptedPackages[string] } | { "kind": "exceptions"; "by": string; "found": { "effect": Effect; "run": RunEnvelope }[] } | { "kind": "exception"; "effect": Effect; "run": RunEnvelope };

/** What `uri` holds, or undefined when there's nothing there. */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
}

/** Every run committed in `.silo/runs/` (each person's file), and the baseline — undefined when there's none yet. */
async function load(root: vscode.Uri): Promise<{ "runs": RunEnvelope[]; "baseline"?: { "consumer"?: unknown; "packages"?: AcceptedPackages } }> {
	const folder = vscode.Uri.joinPath(root, SILO_DIR, "runs");
	const names = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.map(([name]) => name), () => [] as string[]);
	const runs = (await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => parseRuns(await textOf(vscode.Uri.joinPath(folder, name)) ?? "")))).flat();
	const baseline = await textOf(vscode.Uri.joinPath(root, baselinePath()));

	return { "runs": runs, ...baseline === undefined ? {} : { "baseline": JSON.parse(baseline) as { "consumer"?: unknown; "packages"?: AcceptedPackages } } };
}

/** What a pending version can do that the accepted one can't. */
const newIn = (entry: AcceptedPackages[string]): string[] => (entry.pending?.caps ?? []).filter((capability) => !covers(entry.caps, capability));

export function registerExceptions(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const changed = new vscode.EventEmitter<void>();
	let rows: Node[] = [];
	/** The pending versions already told of (undefined before the first look: what's pending then isn't news). */
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
			if (node.kind === "pending") {
				const { accepted } = node;
				const item = new vscode.TreeItem(`${node.name} ${accepted.pending?.version ?? ""}`, vscode.TreeItemCollapsibleState.None);

				item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
				item.description = `pending acceptance — can also: ${newIn(accepted).join(", ")}`;
				item.tooltip = `${node.name} ${accepted.pending?.version ?? ""} can do more than what was accepted of ${accepted.version ?? "it"} (${accepted.caps.join(", ") || "nothing"}): ${newIn(accepted).join(", ")}. Until it's accepted, that asks at the call.`;
				item.contextValue = "exceptions.pending";

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
		const pending = Object.entries(baseline?.packages ?? {}).filter(([, entry]) => entry.pending !== undefined).map(([name, entry]) => ({ "kind": "pending", "name": name, "accepted": entry }) as const);
		const byWhom = new Map<string, { "effect": Effect; "run": RunEnvelope }[]>();

		for (const run of runs.toSorted((one, other) => other.endedAt.localeCompare(one.endedAt))) {
			for (const effect of run.effects ?? []) {
				if (EXCEPTIONS.has(effect.decided)) {
					const by = effect.package ?? "the program";

					byWhom.set(by, [...byWhom.get(by) ?? [], { "effect": effect, "run": run }]);
				}
			}
		}

		rows = [...pending.toSorted((one, other) => one.name.localeCompare(other.name)), ...[...byWhom].toSorted(([one], [other]) => one.localeCompare(other)).map(([by, found]) => ({ "kind": "exceptions", "by": by, "found": found }) as const)];
		view.badge = pending.length === 0 ? undefined : { "value": pending.length, "tooltip": `${pending.length} librar${pending.length === 1 ? "y waits" : "ies wait"} for acceptance` };

		if (baseline === undefined) {
			view.message = "No baseline yet — the first run that keeps evidence makes .silo/baseline.json: what each dependency's own code can do.";
		} else {
			view.message = rows.length === 0 ? "Nothing pending acceptance, and no exceptions to the policy." : undefined;
		}

		changed.fire();

		// A version newly pending, said once (what's pending when the view first looks isn't news — unless there was no
		// baseline then).
		const now = new Set(pending.map(({ name, accepted }) => `${name}@${accepted.pending?.version ?? ""}`));
		const told = known;

		known = baseline === undefined ? new Set() : now;

		const fresh = told === undefined ? [] : pending.filter(({ name, accepted }) => !told.has(`${name}@${accepted.pending?.version ?? ""}`));

		if (fresh.length > 0) {
			const [first] = fresh;
			const choice = await vscode.window.showWarningMessage(`${first.name} ${first.accepted.pending?.version ?? ""} can also ${newIn(first.accepted).join(", ")} — pending acceptance: until then, that asks at the call.${fresh.length > 1 ? ` (${fresh.length - 1} more)` : ""}`, "Accept", "Show");

			if (choice === "Accept") {
				await vscode.commands.executeCommand("silo.exceptions.accept", first);
			} else if (choice === "Show") {
				await vscode.commands.executeCommand("silo.exceptions.focus");
			}
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/{baseline.json,runs/*.jsonl}`);
	const again = (): void => {
		void refresh().catch(() => undefined);
	};

	context.subscriptions.push(changed, view, watcher, watcher.onDidCreate(again), watcher.onDidChange(again), watcher.onDidDelete(again), vscode.commands.registerCommand("silo.exceptions.accept", async (node?: { "name"?: unknown }) => {
		const uri = root === undefined ? undefined : vscode.Uri.joinPath(root, baselinePath());
		const text = uri === undefined ? undefined : await textOf(uri);

		if (uri === undefined || text === undefined || typeof node?.name !== "string") {
			return;
		}

		// (written as silo's saveBaseline writes it: the accepted version is now what's accepted of it — an approval, to commit)
		const baseline = JSON.parse(text) as { "consumer"?: unknown; "packages"?: AcceptedPackages };

		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ ...baseline, "packages": acceptPending(baseline.packages ?? {}, node.name) }, undefined, 2) + "\n"));
	}));
	again();
}
