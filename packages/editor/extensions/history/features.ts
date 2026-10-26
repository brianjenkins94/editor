/**
 * The program by feature, as the feature manifest names them (`.silo/manifest.json`, packages/silo/README.md, *The
 * feature manifest*), over History's reading of the program as it stands (edits included): which of the manifest's
 * features own each declaration (lib util/silo/manifest `codeOwners` — what a feature's ways in reach, what registers
 * them, and its `paths`), and each feature's tests — those whose traces (`.silo/local/traces`, kept by `node --test`) ran
 * code of its that isn't ambient. Core draws it, as the features map (workbench/features-map.ts: a block per feature,
 * in a side bar of its own), from what `history.features` answers.
 *
 * Focus on a feature (a click on its block, or Focus on a Feature… in the Command Palette) and the rest of the
 * workspace steps back: the Explorer marks the files its code is in, and open editors dim the code it doesn't own. The
 * status bar says which feature is in focus, and opens the map. A feature's decision is set here too (Set Feature
 * Status…), into the ledger (`.silo/features.json`), as `silo status` would.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { LedgerStatus } from "@brianjenkins94/util/silo/ledger";
import type { ManifestFeature } from "@brianjenkins94/util/silo/manifest";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { TOP } from "@brianjenkins94/util/silo/graph";
import { ledgerPath, manifestPath } from "@brianjenkins94/util/silo/layout";
import { ledgerText, parseLedger, withStatus } from "@brianjenkins94/util/silo/ledger";
import { codeOwners, featuresOfManifest, parseManifest } from "@brianjenkins94/util/silo/manifest";
import { parseTraces } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";

/** More owners than this, and a declaration is ambient (setup, the hub, logging): it says nothing about which feature
 *  a test is. */
const AMBIENT = 5;
/** What opens the features map (core's view, workbench/features-map.ts): its view's focus command. */
const OPEN_MAP = "features.map.focus";

/** A declaration where it is now: its node id, file and offsets, and the features that own it (indexes into `shown`). */
interface Code { "id": string; "file": string; "start": number; "end": number; "owners": number[] }

/** One of the manifest's features. */
interface Shown {
	"area": string;
	"name": string;
	"feature": ManifestFeature;
	"status"?: string;
	"ways": Feature[];
	"tests": { "id": string; "outcome": string }[];
}

export interface FeaturesView {
	/** Show the program by feature, given its ways in and declaration graph now. */
	"show": (features: ReadonlyMap<string, Feature>, graph: DeclarationGraph) => Promise<void>;
}

/** What each status means, as Set Feature Status… offers them. */
const STATUS_PICKS: { "label": LedgerStatus; "detail": string }[] = [
	{ "label": "active", "detail": "Kept on purpose: say why it stays." },
	{ "label": "experiment", "detail": "Trying it: until a date, by when it's kept or removed." },
	{ "label": "parked", "detail": "Not now: kept, not worked on." },
	{ "label": "stopped", "detail": "Not wanted: `silo check` flags it while its code is still there." },
	{ "label": "removed", "detail": "Gone: a tombstone, so docs that still name it are flagged." }
];

const nameOf = (id: string): string => id.slice(id.lastIndexOf("#") + 1);

/** `items` by `key`, in their order. */
const groupBy = <T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> => {
	const groups = new Map<string, T[]>();

	for (const item of items) {
		groups.set(key(item), [...groups.get(key(item)) ?? [], item]);
	}

	return groups;
};

