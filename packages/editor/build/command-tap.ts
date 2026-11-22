import type { Plugin } from "vite";
import * as url from "node:url";

export const TAPPED_VSCODE = "\0vscode-tapped";

export function commandTap(name: string): Plugin {
	const tapped = TAPPED_VSCODE;
	const tap = url.fileURLToPath(new URL("../extensions/command-tap.ts", import.meta.url));

	return {
		"name": "command-tap",
		"enforce": "pre",
		"resolveId": (source, importer) => (source === "vscode" && importer !== tapped ? tapped : undefined),
		"load": (id) => (id === tapped ? `import * as vscode from "vscode";\nimport { tappedCommands, tappedWorkspace } from ${JSON.stringify(tap)};\nexport * from "vscode";\nexport const commands = tappedCommands(vscode, ${JSON.stringify(name)});\nexport const workspace = tappedWorkspace(vscode, ${JSON.stringify(name)});\n` : undefined)
	};
}
