/**
 * Capabilities — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). It carries NO analysis code and does NO rendering: the analysis runs INSIDE
 * the tsserver plugin (ts-plugin.js), which has the real `ts` + Program/checker and publishes NATIVE
 * `ts.Diagnostic`s (source "capabilities") straight onto `getSemanticDiagnostics` — so the capability calls show
 * as ordinary squiggles + Problems entries + hover, no host-side decoding or decoration.
 *
 * activate() is a no-op (mirrors extensions/eslint). The tsserver plugin loads on the FIRST tsserver spawn; do
 * NOT add a timer-based `restartTsServer` — it races the initial `updateOpen` and hangs the "Analyzing…"
 * progress forever (documented at length in extensions/eslint/extension.ts).
 */
export function activate(): void { /* the tsserver plugin loads on first spawn — see extensions/eslint/extension.ts */ }

export function deactivate(): void { /* nothing to dispose */ }
