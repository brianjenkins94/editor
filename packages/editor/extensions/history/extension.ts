/**
 * History — the program as it stands, read as you edit, and the feature ledger held to it. When you pause, the program is
 * read by this extension's TypeScript server plugin (ts-plugin.js), with the server's own TypeScript, edits not yet saved
 * included; its ways in are what the ledger (ledger.ts) is checked against — `silo check`'s drift, in Problems — and
 * what `history.decisions` answers from.
 *
 * Nothing it finds is kept: it's for the session.
 *
 * Public API only: the plugin through `typescript.tsserverRequest`. No hub, no core capture: the TypeScript server
 * already sees every edit.
 */
import type { WayIn } from "@brianjenkins94/util/silo/features";
import type { Analysis } from "@brianjenkins94/util/silo/graph";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import { featuresOf, waysInManifest } from "@brianjenkins94/util/silo/features";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { analysisOf } from "@brianjenkins94/util/silo/ts-analysis";
import * as vscode from "vscode";
import { ledgerView } from "./ledger";

/** How long after the last keystroke a burst ends. */
const IDLE_MS = 1500;
/** How often to ask again while the plugin's engine is still loading. */
const RETRY_MS = 2000;
const RETRIES = 30;
const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);

/** What `_history.read` answers (ts-plugin.js). */
interface ReadAnswer {
	"ready": boolean;
	"error"?: string;
	"files"?: Record<string, { "analysis": FileAnalysis; "revision": number }>;
	"paths"?: string[];
}

export function activate(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];

	if (folder === undefined) {
		return;
	}

	const root = folder.uri;
	const output = vscode.window.createOutputChannel("History");
	const readings = new Map<string, { "analysis": FileAnalysis; "revision": number }>();
	const manifests = new Map<string, WayIn[]>();
	// The program as the plugin last read it.
	let latest: Analysis | undefined;
	const ledger = ledgerView(context, root);
	const edited = new Set<string>();
	let read = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether a code file was made or deleted since the last reading: its projects read their files again first. */
	let rescan = false;
	let queue = Promise.resolve();

	const relative = (uri: vscode.Uri): string | undefined => (uri.scheme === root.scheme && uri.path.startsWith(root.path + "/") ? uri.path.slice(root.path.length + 1) : undefined);

	/** The ways in the program's manifests declare (VS Code extensions' `contributes`): JSON, read here. */
	async function readManifests(): Promise<void> {
		manifests.clear();

		for (const uri of await vscode.workspace.findFiles("**/package.json", "**/node_modules/**")) {
			const path = relative(uri);

			if (path !== undefined && includeByDefault(path)) {
				try {
					manifests.set(path, waysInManifest(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))));
				} catch { /* gone, or not JSON */ }
			}
		}
	}

	/** Hold the ledger to the ways in as they're read now. */
	async function checkLedger(): Promise<void> {
		if (latest === undefined) {
			return;
		}

		await ledger.check(featuresOf([...latest.ways].map(([file, ways]) => ({ "file": file, "ways": ways }))));
	}

	/** Read the program as it stands. */
	async function step(attempt = 0): Promise<void> {
		const file = [...edited][0] ?? vscode.window.activeTextEditor?.document.uri.path;
		const asked = rescan;
		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: ReadAnswer } | undefined>("typescript.tsserverRequest", "_history.read", { "root": root.path, "known": Object.fromEntries([...readings].map(([path, reading]) => [path, reading.revision])), ...file === undefined ? {} : { "file": file }, ...asked ? { "rescan": true } : {} })).catch(() => undefined);
		const answer = response?.body;

		if (answer?.ready !== true) {
			// The server isn't up yet, or its plugin's engine is still loading: ask again shortly.
			if (attempt < RETRIES) {
				setTimeout(() => {
					queue = queue.then(async () => step(attempt + 1));
				}, RETRY_MS);
			} else if (answer?.error !== undefined) {
				output.appendLine("The history plugin's engine didn't load: " + answer.error);
			}

			return;
		}

		if (asked) {
			rescan = false;
		}

		for (const [path, reading] of Object.entries<{ "analysis": FileAnalysis; "revision": number }>(answer.files ?? {})) {
			readings.set(path, reading);
		}

		const present = new Set(answer.paths ?? []);

		for (const path of [...readings.keys()]) {
			if (!present.has(path)) {
				readings.delete(path);
			}
		}

		edited.clear();
		latest = analysisOf(new Map([...readings].map(([path, reading]) => [path, reading.analysis])), manifests);

		if (!read) {
			read = true;
			output.appendLine(`Reading ${String(readings.size)} files: ${String(latest.ways.size)} with ways in.`);
		}

		await checkLedger();
	}

	const schedule = (delay: number): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			timer = undefined;
			queue = queue.then(async () => step()).catch((error: unknown) => {
				// eslint-disable-next-line ts/no-base-to-string -- a rejection can be any value: one that isn't an Error is said as String() says it
				output.appendLine("History failed to read the program: " + (error instanceof Error ? error.message : String(error)));
			});
		}, delay);
	};

	context.subscriptions.push(
		output,
		vscode.workspace.onDidChangeTextDocument((event) => {
			const path = relative(event.document.uri);

			if (path !== undefined && LANGUAGES.has(event.document.languageId) && event.contentChanges.length > 0) {
				edited.add(path);
				schedule(IDLE_MS);
			}
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (relative(document.uri) !== undefined && LANGUAGES.has(document.languageId)) {
				schedule(200);
			}
		})
	);

	// Code changed outside an editor — a pull, a checkout, a file written by a tool: read the program again.
	const code = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
	const codeChanged = (uri: vscode.Uri): void => {
		const path = relative(uri);

		if (path !== undefined && includeByDefault(path) && !vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty)) {
			schedule(IDLE_MS);
		}
	};

	// (a file made or deleted: the server's projects read their files again first — in the browser it isn't told of one)
	const filesChanged = (uri: vscode.Uri): void => {
		rescan = true;
		codeChanged(uri);
	};

	context.subscriptions.push(code, code.onDidCreate(filesChanged), code.onDidChange(codeChanged), code.onDidDelete(filesChanged));

	// A manifest's ways in change with it.
	const watcher = vscode.workspace.createFileSystemWatcher("**/package.json");
	let manifestsDue = false;
	const manifestsChanged = (uri: vscode.Uri): void => {
		// (a dependency's own package.json isn't the program's — readManifests leaves node_modules out — and type acquisition
		// writes hundreds as a load settles: each was a walk of the whole workspace, a second apart, for minutes)
		if (uri.path.includes("/node_modules/")) {
			return;
		}

		// (a burst of them: one reading, after it)
		if (!manifestsDue) {
			manifestsDue = true;
			queue = queue.then(async () => {
				manifestsDue = false;
				await readManifests();
			}).catch(() => undefined);
		}

		schedule(IDLE_MS);
	};

	context.subscriptions.push(watcher, watcher.onDidChange(manifestsChanged), watcher.onDidCreate(manifestsChanged), watcher.onDidDelete(manifestsChanged));

	// The ledger or a doc changed: its drift may have (a doc naming a removed feature, say).
	const decided = vscode.workspace.createFileSystemWatcher("**/{features.json,*.md}");
	const ledgerChanged = (): void => {
		queue = queue.then(checkLedger).catch(() => undefined);
	};

	context.subscriptions.push(decided, decided.onDidChange(ledgerChanged), decided.onDidCreate(ledgerChanged), decided.onDidDelete(ledgerChanged));

	// The first reading: the program as it is when the extension starts.
	queue = queue.then(readManifests).catch(() => undefined);
	schedule(IDLE_MS);
}
