/** Adopt Web Awesome and the VS Code bridge into `element`'s document (`.monaco-workbench`, or a webview's `body`),
 *  and keep its mode class in step with the VS Code theme type. Returns a function that stops following. */
export function followVsCodeTheme(element: HTMLElement): () => void;

/** Follow the VS Code theme in a document VS Code opens a window into (a docked editor window): adopt the styles
 *  there, and follow its `.monaco-workbench` once VS Code makes it. Returns a function that stops. */
export function followVsCodeThemeIn(document: Document): () => void;
