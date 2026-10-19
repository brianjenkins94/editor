/** Adopt Web Awesome and the VS Code bridge into `workbench`'s document, and keep its mode class in step with the VS
 *  Code theme type. Returns a function that stops following. */
export function followVsCodeTheme(workbench: HTMLElement): () => void;
