/**
 * VS Code shell integration for our terminal: the OSC 633 sequences a desktop shell's integration script prints (bash,
 * zsh, pwsh), so VS Code knows where each prompt and command starts, what was run, where, and how it ended — just as
 * it would for a real shell. With them, the terminal gets VS Code's own command decorations (a dot by each command,
 * red when it failed), command navigation and sticky scroll, and extensions get the public shell-integration API
 * (`terminal.shellIntegration`, `window.onDidStart/EndTerminalShellExecution` with the command line and exit code) —
 * the extension point a desktop extension would use to see what runs in a terminal.
 *
 * A shell VS Code starts itself is handed a nonce to sign its command lines with; ours isn't, so they arrive marked
 * untrusted (`commandLine.isTrusted` false), still at high confidence.
 */

const OSC = "\x1b]633;";
const BEL = "\x07";

/** A value as VS Code reads it in a sequence: backslash, `;` and control characters (and space) escaped as `\xNN`. */
function escape(value: string): string {
	return value.replaceAll(/[\\;\x00-\x20]/gu, (char) => (char === "\\" ? "\\\\" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

/** A prompt starts (A) — before it's drawn. */
export const promptStart = (): string => `${OSC}A${BEL}`;

/** The prompt is drawn and the command line starts (B). */
export const commandStart = (): string => `${OSC}B${BEL}`;

/** What's about to run, as typed (E). */
export const commandLine = (line: string): string => `${OSC}E;${escape(line)}${BEL}`;

/** It runs: its output starts (C). */
export const commandExecuted = (): string => `${OSC}C${BEL}`;

/** It finished, with its exit code (D) — or, with none, the command line was abandoned before it ran. */
export const commandFinished = (exitCode?: number): string => `${OSC}D${exitCode === undefined ? "" : ";" + exitCode}${BEL}`;

/** The shell's working directory (P;Cwd). */
export const workingDirectory = (cwd: string): string => `${OSC}P;Cwd=${escape(cwd)}${BEL}`;