export function featuresView(context: vscode.ExtensionContext, root: vscode.Uri): FeaturesView {
	const decorated = new vscode.EventEmitter<vscode.Uri[]>();
	const dim = vscode.window.createTextEditorDecorationType({ "opacity": "0.4" });
	const status = vscode.window.createStatusBarItem("history.features", vscode.StatusBarAlignment.Left, 10);
	let program: { "features": ReadonlyMap<string, Feature>; "graph": DeclarationGraph } | undefined;
	let shown: Shown[] = [];
	let code: Code[] = [];
	let unplaced: Feature[] = [];
	let message: string | undefined;
	/** Bumped each time what's shown changes: the map asks with the one it has, and redraws only on a new one. */
	let revision = 0;
	/** The feature in focus, by index into `shown`. */
	let focused: number | undefined;
	const textOf = async (uri: vscode.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
	/** A file's text as it is now: its editor's, else on disk. */
	const textNow = async (file: string): Promise<string | undefined> => vscode.workspace.textDocuments.find((document) => document.uri.toString() === vscode.Uri.joinPath(root, file).toString())?.getText() ?? textOf(vscode.Uri.joinPath(root, file));

	/** Each traced file's spans, by the text they're of: BABLR is asked again only when the text changed. */
	const spansOf = new Map<string, { "text": string; "spans": Map<string, { "start": number; "end": number }> }>();

	/** Each test, by id: the declarations its traces ran (BABLR span ids, placed in their files as they are now, then
	 *  the declaration each is in) and how it last came out. */
	async function testsRan(): Promise<Map<string, { "outcome": string; "ran": Set<string> }>> {
		const tests = new Map<string, { "outcome": string; "ran": Set<string> }>();
		const folder = vscode.Uri.joinPath(root, ".silo/local/traces");
		const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.jsonl"))).toSorted((left, right) => left.path.localeCompare(right.path));
		const traces = (await Promise.all(files.map(async (uri) => parseTraces(await textOf(uri) ?? "")))).flat().filter((trace) => trace.test !== undefined);
		const declarations = groupBy(code, (each) => each.file);

		for (const [file, ofFile] of groupBy(traces, (trace) => trace.file)) {
			const text = await textNow(file);
			const known = spansOf.get(file);
			const answer = text === undefined || known?.text === text ? undefined : await annotations(vscode.commands).spans(text).catch(() => undefined);
			const spans = known !== undefined && known.text === text ? known.spans : new Map<string, { "start": number; "end": number }>(answer !== undefined && "value" in answer ? answer.value.map((span) => [span.id, span]) : []);

			if (text !== undefined && answer !== undefined && "value" in answer) {
				spansOf.set(file, { "text": text, "spans": spans });
			}

			for (const trace of ofFile) {
				const test = tests.get(trace.test!.id) ?? { "outcome": trace.test!.outcome, "ran": new Set<string>() };

				for (const span of (trace.declarations ?? []).flatMap((id) => (spans.has(id) ? [spans.get(id)!] : []))) {
					const held = (declarations.get(file) ?? []).find((each) => each.start <= span.start && span.end <= each.end);

					test.ran.add(held?.id ?? `${file}#${TOP}`);
				}

				test.outcome = trace.test!.outcome;
				tests.set(trace.test!.id, test);
			}
		}

		return tests;
	}

	/** The revision each feature's tests were found for: they're found when they're asked for (the map, the data), not on
	 *  every reading — placing the traces asks the editor's BABLR, which is busy enough as code changes. */
	let testsFor = -1;

	async function findTests(): Promise<void> {
		if (testsFor === revision) {
			return;
		}

		const tests = await testsRan();

		for (const [index, each] of shown.entries()) {
			const own = new Set(code.filter((declaration) => declaration.owners.includes(index) && declaration.owners.length <= AMBIENT).map((declaration) => declaration.id));

			each.tests = [...tests].filter(([, test]) => [...test.ran].some((id) => own.has(id))).map(([id, test]) => ({ "id": id, "outcome": test.outcome })).toSorted((left, right) => left.id.localeCompare(right.id));
		}

		testsFor = revision;
	}

	async function refresh(): Promise<void> {
		if (program === undefined) {
			return;
		}

		const manifest = parseManifest(await textOf(vscode.Uri.joinPath(root, manifestPath())) ?? "");
		const { features, graph } = program;
		const before = focused === undefined ? undefined : shown[focused];

		message = manifest === undefined ? `No feature manifest: ${manifestPath()} names the program's features, by area, and the ways in and paths each owns.` : undefined;

		const entries = manifest === undefined ? [] : featuresOfManifest(manifest);
		const keys = new Map(entries.map(([area, name], index) => [`${area}\u0000${name}`, index]));
		const owners = manifest === undefined ? new Map<string, Set<string>>() : codeOwners(manifest, features, graph);
		const ledger = parseLedger(await textOf(vscode.Uri.joinPath(root, ledgerPath())));

		code = [...graph.fingerprints.keys()].flatMap((id) => {
			const range = graph.range?.(id);

			return range === undefined ? [] : [{ "id": id, "file": range.file, "start": range.start, "end": range.end, "owners": [...owners.get(id) ?? []].map((key) => keys.get(key)!).toSorted((left, right) => left - right) }];
		});

		shown = entries.map(([area, name, feature]): Shown => ({
			"area": area,
			"name": name,
			"feature": feature,
			...ledger[name] === undefined ? {} : { "status": ledger[name]!.status },
			"ways": (feature.ways ?? []).flatMap((key) => (features.has(key) ? [features.get(key)!] : [])),
			"tests": []
		}));

		const placed = new Set(entries.flatMap(([, , feature]) => feature.ways ?? []));

		unplaced = [...features.values()].filter((way) => !placed.has(way.key));
		revision += 1;
		focus(before === undefined ? undefined : shown.findIndex((each) => each.area === before.area && each.name === before.name));
	}

	/** The feature in focus: the files its code is in, marked in the Explorer; in open editors, the code it doesn't own
	 *  dimmed; its name in the status bar. */
	function focus(index: number | undefined): void {
		const before = new Set(files());

		focused = index !== undefined && index >= 0 && index < shown.length ? index : undefined;
		void vscode.commands.executeCommand("setContext", "history.features.focused", focused !== undefined);
		decorated.fire([...new Set([...before, ...files()])].map((file) => vscode.Uri.joinPath(root, file)));
		dimEditors();
		status.text = focused === undefined ? "$(layers) Features" : `$(layers) ${shown[focused]!.name}`;
		status.tooltip = focused === undefined ? "The program by feature: open the features map" : `${shown[focused]!.area}: ${shown[focused]!.feature.what}\n\nThe rest of the workspace is dimmed. Open the features map to focus on another, or on none.`;
		status.command = OPEN_MAP;
		status.show();
	}

	/** The files the feature in focus has code in, or a way in registered. */
	function files(): string[] {
		const index = focused;

		return index === undefined ? [] : [...new Set([...code.filter((each) => each.owners.includes(index)).map((each) => each.file), ...shown[index]!.ways.flatMap((way) => way.ranges.map((range) => range.file))])];
	}

	function dimEditors(): void {
		const index = focused;
		const mine = (each: Code): boolean => index !== undefined && each.owners.includes(index);

		for (const editor of vscode.window.visibleTextEditors) {
			const file = editor.document.uri.path.startsWith(root.path + "/") ? editor.document.uri.path.slice(root.path.length + 1) : undefined;

			if (index === undefined || file === undefined) {
				editor.setDecorations(dim, []);
				continue;
			}

			const declared = code.filter((each) => each.file === file);
			const offsets: [number, number][] = [];

			if (code.some((each) => each.id === `${file}#${TOP}` && mine(each))) {
				// Its module's body is its: what's dimmed is the declarations it doesn't own.
				offsets.push(...declared.filter((each) => !mine(each)).map((each): [number, number] => [each.start, each.end]));
			} else {
				// Everything but its own declarations: the rest of the module's body included.
				let at = 0;

				for (const each of declared.filter(mine).toSorted((left, right) => left.start - right.start)) {
					offsets.push([at, each.start]);
					at = Math.max(at, each.end);
				}

				offsets.push([at, editor.document.getText().length]);
			}

			editor.setDecorations(dim, offsets.filter(([start, end]) => end > start).map(([start, end]) => new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end))));
		}
	}

	const badges: vscode.FileDecorationProvider = {
		"onDidChangeFileDecorations": decorated.event,
		"provideFileDecoration": (uri) => {
			const index = focused;

			if (index === undefined || !uri.path.startsWith(root.path + "/")) {
				return undefined;
			}

			const file = uri.path.slice(root.path.length + 1);
			const count = code.filter((each) => each.file === file && each.owners.includes(index)).length;

			// A dot, not a count: beside a file's problems, a second number reads as theirs.
			return files().includes(file) ? { "badge": "●", "tooltip": `${shown[index]!.name}: ${count === 0 ? "where a way in of it is registered" : `${String(count)} declaration${count === 1 ? "" : "s"} of its code`}`, "color": new vscode.ThemeColor("charts.blue") } : undefined;
		}
	};
	/** A feature by its name (or `area / name`), or its index. */
	const featureNamed = (name: unknown): number | undefined => {
		const index = typeof name === "number" ? name : shown.findIndex((each) => each.name === name || `${each.area} / ${each.name}` === name);

		return index >= 0 && index < shown.length ? index : undefined;
	};
	/** Ask which feature, from every one of the manifest's. */
	const pickFeature = async (title: string): Promise<number | undefined> => (await vscode.window.showQuickPick(shown.map((each, index) => ({ "label": each.name, "description": each.area, "detail": each.feature.what, "index": index })), { "title": title, "matchOnDescription": true, "matchOnDetail": true }))?.index;

	/** Ask for a feature's status and why (or take them, as an agent or a test gives them), and write it into the ledger:
	 *  its name, and the files of the code only it owns. */
	async function setStatus(index: number, given?: { "status": LedgerStatus; "why": string }): Promise<boolean> {
		const each = shown[index]!;
		const picked = given?.status ?? (await vscode.window.showQuickPick(STATUS_PICKS, { "title": `${each.name}: its status`, "placeHolder": "What's been decided about it" }))?.label;

		if (picked === undefined) {
			return false;
		}

		const why = given?.why ?? await vscode.window.showInputBox({ "title": `${each.name}: ${picked}`, "prompt": "Why — what the decision rests on", "validateInput": (value) => (value.trim() === "" ? "Say why" : undefined) });

		if (why === undefined) {
			return false;
		}

		const until = picked === "experiment" && given === undefined ? await vscode.window.showInputBox({ "title": `${each.name}: until`, "prompt": "The date it's decided by (YYYY-MM-DD)", "validateInput": (value) => (/^\d{4}-\d\d-\d\d$/u.test(value) ? undefined : "YYYY-MM-DD") }) : undefined;

		if (picked === "experiment" && given === undefined && until === undefined) {
			return false;
		}

		const file = vscode.Uri.joinPath(root, ledgerPath());
		const mine = code.filter((declaration) => declaration.owners.includes(index));
		const own = mine.filter((declaration) => declaration.owners.length === 1);
		const paths = [...new Set((own.length === 0 ? mine : own).map((declaration) => declaration.file))].toSorted();

		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(ledgerText(withStatus(parseLedger(await textOf(file)), each.name, picked, why.trim(), new Date().toISOString().slice(0, 10), { "paths": paths, ...until === undefined ? {} : { "until": until } }))));
		await refresh();

		return true;
	}

	let pending: ReturnType<typeof setTimeout> | undefined;
	const soon = (): void => {
		clearTimeout(pending);
		pending = setTimeout(() => {
			void refresh();
		}, 500);
	};
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/{manifest.json,features.json,local/traces/**/*.jsonl}");

	focus(undefined);
	context.subscriptions.push(decorated, dim, status, watcher, watcher.onDidCreate(soon), watcher.onDidChange(soon), watcher.onDidDelete(soon),
		vscode.window.registerFileDecorationProvider(badges),
		vscode.window.onDidChangeVisibleTextEditors(dimEditors),
		// A declaration of the map's, opened at its start.
		vscode.commands.registerCommand("history.features.open", async (file: string, start: number) => {
			const text = await textNow(file);
			const at = text === undefined ? undefined : new vscode.Position(text.slice(0, start).split("\n").length - 1, start - (text.lastIndexOf("\n", start - 1) + 1));

			await vscode.commands.executeCommand("vscode.open", vscode.Uri.joinPath(root, file), at === undefined ? {} : { "selection": new vscode.Range(at, at) });
		}),
		// Focus on a feature: by name or index (the map, an agent, a test), else picked.
		vscode.commands.registerCommand("history.features.focus", async (name?: unknown) => {
			focus(featureNamed(name) ?? (name === undefined ? await pickFeature("Focus on a feature: the rest of the workspace steps back") : undefined));

			return focused !== undefined;
		}),
		vscode.commands.registerCommand("history.features.unfocus", () => {
			focus(undefined);
		}),
		// A feature's decision, into the ledger (by name with its status and why, else picked and asked).
		vscode.commands.registerCommand("history.features.setStatus", async (name?: unknown, given?: LedgerStatus, why?: string) => {
			const index = featureNamed(name) ?? (name === undefined ? await pickFeature("Set a feature's status") : undefined);

			return index === undefined ? false : setStatus(index, given === undefined || why === undefined ? undefined : { "status": given, "why": why });
		}),
		// The program by feature, as data — what the map draws. With `since`, the revision the asker has: nothing more,
		// unless what's shown has changed since.
		vscode.commands.registerCommand("history.features", async (options?: { "since"?: number }) => {
			if (options?.since === undefined) {
				await refresh();
			} else if (options.since === revision) {
				return { "revision": revision, ...focused === undefined ? {} : { "focused": focused } };
			}

			await findTests();

			return {
				"revision": revision,
				...message === undefined ? {} : { "message": message },
				"features": shown.map((each) => ({ "area": each.area, "name": each.name, "what": each.feature.what, ...each.status === undefined ? {} : { "status": each.status }, "ways": each.ways.map((way) => way.key), "tests": each.tests })),
				"code": code.map((each) => ({ "file": each.file, "name": nameOf(each.id), "start": each.start, "end": each.end, "owners": each.owners })),
				"unplaced": unplaced.map((way) => way.key),
				...focused === undefined ? {} : { "focused": focused }
			};
		}),
		{ "dispose": () => { clearTimeout(pending); } });

	return {
		"show": async (features, graph) => {
			program = { "features": features, "graph": graph };
			await refresh();
		}
	};
}
