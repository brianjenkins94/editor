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

/** Safety bucket for a row → the overlay color. `exec`/`eval` are singled out as the sharpest edge
 *  (irreversible), consequential writes are caution, everything else (reads, env) is the safe baseline. */
function bucketOf(row: DocRow): "safe" | "caution" | "danger" {
	if (row.capability === "exec" || row.capability === "eval") {
		return "danger";
	}

	return row.consequential ? "caution" : "safe";
}

/** The on-hover detail for a decorated capability call: what it resolved to, how, and the advice. */
function hoverFor(row: DocRow): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();

	markdown.appendMarkdown(`**\`${row.callee}\`**  ·  capability \`${row.capability}\`\n\n`);
	markdown.appendMarkdown("| | |\n|---|---|\n");
	markdown.appendMarkdown(`| property | ${row.property} |\n`);
	markdown.appendMarkdown(`| value | \`${row.value}\` |\n`);
	markdown.appendMarkdown(`| type | \`${row.type ?? "—"}\` |\n`);
	markdown.appendMarkdown(`| resolved by | ${row.resolvedBy} |\n`);
	markdown.appendMarkdown(`| disposition | **${row.disposition}**${row.consequential ? " · consequential" : ""} |\n`);

	return markdown;
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

	// The overlay proper: a dotted underline on each resolved capability call, colored by safety, plus a mark
	// in the overview ruler so the file's capability surface is visible at a glance. The resolved value /
	// property / disposition ride along as the per-decoration hover (hoverFor).
	const decorationType = (color: string): vscode.TextEditorDecorationType => vscode.window.createTextEditorDecorationType({
		"borderWidth": "0 0 1px 0",
		"borderStyle": "dashed",
		"borderColor": new vscode.ThemeColor(color),
		"overviewRulerColor": new vscode.ThemeColor(color),
		"overviewRulerLane": vscode.OverviewRulerLane.Right,
		"rangeBehavior": vscode.DecorationRangeBehavior.ClosedClosed
	});
	const decorations: Record<"safe" | "caution" | "danger", vscode.TextEditorDecorationType> = {
		"safe": decorationType("charts.green"),
		"caution": decorationType("charts.yellow"),
		"danger": decorationType("charts.red")
	};

	context.subscriptions.push(decorations.safe, decorations.caution, decorations.danger);

	const setOverlay = (editor: vscode.TextEditor, rows: DocRow[]): void => {
		const buckets: Record<"safe" | "caution" | "danger", vscode.DecorationOptions[]> = { "safe": [], "caution": [], "danger": [] };

		for (const row of rows) {
			// Floating rows have no source span to decorate — they stay in the output table only.
			if (row.cst !== undefined) {
				buckets[bucketOf(row)].push({
					"range": new vscode.Range(editor.document.positionAt(row.cst.start), editor.document.positionAt(row.cst.end)),
					"hoverMessage": hoverFor(row)
				});
			}
		}

		editor.setDecorations(decorations.safe, buckets.safe);
		editor.setDecorations(decorations.caution, buckets.caution);
		editor.setDecorations(decorations.danger, buckets.danger);
	};

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
			setOverlay(editor, []); // clear stale decorations while a fresh analysis is in flight
		} else if (payload.error !== undefined) {
			output.appendLine("  engine error:");
			output.appendLine("  " + payload.error);
			setOverlay(editor, []);
		} else {
			output.appendLine(formatRows([...(payload.rows ?? []), ...(payload.floating ?? [])], document.getText()));
			setOverlay(editor, payload.rows ?? []);
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
