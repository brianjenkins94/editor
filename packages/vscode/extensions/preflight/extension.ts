/**
 * Capability Preflight — extension host entry (plain CJS, loads in any host incl. the web-worker host that
 * can't load ESM entrypoints: CodinGame/monaco-vscode-api#818).
 *
 * Route 3 (B): the analysis engine no longer runs here. It runs INSIDE the tsserver plugin (ts-plugin.js),
 * which has the real `ts` + Program/TypeChecker and reuses tsserver's typescript (no bundled copy). This host
 * extension just: (1) hands the plugin the served engine URL via `_typescript.configurePlugin`, and (2) reads
 * the plugin's findings — streamed as a `Suggestion` diagnostic carrying `@@PFR@@<json>@@PFR@@` — and renders
 * them. So there's no ESM/wasm/typescript in this bundle at all.
 */
import * as vscode from "vscode";

/** A finding row, as produced by the engine in the plugin and enriched with the real-checker `type`. */
interface DocRow {
	"cst"?: { "type": string; "start": number; "end": number };
	"capability": string;
	"callee": string;
	"value": string;
	"resolvedBy": "static" | "dynamic" | "floating";
	"property": string;
	"disposition": string;
	"consequential": boolean;
	"type"?: string;
}

/** The plugin's channel payload: findings, or a pending/error status. */
interface Payload { "rows"?: DocRow[]; "floating"?: DocRow[]; "pending"?: boolean; "error"?: string }

/** The plugin wraps its JSON payload in these sentinels inside a diagnostic message. */
const PAYLOAD = /@@PFR@@([\s\S]*?)@@PFR@@/;

/** Read the preflight plugin's latest payload for a document from its streamed diagnostic. */
function readPayload(uri: vscode.Uri): Payload | undefined {
	for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
		if (diagnostic.source === "preflight") {
			const match = PAYLOAD.exec(diagnostic.message);

			if (match !== null) {
				try {
					return JSON.parse(match[1]) as Payload;
				} catch { /* ignore a malformed payload */ }
			}
		}
	}

	return undefined;
}

/** Render the rows as an aligned table — the textual form of the overlay's columns 2+3. */
function formatRows(rows: DocRow[], text: string): string {
	if (rows.length === 0) {
		return "  (no capability findings)";
	}

	const nodeText = (row: DocRow): string => (row.cst === undefined ? "(floating)" : JSON.stringify(text.slice(row.cst.start, row.cst.end)));
	const cells = [
		["disposition", "capability", "property", "type", "value", "resolved", "node"],
		...rows.map((row) => [row.disposition, row.capability, row.property, row.type ?? "—", row.value, `[${row.resolvedBy}]`, nodeText(row)])
	];
	const widths = cells[0].map((_, column) => Math.max(...cells.map((line) => line[column].length)));

	return cells.map((line) => "  " + line.map((cell, column) => (column === line.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ").trimEnd()).join("\n");
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Preflight");

	context.subscriptions.push(output);

	const render = (): void => {
		const editor = vscode.window.activeTextEditor;

		if (editor === undefined) {
			return;
		}

		const document = editor.document;
		const payload = readPayload(document.uri);

		output.clear();
		output.appendLine(`Preflight: ${document.fileName}`);
		output.appendLine("");

		if (payload === undefined || payload.pending === true) {
			output.appendLine("  analyzing… (tsserver plugin)");
		} else if (payload.error !== undefined) {
			output.appendLine("  engine error:");
			output.appendLine("  " + payload.error);
		} else {
			output.appendLine(formatRows([...(payload.rows ?? []), ...(payload.floating ?? [])], document.getText()));
		}
	};

	const run = (): void => {
		output.show(true);
		render();
	};

	context.subscriptions.push(vscode.commands.registerCommand("preflight.run", run));

	// Re-render when the active editor changes, and whenever the plugin publishes new findings for it.
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { render(); }));
	context.subscriptions.push(vscode.languages.onDidChangeDiagnostics((event) => {
		const active = vscode.window.activeTextEditor?.document.uri.toString();

		if (active !== undefined && event.uris.some((uri) => uri.toString() === active)) {
			render();
		}
	}));

	// Hand the plugin the typescript-external engine URL so it can load + run the engine inside tsserver.
	// Derived from the (reliably-injected, persisted) engineUrl base by swapping the filename — boot won't
	// apply a second/changed injected setting over the workbench's persisted config. Persisted by the TS
	// extension across tsserver restarts, so sending it once is enough.
	const engineBase = vscode.workspace.getConfiguration("preflight").get<string>("engineUrl");
	const engineUrl = engineBase === undefined ? undefined : engineBase.replace(/engine\.js(\?.*)?$/u, "engine.plugin.js");

	if (engineUrl !== undefined && engineUrl !== "") {
		void vscode.commands.executeCommand("_typescript.configurePlugin", "preflight-ts-plugin", { "engineUrl": engineUrl });
	}

	// The plugin's files are registered by the host after boot; tsserver snapshots the static browser-URI map
	// (which resolves them) at SPAWN, so a server started before registration can't fetch the plugin. Restart
	// once so a fresh spawn picks it up deterministically.
	setTimeout(() => { void vscode.commands.executeCommand("typescript.restartTsServer"); }, 1500);

	run();
}

export function deactivate(): void { /* the channel + subscriptions are disposed via context.subscriptions */ }
