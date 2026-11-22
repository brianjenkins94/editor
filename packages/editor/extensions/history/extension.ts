import type { CoverageEvent } from "@brianjenkins94/editor-api";
import type { Span } from "@brianjenkins94/util/logger";
import type { WayIn } from "@brianjenkins94/util/silo/features";
import type { Analysis, Analyzer } from "@brianjenkins94/util/silo/graph";
import type { FileAnalysis } from "@brianjenkins94/util/silo/ts-analysis";
import type { Exercise } from "./runs-say";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import { featuresOf, waysInManifest } from "@brianjenkins94/util/silo/features";
import { includeByDefault, Replayer } from "@brianjenkins94/util/silo/history";
import { analysisOf } from "@brianjenkins94/util/silo/ts-analysis";
import * as vscode from "vscode";
import { ledgerView } from "./ledger";
import { reachView } from "./reach";
import { exerciseOf } from "./runs-say";

const IDLE_MS = 1500;
const RETRY_MS = 2000;
const RETRIES = 30;
const LANGUAGES = new Set([
	"typescript",
	"typescriptreact",
	"javascript",
	"javascriptreact"
]);

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
	const observed = observeExtension("history", vscode);

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	const readings = new Map<string, { "analysis": FileAnalysis; "revision": number }>();
	const manifests = new Map<string, WayIn[]>();
	let latest: Analysis | undefined;
	const analyzer: Analyzer = {
		"analyze": () => {
			latest = analysisOf(new Map([...readings].map(([path, reading]) => [path, reading.analysis])), manifests);

			return Promise.resolve(latest);
		}
	};
	const replayer = new Replayer(() => Promise.resolve(""), { "analyzer": analyzer, "include": includeByDefault });
	let steps = 0;
	const ran = new Map<string, { "text": string; "spans": Map<string, [number, number]> }>();
	let exercised: Map<string, Exercise> | undefined;
	const ledger = ledgerView(context, root);
	const reach = reachView(context, root, ledger);
	const edited = new Set<string>();
	let read = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rescan = false;
	let queue = Promise.resolve();

	const relative = (uri: vscode.Uri): string | undefined => (uri.scheme === root.scheme && uri.path.startsWith(root.path + "/")
		? uri.path.slice(root.path.length + 1)
		: undefined);

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

	async function textOf(path: string): Promise<string> {
		const open = vscode.workspace.textDocuments.find((document) => relative(document.uri) === path);

		return open?.getText() ?? Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, path))).then((bytes) => new TextDecoder().decode(bytes), () => "");
	}

	async function runsSay(): Promise<void> {
		if (latest === undefined || ran.size === 0) {
			return; // nothing has run: nothing to say
		}

		const { graph, ways } = latest;
		const features = featuresOf([...ways].map(([file, each]) => ({ "file": file, "ways": each })));
		const current = new Map<string, [number, number][]>();

		for (const [path, { text, spans }] of ran) {
			if (await textOf(path) === text) {
				current.set(path, [
					...spans.values()
				]);
			}
		}

		const now = new Map([...features].map(([key, feature]) => [
			key,
			exerciseOf(feature, graph, current)
		]));

		if (exercised === undefined) {
			const count = (status: Exercise): number => [
				...now.values()
			].filter((each) => each === status).length;

			output.appendLine(`Runs say: ${String(count("exercised"))} features exercised, ${String(count("dormant"))} dormant, ${String(count("unobserved"))} not run yet.`);
		} else {
			const told = [...now].filter(([key, status]) => status !== "unobserved" && status !== exercised?.get(key)).map(([key, status]) => `${status} ${features.get(key)?.facet ?? ""} ${features.get(key)?.id ?? key}`);

			if (told.length > 0) {
				output.appendLine(`${new Date().toISOString()} runs: ${told.join("; ")}`);
			}
		}

		exercised = now;
	}

	function runEnded(body: CoverageEvent): void {
		for (const report of [
			body,
			...body.files ?? []
		]) {
			const path = relative(vscode.Uri.file(report.file));

			if (path !== undefined && report.source !== undefined) {
				const lines = report.source.split("\n");
				const starts = lines.reduce<number[]>((all, line, index) => [
					...all,
					index === 0
						? 0
						: all[index - 1] + lines[index - 1].length + 1
				], []);
				const offset = ([line, character]: [number, number]): number => (starts[line] ?? report.source.length) + character;
				const kept = ran.get(path)?.text === report.source
					? ran.get(path)
					: {
							"text": report.source,
							"spans": new Map<string, [number, number]>()
						};

				for (const { start, end, count } of report.statements) {
					if (count > 0) {
						kept.spans.set(`${String(start)}-${String(end)}`, [
							offset(start),
							offset(end)
						]);
					}
				}

				ran.set(path, kept);
			}
		}

		queue = queue.then(runsSay).catch(() => undefined);
	}

	async function checkLedger(): Promise<void> {
		if (latest === undefined) {
			return;
		}

		const features = featuresOf([...latest.ways].map(([file, ways]) => ({ "file": file, "ways": ways })));
		const { files } = await ledger.workspace();
		const unread = [...files].filter((path) => /\.[cm]?[jt]sx?$/u.test(path) && !path.includes("node_modules/") && !readings.has(path));

		for (const feature of features.values()) {
			const declaredOnly = (feature.facet === "command" || feature.facet === "view") && feature.sides.includes("declared") && !feature.sides.includes("registered");
			const folders = feature.files.filter((file) => file.endsWith("package.json")).map((file) => file.slice(0, -"package.json".length));

			if (declaredOnly && folders.some((folder) => unread.some((path) => path.startsWith(folder)))) {
				feature.sides.push("registered");
			}
		}

		reach.read(features, latest.graph);
		await ledger.check(features);
	}

	async function step(attempt = 0): Promise<void> {
		const file = [...edited][0] ?? vscode.window.activeTextEditor?.document.uri.path;
		const asked = rescan;
		const ask = async (span?: Span): Promise<ReadAnswer | undefined> => {
			const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: ReadAnswer } | undefined>("typescript.tsserverRequest", "_history.read", {
				"root": root.path,
				"known": Object.fromEntries([...readings].map(([path, reading]) => [path, reading.revision])),
				...file === undefined
					? {}
					: { "file": file },
				...asked
					? { "rescan": true }
					: {}
			})).catch(() => undefined);

			span?.end({
				"ready": response?.body?.ready === true,
				"count": Object.keys(response?.body?.files ?? {}).length,
				...response?.body?.error === undefined
					? {}
					: { "error": response.body.error }
			});

			return response?.body;
		};

		const attrs = {
			"count": attempt,
			...file === undefined
				? {}
				: { "path": file }
		};

		const answer = await (observed === undefined
			? ask()
			: observed.log.span("editor.extensions.history.read", attrs, ask));

		if (answer?.ready !== true) {
			if (attempt < RETRIES) {
				setTimeout(() => {
					queue = queue.then(async () => step(attempt + 1));
				}, RETRY_MS);
			} else if (answer?.error !== undefined) {
				output.appendLine("The history plugin's engine didn't load: " + answer.error);
			} else {
				output.appendLine(`TypeScript's server didn't answer in ${String(RETRIES * RETRY_MS / 1000)} s: the program's read again on the next edit.`);
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

		for (const path of [
			...readings.keys()
		]) {
			if (!present.has(path)) {
				readings.delete(path);
			}
		}

		steps += 1;

		const files = [
			...[...readings].map(([path, reading]) => ({
				"path": path,
				"oid": String(reading.revision)
			})),
			...[
				...manifests.keys()
			].map((path) => ({ "path": path, "oid": "manifest" }))
		];
		const replay = async (span?: Span): Promise<Awaited<ReturnType<Replayer["step"]>>> => {
			const stepped = await replayer.step({
				"id": "edit:" + String(steps),
				"date": new Date().toISOString(),
				"files": files
			});

			span?.end({ "count": stepped.events.length });

			return stepped;
		};

		const result = await (observed === undefined
			? replay()
			: observed.log.span("editor.extensions.history.replay", { "count": files.length }, replay));
		const changed = [...edited].sort();

		edited.clear();

		if (!read) {
			read = true;
			output.appendLine(`Reading ${String(readings.size)} files: ${String(result.features)} features.`);
		} else if (result.events.length > 0) {
			output.appendLine(`${result.date} ${changed.join(", ")}: ${result.events.map((event) => event.type + " " + event.facet + " " + (event.id === ""
				? "(unnamed)"
				: event.id)).join("; ")}`);
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
				output.appendLine("History failed to read the program: " + (error instanceof Error
					? error.message
					: String(error)));
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

	const code = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
	const codeChanged = (uri: vscode.Uri): void => {
		const path = relative(uri);

		if (path !== undefined && includeByDefault(path) && !vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty)) {
			schedule(IDLE_MS);
		}
	};

	const filesChanged = (uri: vscode.Uri): void => {
		rescan = true;
		codeChanged(uri);
	};

	context.subscriptions.push(code, code.onDidCreate(filesChanged), code.onDidChange(codeChanged), code.onDidDelete(filesChanged));

	const watcher = vscode.workspace.createFileSystemWatcher("**/package.json");
	let manifestsDue = false;
	const manifestsChanged = (uri: vscode.Uri): void => {
		if (uri.path.includes("/node_modules/")) {
			return;
		}

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

	const decided = vscode.workspace.createFileSystemWatcher("**/{features.json,*.md}");
	const ledgerChanged = (): void => {
		queue = queue.then(checkLedger).catch(() => undefined);
	};

	context.subscriptions.push(decided, decided.onDidChange(ledgerChanged), decided.onDidCreate(ledgerChanged), decided.onDidDelete(ledgerChanged));

	queue = queue.then(readManifests).catch(() => undefined);
	schedule(IDLE_MS);
}
