/**
 * What a way in reaches (packages/editor/ARCHITECTURE.md, *Workspace tools*): for a command, hub request, agent tool, core
 * module, setting, view…, the feature that owns it, where it's registered, what taking it out would free and leave by hand
 * (`silo remove`'s plan, nothing written), and everywhere code, tests and docs name it. Asked before changing, moving or
 * removing one.
 * - **On the code:** on a way in's registration the lightbulb offers *What … reaches*, and History: What a Way In
 *   Reaches… asks for the one at the cursor (or one picked): a quick pick of every place, each opening it.
 * - **As data:** `history.reach` <key or id> (core's `code.reach`, agents' `code_reach`), `{ ready: false }` until History
 *   has read the program.
 * The program is History's reading (the TypeScript server plugin's, edits included); the docs and code it searches are the
 * ledger view's.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { LedgerView } from "./ledger";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { declaredFeatures, ownersOf, parseLedger, removalOf } from "@brianjenkins94/util/silo/ledger";
import * as vscode from "vscode";

/** The places naming a way in that are listed, at most, of each kind. */
const NAMED = 100;

/** A test file, as node finds them (the terminal's node command's isTestFile), and an in-editor spec. */
const TEST_FILE = /(?:^|\/)tests?\/|(?:^|[./_-])(?:test|spec)[._-]/u;

/** A place: a file's 1-based line, and its text. */
interface Place {
	"file": string;
	"line": number;
	"text": string;
}

/** What `history.reach` answers for one way in. */
interface Reach {
	"ready": true;
	"way": { "key": string; "facet": string; "id": string; "sides": string[] };
	/** The ledger's features owning it: by its `ways`, else by its registration's files. */
	"features": string[];
	"registered": Place[];
	/** What only it reaches: its declarations, the files that would go whole, their lines and bytes. */
	"frees": { "declarations": number; "files": string[]; "lines": number; "bytes": number };
	/** Its code in files it shares with others: taken out by hand. */
	"byHand": Place[];
	"named": Place[];
	"tests": Place[];
	"docs": Place[];
	"counts": { "named": number; "tests": number; "docs": number };
}

export interface ReachView {
	/** The program as History read it now. */
	"read": (features: ReadonlyMap<string, Feature>, graph: DeclarationGraph) => void;
}

