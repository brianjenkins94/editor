/** VS Code's active colour theme: its `--vscode-*` variables (not the icons') and its kind (a webview's
 *  `data-vscode-theme-kind`: vscode-light, vscode-dark, vscode-high-contrast, vscode-high-contrast-light). */
export interface VsCodeColors { "kind": string; "vars": Record<string, string> }

/** The active theme's colours, from `.monaco-workbench` in VS Code's document. */
export function readVsCodeColors(workbench: HTMLElement): VsCodeColors;

/** Set them on `element` (the shell's body), with the theme's kind and Web Awesome's mode for it. */
export function applyVsCodeColors(element: HTMLElement, colors: VsCodeColors): void;
