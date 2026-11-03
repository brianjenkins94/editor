/**
 * The build's half of the command tap (extensions/command-tap.ts; ARCHITECTURE.md, *Discovered, not declared*): an
 * extension bundled with it gets a `vscode` whose commands and file operations are counted, so the architecture view
 * discovers them.
 */
import type { Plugin } from "vite";
import * as url from "node:url";

/** The module an extension's `vscode` imports resolve to: its own `vscode` is the real one (external). */
export const TAPPED_VSCODE = "\0vscode-tapped";

/** Hand extension `name` a `vscode` whose commands and file operations are counted: every `import … from "vscode"` in
 *  it resolves to a module that is the real `vscode` but for `commands` and `workspace.fs`. */
export function commandTap(name: string): Plugin {
	const tapped = TAPPED_VSCODE;
	const tap = url.fileURLToPath(new URL("../extensions/command-tap.ts", import.meta.url));

	return {
		"name": "command-tap",
		"enforce": "pre",
		// The tapped module's own `vscode` is the real one (external).
		"resolveId": (source, importer) => (source === "vscode" && importer !== tapped ? tapped : undefined),
		"load": (id) => (id === tapped ? `import * as vscode from "vscode";\nimport { tappedCommands, tappedWorkspace } from ${JSON.stringify(tap)};\nexport * from "vscode";\nexport const commands = tappedCommands(vscode, ${JSON.stringify(name)});\nexport const workspace = tappedWorkspace(vscode, ${JSON.stringify(name)});\n` : undefined)
	};
}