export function reachView(context: vscode.ExtensionContext, root: vscode.Uri, ledger: LedgerView): ReachView {
	let program: { "features": ReadonlyMap<string, Feature>; "graph": DeclarationGraph } | undefined;
	const relative = (uri: vscode.Uri): string | undefined => (uri.scheme === root.scheme && uri.path.startsWith(root.path + "/")
		? uri.path.slice(root.path.length + 1)
		: undefined);
	const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;
	const textOf = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	/** The way in `target` names: its key, or its id when one way in has it; else the closest, to choose from. */
	const wayOf = (target: string): Feature | { "matches": string[]; "found": number } => {
		const ways = [
			...program?.features.values() ?? []
		];
		const matching = ways.filter((way) => way.key === target || way.id === target);

		if (matching.length === 1) {
			return matching[0];
		}

		const close = matching.length > 1
			? matching
			: ways.filter((way) => way.key.includes(target) || target.includes(way.id));

		return {
			"matches": close.slice(0, 20).map((way) => way.key),
			"found": matching.length
		};
	};

	async function reachOf(way: Feature): Promise<Reach> {
		const { files, texts } = await ledger.workspace();
		const tracked = [...files];
		const parsed = parseLedger(await ledger.ledgerText());
		// (the package manifests a removal takes it out of: the ledger view reads code and docs, not JSON)
		const manifests = new Map<string, string>();

		for (const file of tracked.filter((each) => /(?:^|\/)package\.json$/u.test(each) && includeByDefault(each))) {
			const text = await textOf(file);

			if (text !== undefined) {
				manifests.set(file, text);
			}
		}

		const read = (file: string): string | undefined => texts.get(file) ?? manifests.get(file);
		const placeAt = (file: string, offset: number): Place => {
			const text = read(file) ?? "";
			const line = lineAt(text, offset);

			return {
				"file": file,
				"line": line,
				"text": (text.split("\n")[line - 1] ?? "").trim().slice(0, 200)
			};
		};

		const removal = removalOf({
			"name": way.id,
			"why": "(what it reaches)",
			"key": way.key,
			"paths": [],
			"ledger": parsed,
			"features": program?.features ?? new Map(),
			"graph": program?.graph ?? {
				"fingerprints": new Map(),
				"nodes": () => [],
				"edges": () => []
			},
			"tracked": tracked,
			"textOf": read,
			"head": "HEAD",
			"today": new Date().toISOString().slice(0, 10)
		});
		const byWays = declaredFeatures(parsed).filter(([, entry]) => entry.ways?.includes(way.key) === true).map(([name]) => name);
		const owners = byWays.length > 0
			? byWays
			: [
					...new Set(way.ranges.flatMap((range) => ownersOf(parsed, range.file)))
				];
		// (by name: quoted, or as a word where it's an identifier — where it's registered aside)
		const escaped = way.id.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		const naming = new RegExp(/^[A-Za-z_$][\w$]*$/u.test(way.id)
			? `(?<![\\w$])${escaped}(?![\\w$])`
			: `["'\`]${escaped}["'\`]`, "u");
		const named: Place[] = [];
		const docs: Place[] = [];

		// (the docs, the program's code and its tests: not what's vendored or built)
		const searched = [...texts].filter(([file]) => file.endsWith(".md") || includeByDefault(file) || TEST_FILE.test(file));

		for (const [file, text] of searched.sort(([left], [right]) => left.localeCompare(right))) {
			const isDoc = file.endsWith(".md");
			const registered = way.ranges.filter((range) => range.file === file).map((range) => [
				lineAt(text, range.start),
				lineAt(text, range.end)
			]);

			for (const [index, line] of text.split("\n").entries()) {
				if (naming.test(line) && !registered.some(([from, to]) => index + 1 >= from && index + 1 <= to)) {
					(isDoc ? docs : named).push({
						"file": file,
						"line": index + 1,
						"text": line.trim().slice(0, 200)
					});
				}
			}
		}

		const code = named.filter(({ file }) => !TEST_FILE.test(file));
		const tests = named.filter(({ file }) => TEST_FILE.test(file));
		const whole = new Set(removal.price.files);

		return {
			"ready": true,
			"way": {
				"key": way.key,
				"facet": way.facet,
				"id": way.id,
				"sides": way.sides
			},
			"features": owners,
			"registered": way.ranges.map((range) => placeAt(range.file, range.start)),
			"frees": {
				"declarations": removal.price.declarations.length,
				"files": removal.price.files,
				"lines": removal.price.lines,
				"bytes": removal.price.bytes
			},
			"byHand": removal.byHand.flatMap((id) => {
				const range = program?.graph.range?.(id);
				const file = range?.file ?? id.slice(0, id.indexOf("#"));

				return whole.has(file)
					? []
					: [
							range === undefined
								? {
										"file": file,
										"line": 1,
										"text": id.slice(id.indexOf("#") + 1)
									}
								: placeAt(range.file, range.start)
						];
			}).slice(0, NAMED),
			"named": code.slice(0, NAMED),
			"tests": tests.slice(0, NAMED),
			"docs": docs.slice(0, NAMED),
			"counts": { "named": code.length, "tests": tests.length, "docs": docs.length }
		};
	}

	/** The ways in registered at `offset` in `file`. */
	const waysAt = (file: string, offset: number): Feature[] => [
		...program?.features.values() ?? []
	].filter((way) => way.ranges.some((range) => range.file === file && offset >= range.start && offset <= range.end));

	/** A reach, in a quick pick: each place a row that opens it. */
	async function show(way: Feature): Promise<void> {
		const reach = await reachOf(way);

		type Item = vscode.QuickPickItem & { "place"?: Place };
		const items: Item[] = [];
		const group = (label: string, places: Place[], count = places.length): void => {
			if (places.length > 0) {
				items.push({
					"label": count > places.length
						? `${label} (${String(places.length)} of ${String(count)})`
						: `${label} (${String(count)})`,
					"kind": vscode.QuickPickItemKind.Separator
				});
				items.push(...places.map((place) => ({
					"label": place.text === ""
						? place.file
						: place.text,
					"description": `${place.file}:${String(place.line)}`,
					"place": place
				})));
			}
		};

		group("Registered", reach.registered);
		group("Would go whole", reach.frees.files.map((file) => ({ "file": file, "line": 1, "text": file })));
		group("Left by hand, in files it shares", reach.byHand);
		group("Code naming it", reach.named, reach.counts.named);
		group("Tests naming it", reach.tests, reach.counts.tests);
		group("Docs naming it", reach.docs, reach.counts.docs);

		const pick = vscode.window.createQuickPick<Item>();
		const open = async (place: Place, preview: boolean): Promise<void> => {
			const at = new vscode.Position(place.line - 1, 0);

			await vscode.window.showTextDocument(vscode.Uri.joinPath(root, place.file), {
				"selection": new vscode.Range(at, at),
				"preview": true,
				"preserveFocus": preview
			});
		};

		pick.title = `${way.facet} ${way.id}: ${reach.features.length === 0
			? "no feature owns it"
			: reach.features.join(", ")}`;
		const counted = (count: number, one: string): string => `${String(count)} ${one}${count === 1
			? ""
			: "s"}`;
		const whole = reach.frees.files.length === 0
			? ""
			: `; ${counted(reach.frees.files.length, "file")} would go whole`;

		pick.placeholder = reach.frees.declarations === 0
			? "Only it reaches nothing: taking it out frees no code"
			: `Only it reaches ${counted(reach.frees.declarations, "declaration")}, ${counted(reach.frees.lines, "line")}${whole}`;
		pick.matchOnDescription = true;
		pick.items = items;
		pick.onDidChangeActive(([item]) => {
			if (item?.place !== undefined) {
				void open(item.place, true);
			}
		});
		pick.onDidAccept(() => {
			const [item] = pick.selectedItems;

			pick.hide();

			if (item?.place !== undefined) {
				void open(item.place, false);
			}
		});
		pick.onDidHide(() => {
			pick.dispose();
		});
		pick.show();
	}

	context.subscriptions.push(
		// What a way in reaches, by its key (`hub request|code.problems`) or its id when one way in has it. Undefined
		// without one; `{ ready: false }` until History has read the program.
		vscode.commands.registerCommand("history.reach", async (target: unknown) => {
			if (program === undefined || typeof target !== "string" || target.trim() === "") {
				return program === undefined
					? { "ready": false }
					: undefined;
			}

			const way = wayOf(target.trim());

			return "matches" in way
				? { "ready": true, ...way }
				: reachOf(way);
		}),
		// The same, shown: the way in `key` names, else the one at the cursor, else one picked.
		vscode.commands.registerCommand("history.reach.show", async (key?: unknown) => {
			if (program === undefined) {
				void vscode.window.showInformationMessage("History hasn't read the program yet: open a TypeScript file, and ask again in a moment.");

				return;
			}

			const editor = vscode.window.activeTextEditor;
			const path = editor === undefined
				? undefined
				: relative(editor.document.uri);
			const named = typeof key === "string"
				? wayOf(key)
				: undefined;
			const here = path === undefined || editor === undefined
				? []
				: waysAt(path, editor.document.offsetAt(editor.selection.active));
			const asked = named !== undefined && !("matches" in named)
				? named
				: undefined;
			let way = asked ?? (here.length === 1
				? here[0]
				: undefined);

			if (way === undefined) {
				const owners = new Map(declaredFeatures(parseLedger(await ledger.ledgerText())).flatMap(([name, entry]) => (entry.ways ?? []).map((each) => [each, name] as const)));
				const choices = (here.length > 1
					? here
					: [
							...program.features.values()
						]).toSorted((left, right) => left.key.localeCompare(right.key));
				const chosen = await vscode.window.showQuickPick(choices.map((each) => ({ "label": `${each.facet} ${each.id}`, "description": owners.get(each.key) ?? "", "way": each })), { "title": "What a way in reaches", "placeHolder": "A command, hub request, agent tool, core module, setting, view…", "matchOnDescription": true });

				way = chosen?.way;
			}

			if (way !== undefined) {
				await show(way);
			}
		}),
		// On a way in's registration, the lightbulb: what it reaches.
		vscode.languages.registerCodeActionsProvider({ "scheme": root.scheme }, {
			"provideCodeActions": (document, range) => {
				const path = relative(document.uri);

				return path === undefined
					? []
					: waysAt(path, document.offsetAt(range.start)).map((way) => {
							const action = new vscode.CodeAction(`What ${way.facet} ${way.id} reaches`, vscode.CodeActionKind.QuickFix);

							action.command = {
								"title": action.title,
								"command": "history.reach.show",
								"arguments": [way.key]
							};

							return action;
						});
			}
		}, {
			"providedCodeActionKinds": [vscode.CodeActionKind.QuickFix]
		})
	);

	return {
		"read": (features, graph) => {
			program = { "features": features, "graph": graph };
		}
	};
}
