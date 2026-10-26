/**
 * The Features view, in the Insights side bar: the workspace's tests grouped by the code they execute (lib
 * util/silo/test-features, over the traces `node --test` keeps — RUNNING.md, *Tests*). A feature, named by its tests;
 * under it its tests, each as it last came out, and its code — each declaration its tests reach, where it is now (a
 * click goes to it), or that it changed since they ran. The traces change as tests run, and the view with them.
 * `insights.features` answers the same, as data.
 *
 * A feature's decision is set here too (Set Status…): its status and why, into the feature ledger, `.silo/features.json`
 * (lib util/silo/ledger — shared, so it's committed with the code), by the feature's name and the files its code is in;
 * the view shows each one's status. `silo check` holds the code to it.
 */
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import type { LedgerStatus } from "@brianjenkins94/util/silo/ledger";
import type { Declaration, TestFeature } from "@brianjenkins94/util/silo/test-features";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { ledgerPath } from "@brianjenkins94/util/silo/layout";
import { ledgerText, parseLedger, withStatus } from "@brianjenkins94/util/silo/ledger";
import { featuresFromTests } from "@brianjenkins94/util/silo/test-features";
import { parseTraces } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";

/** A declaration where it is now: its file's uri and range, and its first line — or none, when its code changed. */
interface Placed { "declaration": Declaration; "uri": vscode.Uri; "range"?: vscode.Range; "label": string }

type Item = { "kind": "feature"; "feature": TestFeature; "code": Placed[] } | { "kind": "tests" | "code"; "feature": TestFeature; "code": Placed[] } | { "kind": "test"; "id": string; "outcome": string } | { "kind": "declaration"; "placed": Placed };

/** Every `.jsonl` under `folder`, recursively. */
async function jsonlUnder(folder: vscode.Uri): Promise<vscode.Uri[]> {
	const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch((): [string, vscode.FileType][] => []);
	const found = await Promise.all(entries.map(async ([name, type]) => {
		const uri = vscode.Uri.joinPath(folder, name);

		if ((type & vscode.FileType.Directory) !== 0) {
			return jsonlUnder(uri);
		}

		return name.endsWith(".jsonl") ? [uri] : [];
	}));

	return found.flat();
}

