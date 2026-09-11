/**
 * LSP Host — the manager extension (runs in the extension host, LocalProcess). It runs language servers
 * off-thread in workers and connects each to the editor with a vscode-languageclient. The client
 * integration (diagnostics/hover/completion) is the language client's job; the server runs in the worker.
 *
 * Each worker (a server-host) runs a NODE language server under an almostnode runtime on a zen-fs VFS, so a
 * node-only server (cspell reading its dictionary; eslint parsing TS) works in-browser. Each is built +
 * served separately (lsp.config.ts → /__vscode__/lsp/, with COEP) as a normal module graph — not a blob —
 * because almostnode can't be monolithically inlined. The extension can't emit/locate those assets from its
 * data:-URL self, so it spawns them by URL relative to the workbench origin (`location.href`), the same way
 * the preflight engine URL is resolved.
 */
import type * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

interface ServerSpec {
	"id": string;
	"name": string;
	"workerFile": string;
	"documentSelector": { "language": string }[];
}

// One worker + client per server. cspell spell-checks prose/identifiers; eslint lints JS/TS.
const SERVERS: ServerSpec[] = [
	{ "id": "cspell", "name": "cspell (almostnode)", "workerFile": "./lsp/server-host.js", "documentSelector": [{ "language": "typescript" }, { "language": "plaintext" }] },
	{ "id": "eslint", "name": "eslint (almostnode)", "workerFile": "./lsp/server-host-eslint.js", "documentSelector": [{ "language": "typescript" }, { "language": "javascript" }] }
];

const clients: LanguageClient[] = [];

function startServer(context: vscode.ExtensionContext, spec: ServerSpec): void {
	// The workbench iframe's origin; the LocalProcess ext host shares it. The worker is served next to
	// host.html under /__vscode__/lsp/ (lsp.config.ts).
	const worker = new Worker(new URL(spec.workerFile, location.href), { "type": "module" });

	worker.addEventListener("error", (event) => {
		console.error(`[lsp-host] ${spec.id} worker error:`, event.message, "@", event.filename + ":" + event.lineno);
	});

	const client = new LanguageClient(`lsp-${spec.id}`, spec.name, worker, { "documentSelector": spec.documentSelector });

	clients.push(client);
	client.start().then(() => {
		console.log(`[lsp-host] ${spec.id} language client started`);
	}).catch((error: unknown) => {
		console.error(`[lsp-host] ${spec.id} client start failed`, error);
	});
}

export function activate(context: vscode.ExtensionContext): void {
	for (const spec of SERVERS) {
		startServer(context, spec);
	}

	context.subscriptions.push({
		"dispose": () => {
			for (const client of clients) {
				client.stop().catch(() => undefined);
			}
		}
	});
}

export function deactivate(): Thenable<void> | undefined {
	return Promise.all(clients.map((client) => client.stop())).then(() => undefined);
}
