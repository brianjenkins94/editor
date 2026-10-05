/**
 * The right-hand side's renderer (LIVE-VALUES.md): a note's Markdown as VS Code renders it (sanitized: a note may be
 * anyone's), its code blocks by Code Hike — the changes pane's way (git-codehike.tsx): `highlight` with shiki's GitHub
 * theme for the workbench's light or dark, `<Pre>` in a React root of its own. The component's frame (`showPane`) places
 * what this renders beside the code.
 *
 * Loaded on first use, so React, Code Hike and shiki stay out of the workbench's first load.
 */
import type { Root } from "react-dom/client";
import { renderMarkdown } from "@brianjenkins94/monaco-vscode-api/main";
import { highlight, Pre } from "codehike/code";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

/** Shiki's GitHub theme for the workbench's own light or dark (VS Code marks the body `vs` or `vs-dark`/`hc-black`). */
function theme(): string {
	return document.body.classList.contains("vs-dark") || document.body.classList.contains("hc-black") ? "github-dark" : "github-light";
}

/** Render a note's Markdown into `element`; what's returned takes it away. */
export function renderNote(element: HTMLElement, text: string): () => void {
	const roots: Root[] = [];
	const rendered = renderMarkdown(text, async (languageId: string, value: string) => {
		const host = document.createElement("div");
		const code = await highlight({ "value": value, "lang": languageId || "js", "meta": "" }, theme());
		const root = createRoot(host);

		roots.push(root);
		root.render(createElement(Pre, { "code": code, "style": { "margin": "4px 0", "padding": "6px 8px", "borderRadius": "4px", "fontFamily": "var(--notes-margin-code-font-family, monospace)", "fontSize": "var(--notes-margin-code-font-size)", ...code.style } }));

		return host;
	});

	element.append(rendered.element);

	return () => {
		rendered.dispose();

		for (const root of roots) {
			root.unmount();
		}
	};
}
