/**
 * ESLint — extension host entry (plain CJS, loads in the web-worker host that can't load ESM entrypoints:
 * CodinGame/monaco-vscode-api#818). It carries NO eslint/typescript code itself. The linting runs INSIDE the
 * tsserver plugin (ts-plugin.js), which has the real `ts`, reuses tsserver's typescript, and loads the engine
 * from a URL BAKED into its source at registration (workbench-entry.tsx). The plugin publishes native
 * `ts.Diagnostic`s (source "eslint"/"cspell"), so there's nothing to configure or render here.
 *
 * This activate() is intentionally a no-op. It used to `typescript.restartTsServer` on a timer to force a fresh
 * tsserver spawn that picks up the plugin — but that CAUSED the first-load "Analyzing '…' and its dependencies"
 * status bar spinner to hang forever: the timer fired while tsserver's very first `updateOpen` (opening the demo
 * file) was still in flight, and the restart killed that server before it answered. The TS extension binds the
 * "Analyzing" window progress to exactly that `updateOpen` response, so a killed-in-flight open orphaned the
 * progress — it spun forever on a cold load, and only "went away on refresh" because a warm reload finishes the
 * open in well under the timer (it was an intermittent race against the timer, which is why it was so slippery,
 * and why any tsserver logging — which shifts the timing — made it vanish).
 *
 * The restart turned out to be unnecessary: the plugin's files are registered (registerFileUrl) before the
 * workbench's deferred editor-open spawns tsserver, so the FIRST spawn already resolves them and the plugin loads
 * on its own — verified across cold and warm loads (eslint/cspell diagnostics present with no restart). So: no
 * restart, no race. Do NOT re-add a timer-based restart here; if a fresh spawn is ever needed, gate it on
 * something that proves the initial open has completed, never a blind delay.
 */
export function activate(): void { /* the tsserver plugin loads on first spawn — see the note above */ }

export function deactivate(): void { /* nothing to dispose */ }