const textOf = async (uri: vscode.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

/** The workspace's features from its tests' traces, this machine's (`.silo/local/traces`): each declaration placed in
 *  its file as it is now. */
async function featuresIn(root: vscode.Uri): Promise<{ "features": TestFeature[]; "placed": Map<string, Placed>; "statuses": Map<string, string> }> {
	const files = await jsonlUnder(vscode.Uri.joinPath(root, ".silo/local/traces"));
	const traces: RunTrace[] = (await Promise.all(files.map(async (uri) => parseTraces(await textOf(uri) ?? "")))).flat();
	const { features } = featuresFromTests(traces);
	const placed = new Map<string, Placed>();
	const byFile = Map.groupBy(features.flatMap((feature) => feature.declarations), (declaration) => declaration.file);

	await Promise.all([...byFile].map(async ([file, declarations]) => {
		const uri = vscode.Uri.joinPath(root, file);
		const text = await textOf(uri);
		const answer = text === undefined ? undefined : await annotations(vscode.commands).spans(text).catch(() => undefined);
		const spans = answer !== undefined && "value" in answer ? new Map(answer.value.map((span) => [span.id, span])) : new Map();

		for (const declaration of declarations) {
			const span = spans.get(declaration.id);

			if (span === undefined || text === undefined) {
				placed.set(`${file}#${declaration.id}`, { "declaration": declaration, "uri": uri, "label": "changed since its tests ran" });
			} else {
				const before = text.slice(0, span.start);
				const line = before.split("\n").length - 1;
				const start = new vscode.Position(line, span.start - (before.lastIndexOf("\n") + 1));
				const lines = text.slice(span.start, span.end).split("\n");
				const end = new vscode.Position(line + lines.length - 1, lines.length === 1 ? start.character + lines[0].length : lines.at(-1)!.length);

				placed.set(`${file}#${declaration.id}`, { "declaration": declaration, "uri": uri, "range": new vscode.Range(start, end), "label": lines[0].trim().slice(0, 80) });
			}
		}
	}));

	const ledger = parseLedger(await textOf(vscode.Uri.joinPath(root, ledgerPath())));

	return { "features": features, "placed": placed, "statuses": new Map(Object.entries(ledger).map(([name, entry]) => [name, entry.status])) };
}

/** What each status means, as Set Status… offers them. */
const STATUS_PICKS: { "label": LedgerStatus; "detail": string }[] = [
	{ "label": "active", "detail": "Kept on purpose: say why it stays." },
	{ "label": "experiment", "detail": "Trying it: until a date, by when it's kept or removed." },
	{ "label": "parked", "detail": "Not now: kept, not worked on." },
	{ "label": "stopped", "detail": "Not wanted: `silo check` flags it while its code is still there." },
	{ "label": "removed", "detail": "Gone: a tombstone, so docs that still name it are flagged." }
];

/** Ask for `feature`'s status and why, and write it into the ledger: its name, the files its code is in. */
async function setStatus(root: vscode.Uri, feature: TestFeature): Promise<boolean> {
	const status = await vscode.window.showQuickPick(STATUS_PICKS, { "title": `${feature.name}: its status`, "placeHolder": "What's been decided about it" });

	if (status === undefined) {
		return false;
	}

	const why = await vscode.window.showInputBox({ "title": `${feature.name}: ${status.label}`, "prompt": "Why — what the decision rests on", "validateInput": (value) => (value.trim() === "" ? "Say why" : undefined) });

	if (why === undefined) {
		return false;
	}

	const until = status.label === "experiment" ? await vscode.window.showInputBox({ "title": `${feature.name}: until`, "prompt": "The date it's decided by (YYYY-MM-DD)", "validateInput": (value) => (/^\d{4}-\d\d-\d\d$/u.test(value) ? undefined : "YYYY-MM-DD") }) : undefined;

	if (status.label === "experiment" && until === undefined) {
		return false;
	}

	const file = vscode.Uri.joinPath(root, ledgerPath());
	const paths = [...new Set(feature.declarations.map((declaration) => declaration.file))].toSorted();
	const ledger = withStatus(parseLedger(await textOf(file)), feature.name, status.label, why.trim(), new Date().toISOString().slice(0, 10), { "paths": paths, ...until === undefined ? {} : { "until": until } });

	await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(ledgerText(ledger)));

	return true;
}

