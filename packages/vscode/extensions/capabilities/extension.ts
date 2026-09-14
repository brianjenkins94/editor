/**
 * Capabilities — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). Two responsibilities:
 *
 * 1. The tsserver plugin (ts-plugin.js) runs BOTH halves inside tsserver — static (util/silo) + the tsval canary,
 *    reusing tsserver's own `ts` — and publishes NATIVE ts.Diagnostics (source "capabilities"): squiggles +
 *    Problems + hover, with the concrete runtime value merged in once the canary's background run completes.
 *    (Do NOT add a timer-based `restartTsServer` — it races the initial `updateOpen` and hangs the "Analyzing…"
 *    progress; see extensions/eslint/extension.ts.)
 *
 * 2. The "Capability calls" panel (the middle column) is rendered HERE by READING those diagnostics back
 *    (`vscode.languages.getDiagnostics`, filtered to source "capabilities") — the clean, sentinel-free channel out
 *    of tsserver. No canary code runs in the ext host; the panel just reflects what the plugin published.
 */
import * as vscode from "vscode";

interface Row {
	"capability": string;
	"callee": string;
	"value": string;
	"dangerous": boolean;
	"range": vscode.Range;
}

/** Parse the plugin's diagnostic message "capability: callee → value (ran) · type" into its parts. Best-effort:
 *  fields fall back to the raw message so a format change degrades rather than breaks. */
function parseMessage(message: string): { "capability": string; "callee": string; "value": string } {
	const arrow = message.indexOf(" → ");
	const head = arrow === -1 ? message : message.slice(0, arrow);
	let value = arrow === -1 ? "" : message.slice(arrow + 3);
	const typeSep = value.indexOf(" · ");

	if (typeSep !== -1) {
		value = value.slice(0, typeSep);
	}

	const colon = head.indexOf(": ");

	return {
		"capability": colon === -1 ? "" : head.slice(0, colon),
		"callee": colon === -1 ? head : head.slice(colon + 2),
		"value": value
	};
}

export function activate(context: vscode.ExtensionContext): void {
	let rows: Row[] = [];
	const changed = new vscode.EventEmitter<void>();

	const provider: vscode.TreeDataProvider<Row> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (element) => (element === undefined ? rows : []),
		"getTreeItem": (row) => {
			const item = new vscode.TreeItem(row.callee, vscode.TreeItemCollapsibleState.None);

			item.description = `${row.capability} → ${row.value}`;
			item.tooltip = new vscode.MarkdownString([
				`**${row.capability}**${row.dangerous ? " · ⚠ dangerous" : ""}`,
				"",
				`- callee: \`${row.callee}\``,
				`- resource: ${row.value !== "" ? "`" + row.value + "`" : "_unresolved_"}`
			].join("\n"));
			item.iconPath = new vscode.ThemeIcon(row.dangerous ? "warning" : "circle-small-filled");
			// Click a row → jump to the call in the editor.
			item.command = {
				"command": "vscode.open",
				"title": "Go to call",
				"arguments": [vscode.window.activeTextEditor?.document.uri, { "selection": row.range }]
			};

			return item;
		}
	};

	context.subscriptions.push(vscode.window.registerTreeDataProvider("capabilities.calls", provider));

	const refresh = (): void => {
		const editor = vscode.window.activeTextEditor;

		if (editor === undefined) {
			rows = [];
			changed.fire();

			return;
		}

		const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).filter((diagnostic) => diagnostic.source === "capabilities");

		rows = diagnostics.map((diagnostic) => {
			const parsed = parseMessage(diagnostic.message);

			return {
				"capability": parsed.capability,
				"callee": parsed.callee,
				"value": parsed.value,
				"dangerous": diagnostic.severity === vscode.DiagnosticSeverity.Warning,
				"range": diagnostic.range
			};
		});
		changed.fire();
	};

	context.subscriptions.push(
		// The plugin re-publishes (with runtime values) after the canary's async run → onDidChangeDiagnostics fires.
		vscode.languages.onDidChangeDiagnostics((event) => {
			const uri = vscode.window.activeTextEditor?.document.uri;

			if (uri !== undefined && event.uris.some((changedUri) => changedUri.toString() === uri.toString())) {
				refresh();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(() => { refresh(); })
	);

	refresh();
}

export function deactivate(): void { /* subscriptions disposed by the host */ }
