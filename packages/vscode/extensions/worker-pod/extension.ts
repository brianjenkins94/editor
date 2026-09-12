/**
 * Worker Pod — the manager extension (runs in the extension host, LocalProcess) that hosts a pod of workers
 * behind one extension. Today it runs NODE language servers off-thread and connects each to the editor with
 * a vscode-languageclient; a tsval-backed debug adapter is the next pod member (see debug-adapter.ts).
 *
 * Each language server worker (a server-host) runs under an almostnode runtime on a zen-fs VFS, so a
 * node-only server (cspell reading its dictionary; eslint parsing TS) works in-browser. Each is built +
 * served separately (lsp.config.ts → /__vscode__/lsp/, with COEP) as a normal module graph — not a blob —
 * because almostnode can't be monolithically inlined. The extension can't emit/locate those assets from its
 * data:-URL self, so it spawns them by URL relative to the workbench origin (`location.href`).
 */
import type * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

import { registerTsvalDebug } from "./debug-adapter";

interface ServerSpec {
	"id": string;
	"name": string;
	"workerFile": string;
	"documentSelector": { "language": string }[];
}

// One worker + client per server. cspell spell-checks prose/identifiers; eslint lints JS/TS. The selectors
// MUST include the react language ids (typescriptreact/javascriptreact) — the demo opens on App.tsx, whose
// languageId is `typescriptreact`, not `typescript`; without them the client never forwards .tsx/.jsx docs to
// the server and no diagnostics ever appear.
const JS_TS_LANGUAGES = [
	{ "language": "typescript" },
	{ "language": "typescriptreact" },
	{ "language": "javascript" },
	{ "language": "javascriptreact" }
];
const SERVERS: ServerSpec[] = [
	{ "id": "cspell", "name": "cspell (almostnode)", "workerFile": "./lsp/server-host.js", "documentSelector": [...JS_TS_LANGUAGES, { "language": "plaintext" }, { "language": "markdown" }, { "language": "json" }] },
	{ "id": "eslint", "name": "eslint (almostnode)", "workerFile": "./lsp/server-host-eslint.js", "documentSelector": JS_TS_LANGUAGES }
];

const clients: LanguageClient[] = [];

function startServer(context: vscode.ExtensionContext, spec: ServerSpec): void {
	// The workbench iframe's origin; the LocalProcess ext host shares it. The worker is served next to
	// host.html under /__vscode__/lsp/ (lsp.config.ts).
	const worker = new Worker(new URL(spec.workerFile, location.href), { "type": "module" });

	worker.addEventListener("error", (event) => {
		console.error(`[worker-pod] ${spec.id} worker error:`, event.message, "@", event.filename + ":" + event.lineno);
	});

	const client = new LanguageClient(`lsp-${spec.id}`, spec.name, worker, { "documentSelector": spec.documentSelector });

	clients.push(client);
	client.start().then(() => {
		console.log(`[worker-pod] ${spec.id} language client started`);
	}).catch((error: unknown) => {
		console.error(`[worker-pod] ${spec.id} client start failed`, error);
	});
}

export function activate(context: vscode.ExtensionContext): void {
	// The tsval debug type — a worker-backed stepping debugger (debug-adapter.ts + debug-worker.ts).
	registerTsvalDebug(context);

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

export function deactivate(): Promise<void> {
	return Promise.all(clients.map((client) => client.stop())).then(() => undefined);
}
