/**
 * ESLint — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). It carries NO eslint/typescript code itself. The linting runs INSIDE the
 * tsserver plugin (ts-plugin.js), which has the real `ts`, reuses tsserver's typescript, and loads the engine
 * from a URL BAKED into its source at registration (workbench-entry.tsx). The plugin publishes native
 * `ts.Diagnostic`s (source "eslint"), so there's nothing to configure or render here.
 *
 * This host's one job: the plugin's files are registered AFTER boot (registerFileUrl), but tsserver snapshots
 * the static browser-URI map that resolves them at SPAWN — so a server started before registration can't fetch
 * the plugin. Restart tsserver once so a fresh spawn picks it up deterministically.
 */
import * as vscode from "vscode";

export function activate(): void {
	setTimeout(() => { void vscode.commands.executeCommand("typescript.restartTsServer"); }, 1500);
}

export function deactivate(): void { /* nothing to dispose */ }
