/**
 * History — what your edits change, as you make them. Derived history (CHANGE-HISTORY.md, step 3) live: when you pause,
 * the program as it now stands is read — by this extension's TypeScript server plugin (ts-plugin.js), with the server's
 * own TypeScript, edits not yet saved included — and replayed against the last reading (util/silo's Replayer). What a
 * pause changed (a feature added, removed, changed — through anything it reaches) is told in the History output channel.
 *
 * And what runs say (step 4): after each reading, and whenever a run leaves evidence, each feature's own code is joined
 * with the evidence placed in the files as they are now (util/silo's exercise) — exercised, or dormant (its file ran, its
 * code didn't) — and a change in that is told too. Evidence is keyed on BABLR spans; the shared evidence store
 * (insights') places them through the editor's resolver, so the join with BABLR happens there, at the edge.
 *
 * Nothing it finds is kept: it's for the session. Once committed, the commit tells what changed (`silo history`), and what
 * runs say is recomputed from the evidence, which is kept.
 *
 * Public API only: the plugin through `typescript.tsserverRequest`, evidence through the bridge's
 * `editor.annotations.resolve`. No hub, no core capture: the TypeScript server already sees every edit.
 */
import type { Exercise, Ran } from "@brianjenkins94/util/silo/exercise";
import type { WayIn } from "@brianjenkins94/util/silo/features";
import type { Analysis, Analyzer } from "@brianjenkins94/util/silo/graph";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import { evidenceStore } from "@brianjenkins94/editor-api/evidence";
import { parseRuns } from "@brianjenkins94/util/silo/evidence";
import { exerciseOf } from "@brianjenkins94/util/silo/exercise";
import { featuresOf, waysInManifest } from "@brianjenkins94/util/silo/features";
import { exerciseEvents, includeByDefault, Replayer } from "@brianjenkins94/util/silo/history";
import { SILO_DIR } from "@brianjenkins94/util/silo/layout";
import { analysisOf } from "@brianjenkins94/util/silo/ts-analysis";
import * as vscode from "vscode";

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
	const evidence = evidenceStore(vscode, context.subscriptions);
	// What runs last said of each feature, this session (undefined until the first join: that one is told as a summary).
	let exercised: Map<string, Exercise> | undefined;
	const replayer = new Replayer(() => Promise.resolve(""), { "analyzer": analyzer, "include": includeByDefault });
	const edited = new Set<string>();
	let baseline = false;
	let steps = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
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

	/** The files some run ran: the run envelopes' (everyone's), and those with evidence kept. */
	async function ranFiles(withEvidence: string[]): Promise<Set<string>> {
		const files = new Set(withEvidence);
		const folder = vscode.Uri.joinPath(root, SILO_DIR, "runs");

		for (const [name] of await Promise.resolve(vscode.workspace.fs.readDirectory(folder)).catch(() => [] as [string, vscode.FileType][])) {
			const text = await Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name))).then((bytes) => new TextDecoder().decode(bytes), () => "");

			for (const run of parseRuns(text)) {
				for (const file of Object.keys(run.files)) {
					files.add(file);
				}
			}
		}

		return files;
	}

	/** Join each feature's code with what ran, and tell what changed in that. */
	async function exercise(): Promise<void> {
		if (latest === undefined) {
			return;
		}

		const analysis = latest;
		const features = featuresOf([...analysis.ways].map(([file, ways]) => ({ "file": file, "ways": ways })));
		const withEvidence = await evidence.files();
		const observed = await ranFiles(withEvidence);

		if (observed.size === 0) {
			return; // nothing has run: nothing to say
		}

		// The evidence of the files that hold some feature's code, placed in their text as it is now.
		const ran = new Map<string, Ran[]>();

		for (const file of withEvidence) {
			if ([...features.values()].some((feature) => feature.files.includes(file) || feature.roots.some((rootId) => rootId.startsWith(file + "#")))) {
				const open = vscode.workspace.textDocuments.find((document) => relative(document.uri) === file);
				const text = open?.getText() ?? await Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, file))).then((bytes) => new TextDecoder().decode(bytes), () => "");
				const placed = await evidence.placedIn(file, text);

				ran.set(file, placed.flatMap((span) => (span.evidence.reached === undefined ? [] : [{ "file": file, "start": span.start, "end": span.end, ...span.evidence.reached }])));
			}
		}

		const now = new Map([...features].map(([key, feature]) => [key, exerciseOf(feature, analysis.graph, ran, observed)]));

		if (exercised === undefined) {
			const count = (status: Exercise["status"]): number => [...now.values()].filter((each) => each.status === status).length;

			output.appendLine(`Runs say: ${String(count("exercised"))} features exercised, ${String(count("dormant"))} dormant, ${String(count("unobserved"))} not run yet.`);
			exercised = now;

			return;
		}

		const events = exerciseEvents(features, exercised, now);

		exercised = now;

		if (events.length > 0) {
			output.appendLine(`${new Date().toISOString()} runs: ${events.map((event) => event.type + " " + event.facet + " " + event.id).join("; ")}`);
		}
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
			await exercise();

			return;
		}

		if (result.events.length > 0) {
			output.appendLine(`${result.date} ${changed.join(", ")}: ${result.events.map((event) => event.type + " " + event.facet + " " + (event.id === "" ? "(unnamed)" : event.id)).join("; ")}`);
		}

		await exercise();
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

	// A run left evidence (or a person's evidence changed): what runs say may have changed.
	context.subscriptions.push(evidence.onDidChange(() => {
		queue = queue.then(exercise).catch((error: unknown) => {
			// eslint-disable-next-line ts/no-base-to-string -- a rejection can be any value: one that isn't an Error is said as String() says it
			output.appendLine("History failed to join what ran: " + (error instanceof Error ? error.message : String(error)));
		});
	}));

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
