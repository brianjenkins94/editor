/**
 * Beyond the baseline: what runs saw a package do that `.silo/baseline.json` doesn't account for — a capability its own
 * code wasn't found to have when the baseline was made, or a package the baseline doesn't have — over every run
 * committed in `.silo/runs/` (lib's beyondBaseline: the same findings as `silo check`). A tree view beside Capability
 * calls: each package, by the version that did it, and under it each kind of call — what it reached, how many times, and
 * in which run. A badge counts the packages; a warning says when a run brings a new one.
 *
 * Nothing here changes the baseline: it's what was accepted, and a run never teaches it (a compromised version would
 * approve itself). Accepting what a package now does is an edit to baseline.json, made and reviewed as one.
 */
import type { BeyondBaseline, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import { beyondBaseline, parseRuns } from "@brianjenkins94/util/silo/evidence";
import { baselinePath, SILO_DIR } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

/** A package's findings (its row), or one of them (a row under it). */
type Node = { "kind": "package"; "package": string; "findings": BeyondBaseline[] } | { "kind": "finding"; "finding": BeyondBaseline };

/** A finding as itself, whichever run found it: what a new one is told apart by. */
const keyOf = (finding: BeyondBaseline): string => `${finding.package}\0${finding.capability}\0${finding.resource}\0${finding.how}`;

/** What `uri` holds, or undefined when there's nothing there. */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
	return Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
}

/** Every run committed in `.silo/runs/` (each person's file), and the baseline — undefined when there's none yet. */
async function load(root: vscode.Uri): Promise<{ "runs": RunEnvelope[]; "baseline"?: { "packages"?: Parameters<typeof beyondBaseline>[1] } }> {
	const folder = vscode.Uri.joinPath(root, SILO_DIR, "runs");
	const names = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).then((entries) => entries.map(([name]) => name), () => [] as string[]);
	const runs = (await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => parseRuns(await textOf(vscode.Uri.joinPath(folder, name)) ?? "")))).flat();
	const baseline = await textOf(vscode.Uri.joinPath(root, baselinePath()));

	return { "runs": runs, ...baseline === undefined ? {} : { "baseline": JSON.parse(baseline) as { "packages"?: Parameters<typeof beyondBaseline>[1] } } };
}

/** What happened to a call, as a sentence says it. */
const HOW: Record<BeyondBaseline["how"], string> = { "made": "made", "denied": "was refused", "given": "was given", "skipped": "skipped" };

/** How a finding reads: what was done to what, how, how often. */
function describe(finding: BeyondBaseline): string {
	const reached = finding.resource === "" ? "" : ` ${finding.resource}`;
	const how = finding.how === "made" ? "" : ` (${finding.how})`;

	return `${finding.capability}${reached}${how} × ${finding.calls}`;
}

export function registerBeyondBaseline(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const changed = new vscode.EventEmitter<void>();
	let packages: Node[] = [];
	/** The findings already told of (undefined before the first look: what's there then isn't news — unless there was no
	 *  baseline then, so nothing to tell). */
	let known: Set<string> | undefined;

	const provider: vscode.TreeDataProvider<Node> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (node) => {
			if (node === undefined) {
				return packages;
			}

			return node.kind === "package" ? node.findings.map((finding) => ({ "kind": "finding", "finding": finding }) as const) : [];
		},
		"getTreeItem": (node) => {
			if (node.kind === "package") {
				const [first] = node.findings;
				const item = new vscode.TreeItem(node.package, vscode.TreeItemCollapsibleState.Expanded);

				item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
				item.description = first.kind === "new" ? "not in the baseline" : `accepted: ${first.accepted?.caps.join(", ") || "nothing"}${first.accepted?.version === undefined || node.package.endsWith("@" + first.accepted.version) ? "" : ` (as ${first.accepted.version})`}`;
				item.tooltip = first.kind === "new" ? `${node.package} isn't in .silo/baseline.json: what it does was never accepted` : `.silo/baseline.json accepts ${first.accepted?.caps.join(", ") || "nothing"} of ${node.package.slice(0, node.package.lastIndexOf("@"))}${first.accepted?.version === undefined ? "" : ` ${first.accepted.version}`}; runs saw more`;

				return item;
			}

			const { finding } = node;
			const item = new vscode.TreeItem(describe(finding), vscode.TreeItemCollapsibleState.None);

			item.description = `${finding.run.entry} · ${finding.run.user} · ${finding.run.endedAt.slice(0, 10)}`;
			item.tooltip = `${finding.package} ${HOW[finding.how]} ${finding.capability}${finding.resource === "" ? "" : ` on ${finding.resource}`}, ${finding.calls} time${finding.calls === 1 ? "" : "s"}, in run ${finding.run.id} (${finding.run.entry}, by ${finding.run.user}, ${finding.run.endedAt})`;

			return item;
		}
	};
	const view = vscode.window.createTreeView("silo.beyondBaseline", { "treeDataProvider": provider });

	const refresh = async (): Promise<void> => {
		if (root === undefined) {
			view.message = "Open a folder: runs and the baseline live in its .silo/ folder.";

			return;
		}

		const { runs, baseline } = await load(root);

		if (baseline === undefined) {
			// (nothing to have told yet: once there's a baseline, what runs did beyond it is news)
			known ??= new Set();
			packages = [];
			view.message = "No baseline yet — the first run that keeps evidence makes .silo/baseline.json: what each dependency's own code can do.";
			view.badge = undefined;
			changed.fire();

			return;
		}

		const findings = beyondBaseline(runs, baseline.packages ?? {});
		const byPackage = new Map<string, BeyondBaseline[]>();

		for (const finding of findings) {
			byPackage.set(finding.package, [...byPackage.get(finding.package) ?? [], finding]);
		}

		packages = [...byPackage].toSorted(([one], [other]) => one.localeCompare(other)).map(([name, theirs]) => ({ "kind": "package", "package": name, "findings": theirs }));
		view.message = packages.length === 0 ? `Every package call ${runs.length} run${runs.length === 1 ? "" : "s"} made is within the baseline.` : undefined;
		view.badge = packages.length === 0 ? undefined : { "value": packages.length, "tooltip": `${packages.length} package${packages.length === 1 ? "" : "s"} did what the baseline doesn't account for` };
		changed.fire();

		// A new one, said once (what was there when the view first looked isn't news).
		const now = new Set(findings.map(keyOf));
		const told = known;
		const fresh = told === undefined ? [] : findings.filter((finding) => !told.has(keyOf(finding)));

		known = now;

		if (fresh.length > 0) {
			const [first] = fresh;
			const more = new Set(fresh.map((finding) => finding.package)).size - 1;
			const choice = await vscode.window.showWarningMessage(`${first.package} ${first.kind === "new" ? "isn't in the baseline and" : "went beyond its baseline:"} ${first.how === "made" ? "made" : first.how} ${first.capability}${first.resource === "" ? "" : ` (${first.resource})`} in ${first.run.entry}${more > 0 ? `, and ${more} more package${more === 1 ? "" : "s"}` : ""}.`, "Show");

			if (choice === "Show") {
				await vscode.commands.executeCommand("silo.beyondBaseline.focus");
			}
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/{baseline.json,runs/*.jsonl}`);
	const again = (): void => {
		void refresh().catch(() => undefined);
	};

	context.subscriptions.push(changed, view, watcher, watcher.onDidCreate(again), watcher.onDidChange(again), watcher.onDidDelete(again));
	again();
}
