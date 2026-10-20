/** Adopt Web Awesome and the VS Code bridge into `element`'s document (`.monaco-workbench`, or a webview's `body`),
 *  and keep its mode class in step with the VS Code theme type. Returns a function that stops following. */
export function followVsCodeTheme(element: HTMLElement): () => void;
