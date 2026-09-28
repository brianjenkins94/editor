/**
 * ESLint — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). This is the WEB implementation of `dbaeumer.vscode-eslint`: the manifest claims
 * that id, so a repo's `.vscode/settings.json` written for the desktop extension (defaultFormatter,
 * `source.fixAll.eslint`, `eslint.*`) means the same thing here. The desktop extension runs an eslint language
 * server under Node, which the browser can't host; here the linter runs INSIDE the tsserver plugin (ts-plugin.js),
 * reusing tsserver's own `ts`, and this entry only bridges VS Code features to it:
 *
 *   • settings → the plugin: `eslint.enable` / `validate` / `rules.customizations` go over the TS extension's
 *     `_typescript.configurePlugin` command, so diagnostics (native ts.Diagnostics, source "eslint") honor them.
 *   • `source.fixAll.eslint` (what `editor.codeActionsOnSave` runs) and the formatter both call the plugin's
 *     `_eslint.fixAll` request through `typescript.tsserverRequest`, sending the document text.
 *   • the formatter is registered only while `eslint.format.enable` is true — the desktop extension's default is
 *     false, so `editor.defaultFormatter` alone doesn't make eslint format on either side.
 *
 * Never restart tsserver from here: a timed `typescript.restartTsServer` once raced the initial `updateOpen` and
 * left the "Analyzing '…' and its dependencies" progress spinning forever. The plugin loads on the first spawn
 * (its files are registered before the deferred editor-open starts tsserver), and settings reach it through
 * `configurePlugin`, which needs no restart.
 */
import * as vscode from "vscode";

const PLUGIN = "eslint-ts-plugin";
const LANGUAGES = ["javascript", "javascriptreact", "typescript", "typescriptreact"];
const FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("eslint");

/** The eslint settings the plugin needs, read the way the desktop extension reads them. */
function pluginSettings(): Record<string, unknown> {
	const config = vscode.workspace.getConfiguration("eslint");
	const customizations = config.get<unknown>("rules.customizations");

	return {
		"enable": config.get<boolean>("enable", true),
		"validate": config.get<string[] | null>("validate", null),
		"rulesCustomizations": Array.isArray(customizations)
			? customizations.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["rule"] === "string" && typeof (entry as Record<string, unknown>)["severity"] === "string")
			: []
	};
}

/** Push the settings to the tsserver plugin. Through the TS extension's `_typescript.configurePlugin` COMMAND, not
 *  its `getAPI(0).configurePlugin`: the TS extension runs in another extension host, where `getExtension` can't see
 *  it, and commands cross hosts. It keeps the config and re-sends it whenever tsserver (re)starts. */
async function configurePlugin(): Promise<void> {
	await vscode.commands.executeCommand("_typescript.configurePlugin", PLUGIN, { "settings": pluginSettings() });
}

/** The first push: at startup the TS extension may not have registered its command yet (an internal `_` command
 *  doesn't activate it), so retry briefly until it takes. */
async function configurePluginWhenReady(attempts = 20): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			await configurePlugin();

			return;
		} catch {
			await new Promise((resolve) => { setTimeout(resolve, 500); });
		}
	}
}

/** Every autofix for the document, via the plugin — the fixed text, or undefined when there's nothing to fix. */
async function fixAll(document: vscode.TextDocument): Promise<string | undefined> {
	const response = await vscode.commands.executeCommand<{ "body"?: { "output"?: unknown; "fixed"?: unknown } } | undefined>(
		"typescript.tsserverRequest", "_eslint.fixAll", { "file": document.uri, "text": document.getText() }
	);
	const body = response?.body;

	return body?.fixed === true && typeof body.output === "string" && body.output !== document.getText() ? body.output : undefined;
}

function wholeDocument(document: vscode.TextDocument): vscode.Range {
	return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

export function activate(context: vscode.ExtensionContext): void {
	const selector = LANGUAGES.map((language) => ({ "language": language }));

	void configurePluginWhenReady();

	context.subscriptions.push(vscode.languages.registerCodeActionsProvider(selector, {
		"provideCodeActions": async (document, _range, codeContext) => {
			// Only as a source action (save / "Fix all"), never as a lightbulb on every cursor move.
			if (codeContext.only === undefined || !FIX_ALL.intersects(codeContext.only)) {
				return [];
			}

			const output = await fixAll(document);

			if (output === undefined) {
				return [];
			}

			const action = new vscode.CodeAction("Fix all auto-fixable problems", FIX_ALL);

			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(document.uri, wholeDocument(document), output);

			return [action];
		}
	}, { "providedCodeActionKinds": [FIX_ALL] }));

	// The formatter follows `eslint.format.enable` (default false, as on desktop).
	let formatter: vscode.Disposable | undefined;

	const syncFormatter = (): void => {
		const enabled = vscode.workspace.getConfiguration("eslint").get<boolean>("format.enable", false);

		if (enabled && formatter === undefined) {
			formatter = vscode.languages.registerDocumentFormattingEditProvider(selector, {
				"provideDocumentFormattingEdits": async (document) => {
					const output = await fixAll(document);

					return output === undefined ? [] : [vscode.TextEdit.replace(wholeDocument(document), output)];
				}
			});
		} else if (!enabled && formatter !== undefined) {
			formatter.dispose();
			formatter = undefined;
		}
	};

	syncFormatter();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("eslint")) {
			void configurePluginWhenReady();
			syncFormatter();
		}
	}), { "dispose": () => formatter?.dispose() });
}

export function deactivate(): void { /* subscriptions are disposed with the context */ }
