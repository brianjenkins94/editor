/**
 * Capabilities — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). Two responsibilities:
 *
 * 1. The STATIC half renders itself — a tsserver plugin (ts-plugin.js) publishes native ts.Diagnostics (squiggles
 *    + Problems), no host-side code needed. (Do NOT add a timer-based `restartTsServer` — it races the initial
 *    `updateOpen` and hangs the "Analyzing…" progress; see extensions/eslint/extension.ts.)
 *
 * 2. The DYNAMIC half (the middle column) is rendered HERE: a TreeView listing each capability call in the active
 *    file with its static value and the concrete RUNTIME value the canary observed. The canary (canary.ts, bundled
 *    with tsval) is served separately and loaded on demand via a native dynamic import of an absolute URL injected
 *    by workbench-entry (the extension is a data: URL and can't self-locate). M0 runs the canary INLINE in the ext
 *    host; a later milestone moves it to a dedicated worker so a long run can't block the host.
 */
import * as vscode from "vscode";

/** One capability call, as shown in the panel. Mirrors canary.ts's CanaryObservation (kept loose to avoid a
 *  build-time dep on the served engine's types). */
interface Observation {
	"capability": string;
	"callee": string;
	"value": string;
	"observed": boolean;
	"static"?: string;
	"start": number;
	"end": number;
	"dangerous": boolean;
}

type CanaryModule = { "runCanary": (src: string, fileName: string) => Promise<Observation[]> };

/** Native dynamic import of the served engine URL — `new Function` so the CJS bundler can't rewrite it to require. */
const importUrl = new Function("u", "return import(u);") as (url: string) => Promise<CanaryModule>;

const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);

export function activate(context: vscode.ExtensionContext): void {
	const canaryUrl = (globalThis as { "__CAPABILITIES_CANARY_URL__"?: string }).__CAPABILITIES_CANARY_URL__;

	let canary: Promise<CanaryModule> | undefined;
	const loadCanary = (): Promise<CanaryModule> => {
		if (canary === undefined) {
			canary = importUrl(canaryUrl!);
		}

		return canary;
	};

	let rows: Observation[] = [];
	const changed = new vscode.EventEmitter<void>();

	const provider: vscode.TreeDataProvider<Observation> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": (element) => (element === undefined ? rows : []),
		"getTreeItem": (row) => {
			const item = new vscode.TreeItem(row.callee, vscode.TreeItemCollapsibleState.None);
			// runtime value is the point of this column; fall back to the static literal, else say it didn't resolve.
			const runtime = row.observed ? row.value : row.static !== undefined ? row.static : "(ran; no string resource)";

			item.description = `${row.capability} → ${runtime}`;
			item.tooltip = new vscode.MarkdownString([
				`**${row.capability}**${row.dangerous ? " · ⚠ dangerous" : ""}`,
				"",
				`- callee: \`${row.callee}\``,
				`- static: ${row.static !== undefined ? "`" + row.static + "`" : "_unresolved_"}`,
				`- runtime: ${row.observed ? "`" + row.value + "`" : "_not observed as a string_"}`
			].join("\n"));
			item.iconPath = new vscode.ThemeIcon(row.dangerous ? "warning" : "circle-small-filled");

			return item;
		}
	};

	context.subscriptions.push(vscode.window.registerTreeDataProvider("capabilities.calls", provider));

	let token = 0;
	const analyze = async (document: vscode.TextDocument | undefined): Promise<void> => {
		const current = ++token;

		if (document === undefined || !LANGUAGES.has(document.languageId) || canaryUrl === undefined || canaryUrl === "") {
			rows = [];
			changed.fire();

			return;
		}

		try {
			const { runCanary } = await loadCanary();
			const observed = await runCanary(document.getText(), document.fileName);

			if (current === token) { // ignore a stale run superseded by a newer edit/switch
				rows = observed;
				changed.fire();
			}
		} catch (error) {
			if (current === token) {
				rows = [];
				changed.fire();
			}
		}
	};

	// Re-run on editor switch and on edits to the active doc (debounced — the canary run isn't free).
	let debounce: ReturnType<typeof setTimeout> | undefined;
	const schedule = (document: vscode.TextDocument | undefined, delay: number): void => {
		if (debounce !== undefined) {
			clearTimeout(debounce);
		}

		debounce = setTimeout(() => { void analyze(document); }, delay);
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => schedule(editor?.document, 0)),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document === vscode.window.activeTextEditor?.document) {
				schedule(event.document, 500);
			}
		})
	);

	void analyze(vscode.window.activeTextEditor?.document);
}

export function deactivate(): void { /* subscriptions disposed by the host */ }
