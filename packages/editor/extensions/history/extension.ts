/**
 * History — what your edits change, as you make them. Derived history (CHANGE-HISTORY.md, step 3) live: when you pause,
 * the program as it now stands is read — by this extension's TypeScript server plugin (ts-plugin.js), with the server's
 * own TypeScript, edits not yet saved included — and replayed against the last reading (util/silo's Replayer). What a
 * burst changed (a feature added, removed, changed — through anything it reaches) is a fact, a line appended to your
 * `.silo/history/<user>.jsonl`; `silo history` tells the facts with the commits (withFacts), so the work between commits
 * and the tries undone before any commit are in the history too.
 *
 * Public API only: the plugin through `typescript.tsserverRequest`, the facts through `workspace.fs`. No hub, no core
 * capture: the TypeScript server already sees every edit.
 */
import type { WayIn } from "@brianjenkins94/util/silo/features";
import type { Analyzer } from "@brianjenkins94/util/silo/graph";
import type { HistoryFact } from "@brianjenkins94/util/silo/history";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import * as vscode from "vscode";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { waysInManifest } from "@brianjenkins94/util/silo/features";
import { factLine, includeByDefault, Replayer } from "@brianjenkins94/util/silo/history";
import { historyPath } from "@brianjenkins94/util/silo/layout";
import { analysisOf } from "@brianjenkins94/util/silo/ts-analysis";

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
	// The program as the plugin last read it: no snapshot is read here, so `read` is never asked.
	const analyzer: Analyzer = { "analyze": async () => analysisOf(new Map([...readings].map(([path, reading]) => [path, reading.analysis])), manifests) };
	const replayer = new Replayer(async () => "", { "analyzer": analyzer, "include": includeByDefault });
	const edited = new Set<string>();
	let baseline = false;
	let steps = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queue = Promise.resolve();
	let user: Promise<string> | undefined;

	const relative = (uri: vscode.Uri): string | undefined => (uri.scheme === root.scheme && uri.path.startsWith(root.path + "/") ? uri.path.slice(root.path.length + 1) : undefined);

	/** The person the facts are filed under: the git identity's slug (as runs are), else "local". */
	const userOf = async (): Promise<string> => {
		user ??= Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".git", "config"))).then((bytes) => userSlug(new TextDecoder().decode(bytes)) ?? "local", () => "local");

		return user;
	};

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

	/** Append a fact to the person's history file. */
	async function keep(fact: HistoryFact): Promise<void> {
		const uri = vscode.Uri.joinPath(root, historyPath(await userOf()));
		let existing = "";

		try {
			existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch { /* the first */ }

		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + (existing === "" || existing.endsWith("\n") ? "" : "\n") + factLine(fact)));
	}

	/** Read the program as it stands, and replay it against the last reading: the first is the baseline. */
	async function step(attempt = 0): Promise<void> {
		const file = [...edited][0] ?? vscode.window.activeTextEditor?.document.uri.path;
		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: ReadAnswer } | undefined>("typescript.tsserverRequest", "_history.read", { "root": root.path, "known": Object.fromEntries([...readings].map(([path, reading]) => [path, reading.revision])), ...file === undefined ? {} : { "file": file } })).catch(() => undefined);
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

		for (const [path, reading] of Object.entries<{ "analysis": FileAnalysis; "revision": number }>(answer.files ?? {})) {
			readings.set(path, reading);
		}

		const present = new Set(answer.paths ?? []);

		for (const path of [...readings.keys()]) {
			if (!present.has(path)) {
				readings.delete(path);
			}
		}

		steps += 1;

		const files = [...[...readings].map(([path, reading]) => ({ "path": path, "oid": String(reading.revision) })), ...[...manifests.keys()].map((path) => ({ "path": path, "oid": "manifest" }))];
		const result = await replayer.step({ "id": "edit:" + String(steps), "date": new Date().toISOString(), "files": files });
		const changed = [...edited].sort();

		edited.clear();

		if (!baseline) {
			baseline = true;
			output.appendLine(`Reading ${String(readings.size)} files: ${String(result.features)} features.`);

			return;
		}

		if (result.events.length > 0) {
			const fact: HistoryFact = { "time": result.date, "file": changed.join(", "), "features": result.features, "events": result.events };

			await keep(fact);
			output.appendLine(`${result.date} ${fact.file}: ${result.events.map((event) => event.type + " " + event.facet + " " + (event.id === "" ? "(unnamed)" : event.id)).join("; ")}`);
		}
	}

	const schedule = (delay: number): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			timer = undefined;
			queue = queue.then(async () => step()).catch((error: unknown) => {
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

	// A manifest's ways in change with it.
	const watcher = vscode.workspace.createFileSystemWatcher("**/package.json");
	const manifestsChanged = (): void => {
		queue = queue.then(readManifests).catch(() => undefined);
		schedule(IDLE_MS);
	};

	context.subscriptions.push(watcher, watcher.onDidChange(manifestsChanged), watcher.onDidCreate(manifestsChanged), watcher.onDidDelete(manifestsChanged));

	// The baseline: the program as it is when the extension starts.
	queue = queue.then(readManifests).catch(() => undefined);
	schedule(IDLE_MS);
}
