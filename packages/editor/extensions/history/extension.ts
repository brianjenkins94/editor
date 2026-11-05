/**
 * History — the program as it stands, read as you edit, and what that changes. When you pause, the program is read by this
 * extension's TypeScript server plugin (ts-plugin.js), with the server's own TypeScript, edits not yet saved included.
 *
 * Replayed against the last reading (util/silo's Replayer), what a pause changed (a feature added, removed, changed, through
 * anything it reaches) is told in the History output channel; and what runs say (runs-say.ts), each feature's own code
 * joined with the statements this session's runs ran, and a change in that. Its ways in are also what the ledger (ledger.ts)
 * is checked against — `silo check`'s drift, in Problems — and what `history.decisions` answers from.
 *
 * Nothing it finds is kept: it's for the session. Once committed, the commit tells what changed (`silo history`).
 *
 * Public API only: the plugin through `typescript.tsserverRequest`, and runs through the run contract's `coverage` event. No
 * hub, no core capture: the TypeScript server already sees every edit.
 */
import type { CoverageEvent } from "@brianjenkins94/editor-api";
import type { WayIn } from "@brianjenkins94/util/silo/features";
import type { Analysis, Analyzer } from "@brianjenkins94/util/silo/graph";
import type { Exercise } from "./runs-say";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import { featuresOf, waysInManifest } from "@brianjenkins94/util/silo/features";
import { includeByDefault, Replayer } from "@brianjenkins94/util/silo/history";
import { analysisOf } from "@brianjenkins94/util/silo/ts-analysis";
import * as vscode from "vscode";
import { ledgerView } from "./ledger";
import { exerciseOf } from "./runs-say";

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
	let latest: Analysis | undefined;
	const analyzer: Analyzer = {
		"analyze": () => {
			latest = analysisOf(new Map([...readings].map(([path, reading]) => [path, reading.analysis])), manifests);

			return Promise.resolve(latest);
		}
	};
	const replayer = new Replayer(() => Promise.resolve(""), { "analyzer": analyzer, "include": includeByDefault });
	let steps = 0;
	/** What this session's runs ran of each file, in the text they ran: a run of other text starts it again. */
	const ran = new Map<string, { "text": string; "spans": Map<string, [number, number]> }>();
	/** What runs last said of each feature (undefined until the first join: that one is told as a summary). */
	let exercised: Map<string, Exercise> | undefined;
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

	/** The text of `path` as it is now: its open document's, or its file's. */
	async function textOf(path: string): Promise<string> {
		const open = vscode.workspace.textDocuments.find((document) => relative(document.uri) === path);

		return open?.getText() ?? Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, path))).then((bytes) => new TextDecoder().decode(bytes), () => "");
	}

	/** Join each feature's code with what ran in its file as it is now, and tell what changed in that. */
	async function runsSay(): Promise<void> {
		if (latest === undefined || ran.size === 0) {
			return; // nothing has run: nothing to say
		}

		const { graph, ways } = latest;
		const features = featuresOf([...ways].map(([file, each]) => ({ "file": file, "ways": each })));
		const current = new Map<string, [number, number][]>();

		// (a file edited since it ran: what ran of it is of other text, so it's said again by its next run)
		for (const [path, { text, spans }] of ran) {
			if (await textOf(path) === text) {
				current.set(path, [...spans.values()]);
			}
		}

		const now = new Map([...features].map(([key, feature]) => [key, exerciseOf(feature, graph, current)]));

		if (exercised === undefined) {
			const count = (status: Exercise): number => [...now.values()].filter((each) => each === status).length;

			output.appendLine(`Runs say: ${String(count("exercised"))} features exercised, ${String(count("dormant"))} dormant, ${String(count("unobserved"))} not run yet.`);
		} else {
			const told = [...now].filter(([key, status]) => status !== "unobserved" && status !== exercised?.get(key)).map(([key, status]) => `${status} ${features.get(key)?.facet ?? ""} ${features.get(key)?.id ?? key}`);

			if (told.length > 0) {
				output.appendLine(`${new Date().toISOString()} runs: ${told.join("; ")}`);
			}
		}

		exercised = now;
	}

	/** A run's statements that ran, as it ends. */
	function runEnded(body: CoverageEvent): void {
		for (const report of [body, ...body.files ?? []]) {
			const path = relative(vscode.Uri.file(report.file));

			if (path !== undefined && report.source !== undefined) {
				const lines = report.source.split("\n");
				const starts = lines.reduce<number[]>((all, line, index) => [...all, index === 0 ? 0 : all[index - 1]! + lines[index - 1]!.length + 1], []);
				const offset = ([line, character]: [number, number]): number => (starts[line] ?? report.source!.length) + character;
				const kept = ran.get(path)?.text === report.source ? ran.get(path)! : { "text": report.source, "spans": new Map<string, [number, number]>() };

				for (const { start, end, count } of report.statements) {
					if (count > 0) {
						kept.spans.set(`${String(start)}-${String(end)}`, [offset(start), offset(end)]);
					}
				}

				ran.set(path, kept);
			}
		}

		queue = queue.then(runsSay).catch(() => undefined);
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

		steps += 1;

		const files = [...[...readings].map(([path, reading]) => ({ "path": path, "oid": String(reading.revision) })), ...[...manifests.keys()].map((path) => ({ "path": path, "oid": "manifest" }))];
		const result = await replayer.step({ "id": "edit:" + String(steps), "date": new Date().toISOString(), "files": files });
		const changed = [...edited].sort();

		edited.clear();

		if (!read) {
			read = true;
			output.appendLine(`Reading ${String(readings.size)} files: ${String(result.features)} features.`);
		} else if (result.events.length > 0) {
			output.appendLine(`${result.date} ${changed.join(", ")}: ${result.events.map((event) => event.type + " " + event.facet + " " + (event.id === "" ? "(unnamed)" : event.id)).join("; ")}`);
		}

		await runsSay();
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
		vscode.commands.registerCommand("history.show", () => {
			output.show(true);
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ event, body }) => {
			if (event === "coverage") {
				runEnded(body as CoverageEvent);
			}
		}),
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