export function registerFeaturesView(context: vscode.ExtensionContext): void {
	const changed = new vscode.EventEmitter<undefined>();
	let shown: Awaited<ReturnType<typeof featuresIn>> = { "features": [], "placed": new Map(), "statuses": new Map() };
	const codeOf = (feature: TestFeature): Placed[] => feature.declarations.flatMap((declaration) => {
		const placed = shown.placed.get(`${declaration.file}#${declaration.id}`);

		return placed === undefined ? [] : [placed];
	});
	const provider: vscode.TreeDataProvider<Item> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (item) => {
			if (item === undefined) {
				return shown.features.map((feature): Item => ({ "kind": "feature", "feature": feature, "code": codeOf(feature) }));
			}

			if (item.kind === "feature") {
				return [{ "kind": "tests", "feature": item.feature, "code": item.code }, { "kind": "code", "feature": item.feature, "code": item.code }];
			}

			if (item.kind === "tests") {
				return item.feature.tests.map((test): Item => ({ "kind": "test", "id": test.id, "outcome": test.outcome }));
			}

			if (item.kind === "code") {
				return item.code.map((placed): Item => ({ "kind": "declaration", "placed": placed }));
			}

			return [];
		},
		"getTreeItem": (item) => {
			switch (item.kind) {
				case "feature": {
					const tree = new vscode.TreeItem(item.feature.name, vscode.TreeItemCollapsibleState.Collapsed);
					const files = new Set(item.feature.declarations.map((declaration) => declaration.file));

					const status = shown.statuses.get(item.feature.name);

					tree.description = `${status === undefined ? "" : status + " · "}${item.feature.tests.length} test${item.feature.tests.length === 1 ? "" : "s"} · ${[...files].join(", ")}`;
					tree.contextValue = "feature";
					tree.iconPath = new vscode.ThemeIcon(item.feature.tests.some((test) => test.outcome === "fail") ? "error" : "symbol-namespace");

					return tree;
				}

				case "tests":
				case "code": {
					const tree = new vscode.TreeItem(item.kind === "tests" ? "Tests" : "Code", vscode.TreeItemCollapsibleState.Expanded);

					tree.description = String(item.kind === "tests" ? item.feature.tests.length : item.code.length);

					return tree;
				}

				case "test": {
					const tree = new vscode.TreeItem(item.id.split(" › ").slice(1).join(" › ") || item.id, vscode.TreeItemCollapsibleState.None);

					tree.description = item.id.split(" › ")[0];
					tree.iconPath = new vscode.ThemeIcon({ "pass": "pass", "fail": "error", "skip": "debug-step-over", "todo": "circle-outline" }[item.outcome] ?? "circle-outline");

					return tree;
				}

				default: {
					const { placed } = item;
					const tree = new vscode.TreeItem(placed.label, vscode.TreeItemCollapsibleState.None);

					tree.description = placed.range === undefined ? placed.declaration.file : `${placed.declaration.file}:${placed.range.start.line + 1}`;

					if (placed.range !== undefined) {
						tree.command = { "command": "vscode.open", "title": "Go to it", "arguments": [placed.uri, { "selection": placed.range }] };
					}

					return tree;
				}
			}
		}
	};
	const view = vscode.window.createTreeView("insights.features", { "treeDataProvider": provider, "showCollapseAll": true });
	let pending: ReturnType<typeof setTimeout> | undefined;
	const refresh = async (): Promise<void> => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;

		shown = root === undefined ? { "features": [], "placed": new Map(), "statuses": new Map() } : await featuresIn(root);
		view.message = shown.features.length === 0 ? "No features yet: run your tests (node --test in the terminal), and what each one reaches groups them here." : undefined;
		changed.fire(undefined);
	};
	const soon = (): void => {
		clearTimeout(pending);
		pending = setTimeout(() => {
			void refresh();
		}, 500);
	};
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/{**/traces/**/*.jsonl,features.json}");

	context.subscriptions.push(changed, view, watcher, watcher.onDidCreate(soon), watcher.onDidChange(soon), watcher.onDidDelete(soon), view.onDidChangeVisibility(soon),
		// A feature's decision, into the ledger (from the view's item, or by name, as an agent or a test asks).
		vscode.commands.registerCommand("insights.setStatus", async (item?: Item | string, status?: LedgerStatus, why?: string) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri;
			const feature = typeof item === "string" ? shown.features.find((each) => each.name === item) : item?.kind === "feature" ? item.feature : undefined;

			if (root === undefined || feature === undefined) {
				return false;
			}

			if (status !== undefined && why !== undefined) {
				const file = vscode.Uri.joinPath(root, ledgerPath());
				const paths = [...new Set(feature.declarations.map((declaration) => declaration.file))].toSorted();

				await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(ledgerText(withStatus(parseLedger(await textOf(file)), feature.name, status, why, new Date().toISOString().slice(0, 10), { "paths": paths }))));
			} else if (!await setStatus(root, feature)) {
				return false;
			}

			await refresh();

			return true;
		}),
		// The view's features as data: each one's name, its tests and how each came out, and its code where it is now.
		vscode.commands.registerCommand("insights.features", async () => {
			await refresh();

			return shown.features.map((feature) => ({ "name": feature.name, ...shown.statuses.has(feature.name) ? { "status": shown.statuses.get(feature.name) } : {}, "tests": feature.tests, "code": codeOf(feature).map((placed) => ({ "file": placed.declaration.file, "id": placed.declaration.id, "label": placed.label, ...placed.range === undefined ? {} : { "line": placed.range.start.line + 1 } })) }));
		}),
		{ "dispose": () => { clearTimeout(pending); } });
	void refresh();
}
