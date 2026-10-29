/**
 * The feature ledger in the editor (packages/silo/README.md, *The feature ledger*: "In the editor"), what `silo check`
 * says, held to the workspace as it is:
 * - **Drift, in Problems** (lib's util/silo/ledger `drift`, the same checks): each a problem on `.silo/features.json`, at
 *   the entry it's about (a dead end the ledger doesn't name, at its top), with both ways out.
 * - **Dormant ways in, where they're registered** (`dormantWays`, by CI's records of what the runs reached): in the
 *   evidence's purple, a Hint with the price, and the lightbulb's two ways out — Keep for 90 days (`silo status … active
 *   --until`) and Remove (`silo remove`: the files only it reaches, its manifest entries, the tombstone; nothing
 *   committed) — writing what those commands write.
 * - **What a way in reaches** (`history.reach`, core's `code.reach`, agents' `code_reach`): the feature that owns it, where
 *   it's registered, what Remove would free (the same plan, nothing written), and everywhere code, tests and docs name it.
 * Its ways in are History's reading (the TypeScript server plugin's, edits included); the docs and code it searches are
 * the workspace's files, read once and kept as they change.
 */
import type { Feature } from "@brianjenkins94/util/silo/features";
import type { DeclarationGraph } from "@brianjenkins94/util/silo/graph";
import type { WayCode } from "@brianjenkins94/util/silo/ledger";
import type { Price } from "@brianjenkins94/util/silo/cost";
import { priceText } from "@brianjenkins94/util/silo/cost";
import { includeByDefault } from "@brianjenkins94/util/silo/history";
import { ledgerPath, manifestPath } from "@brianjenkins94/util/silo/layout";
import { CI_RECORDS, dormantWays, drift, ledgerText, parseLedger, reachedFromRecords, removalOf, removalText, withStatus } from "@brianjenkins94/util/silo/ledger";
import { featuresOfManifest, parseManifest } from "@brianjenkins94/util/silo/manifest";
import * as vscode from "vscode";

/** The files drift reads: docs, and code. */
const READ = "**/*.{md,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const EXCLUDE = "**/node_modules/**";

/** The places `history.reach` lists that name a way in, at most. */
const NAMED = 100;

/** A test file, as node finds them (the terminal's node command's isTestFile): what names a way in from a test. */
const TEST_FILE = /(?:^|\/)tests?\/|(?:^|[./_-])test[._-]/u;

/** How long Keep keeps a dormant way in before it asks again (the ledger's lease). */
const KEEP_DAYS = 90;

/** The evidence's purple (the insights extension's, at its strongest tint): what runs say could go. */
const PURPLE = { "dark": "#b180d7", "light": "#8250df" };

export interface LedgerView {
	/** Check the ledger against the workspace, given its features and declaration graph now. */
	"check": (features: ReadonlyMap<string, Feature>, graph: DeclarationGraph) => Promise<void>;
}

/** A dormant way in, as the editor shows it: where it's registered, its code and its price. */
interface Asleep { "way": WayCode; "feature": Feature; "price": Price }

export function ledgerView(context: vscode.ExtensionContext, root: vscode.Uri, output: vscode.OutputChannel): LedgerView {
	const problems = vscode.languages.createDiagnosticCollection("silo");
	const dormantProblems = vscode.languages.createDiagnosticCollection("silo-dormant");
	const tint = vscode.window.createTextEditorDecorationType({ "dark": { "backgroundColor": PURPLE.dark + "33" }, "light": { "backgroundColor": PURPLE.light + "33" }, "overviewRulerColor": PURPLE.dark + "cc", "overviewRulerLane": vscode.OverviewRulerLane.Center });
	/** The dormant ways in, by key, as last checked; and the program they were found in (Remove plans against it). */
	let asleep = new Map<string, Asleep>();
	let program: { "features": ReadonlyMap<string, Feature>; "graph": DeclarationGraph } | undefined;
	const ledgerUri = vscode.Uri.joinPath(root, ledgerPath());
	/** Every file there is, by its path from the root; and the text of the docs and code, once read. */
	let files: Set<string> | undefined;
	const texts = new Map<string, string>();
	const relative = (uri: vscode.Uri): string | undefined => (uri.path.startsWith(root.path + "/") ? uri.path.slice(root.path.length + 1) : undefined);
	const textOf = async (uri: vscode.Uri): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	const load = async (): Promise<Set<string>> => {
		if (files === undefined) {
			files = new Set((await vscode.workspace.findFiles("**/*", EXCLUDE)).flatMap((uri) => relative(uri) ?? []));

			for (const uri of await vscode.workspace.findFiles(READ, EXCLUDE)) {
				const path = relative(uri);
				const text = path === undefined ? undefined : await textOf(uri);

				if (path !== undefined && text !== undefined) {
					texts.set(path, text);
				}
			}
		}

		return files;
	};

	// (kept as the workspace changes: a file made, changed or gone)
	const everything = vscode.workspace.createFileSystemWatcher("**/*");
	const read = vscode.workspace.createFileSystemWatcher(READ);
	const reread = async (uri: vscode.Uri): Promise<void> => {
		const path = relative(uri);
		const text = path === undefined || files === undefined ? undefined : await textOf(uri);

		if (path !== undefined && text !== undefined) {
			texts.set(path, text);
		}
	};

	context.subscriptions.push(problems, dormantProblems, tint, everything, read,
		everything.onDidCreate((uri) => {
			const path = relative(uri);

			if (path !== undefined && !path.includes("node_modules/")) {
				files?.add(path);
			}
		}),
		everything.onDidDelete((uri) => {
			const path = relative(uri);

			if (path !== undefined) {
				files?.delete(path);
				texts.delete(path);
			}
		}),
		read.onDidCreate(reread),
		read.onDidChange(reread));

	const today = (): string => new Date().toISOString().slice(0, 10);
	const writeLedger = async (text: string): Promise<void> => {
		await vscode.workspace.fs.writeFile(ledgerUri, new TextEncoder().encode(text));
		texts.set(ledgerPath(), text);
	};
	const ledgerNow = async (): Promise<string | undefined> => texts.get(ledgerPath()) ?? await textOf(ledgerUri);
	/** The manifests a removal plans against, which the checks don't read: where a way in is declared (package.json), and
	 *  the feature manifest, which it's taken out of. */
	const manifestsOf = async (tracked: string[]): Promise<Map<string, string>> => {
		const manifests = new Map<string, string>();

		for (const file of [...tracked.filter((each) => /(?:^|\/)package\.json$/u.test(each) && includeByDefault(each)), manifestPath()]) {
			const text = await textOf(vscode.Uri.joinPath(root, file));

			if (text !== undefined) {
				manifests.set(file, text);
			}
		}

		return manifests;
	};
	/** A file's 1-based line at `offset`, in its text as read. */
	const lineAt = (file: string, offset: number): number => (texts.get(file) ?? "").slice(0, offset).split("\n").length;

	/** Each dormant way in's registrations, in purple, in the editors showing them. */
	const draw = (): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			const path = relative(editor.document.uri);
			const ranges = [...asleep.values()].flatMap(({ feature }) => feature.ranges.filter((range) => range.file === path)).map((range) => new vscode.Range(editor.document.positionAt(range.start), editor.document.positionAt(range.end)));

			editor.setDecorations(tint, ranges);
		}
	};

	const dormantProblemsOf = (found: Asleep[]): void => {
		const byFile = new Map<string, vscode.Diagnostic[]>();

		for (const { way, feature, price } of found) {
			for (const range of feature.ranges) {
				const text = texts.get(range.file);

				if (text === undefined) {
					continue;
				}

				const at = (offset: number): vscode.Position => {
					const before = text.slice(0, offset);

					return new vscode.Position(before.split("\n").length - 1, offset - (before.lastIndexOf("\n") + 1));
				};
				const problem = new vscode.Diagnostic(new vscode.Range(at(range.start), at(range.end)), `dormant: ${way.facet} ${way.id} — CI's runs load its files and never run its code; deleting it ${priceText(price)}. Keep it a while, or remove it.`, vscode.DiagnosticSeverity.Hint);

				problem.source = "silo";
				problem.code = { "value": "dormant", "target": vscode.Uri.joinPath(root, ledgerPath()) };
				byFile.set(range.file, [...byFile.get(range.file) ?? [], problem]);
			}
		}

		dormantProblems.clear();

		for (const [file, found] of byFile) {
			dormantProblems.set(vscode.Uri.joinPath(root, file), found);
		}
	};

	/** The dormant way in a diagnostic is about. */
	const asleepAt = (uri: vscode.Uri, range: vscode.Range): Asleep | undefined => {
		const path = relative(uri);
		const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri.toString());

		return document === undefined ? undefined : [...asleep.values()].find(({ feature }) => feature.ranges.some((each) => each.file === path && new vscode.Range(document.positionAt(each.start), document.positionAt(each.end)).intersection(range) !== undefined));
	};

	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(draw),
		vscode.languages.registerCodeActionsProvider({ "scheme": root.scheme }, {
			"provideCodeActions": (document, range, { diagnostics }) => diagnostics.filter((each) => each.source === "silo" && typeof each.code === "object" && each.code.value === "dormant").flatMap((each) => {
				const found = asleepAt(document.uri, each.range);

				if (found === undefined) {
					return [];
				}

				const keep = new vscode.CodeAction(`Keep "${found.way.id}" for ${KEEP_DAYS} days…`, vscode.CodeActionKind.QuickFix);
				const remove = new vscode.CodeAction(`Remove "${found.way.id}"…`, vscode.CodeActionKind.QuickFix);

				keep.diagnostics = [each];
				keep.command = { "title": keep.title, "command": "history.ledger.keep", "arguments": [found.way.key] };
				remove.diagnostics = [each];
				remove.command = { "title": remove.title, "command": "history.ledger.remove", "arguments": [found.way.key] };

				return [keep, remove];
			})
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] }),
		// Keep: a decision with a reason that runs out, as `silo status "<id>" active "<why>" --key <key> --until <90 days on>`.
		vscode.commands.registerCommand("history.ledger.keep", async (key: unknown, why?: unknown) => {
			const found = typeof key === "string" ? asleep.get(key) : undefined;

			if (found === undefined) {
				return false;
			}

			const reason = typeof why === "string" ? why : await vscode.window.showInputBox({ "title": `Keep ${found.way.facet} ${found.way.id}`, "prompt": `Why it stays: asked again in ${KEEP_DAYS} days`, "ignoreFocusOut": true });

			if (reason === undefined || reason.trim() === "") {
				return false;
			}

			const until = new Date(Date.now() + KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);

			await writeLedger(ledgerText(withStatus(parseLedger(await ledgerNow()), found.way.id, "active", reason.trim(), today(), { "key": found.way.key, "until": until })));
			output.appendLine(`Kept ${found.way.facet} ${found.way.id} until ${until}: ${reason.trim()} (${ledgerPath()} — commit it).`);

			return true;
		}),
		// Remove: what `silo remove "<id>" "<why>" --key <key>` does — the files only it reaches deleted, its manifest
		// entries taken out, its tombstone in the ledger; what's left by hand said. Nothing is committed.
		vscode.commands.registerCommand("history.ledger.remove", async (key: unknown, why?: unknown) => {
			const found = typeof key === "string" ? asleep.get(key) : undefined;

			if (found === undefined || program === undefined) {
				return undefined;
			}

			const reason = typeof why === "string" ? why : await vscode.window.showInputBox({ "title": `Remove ${found.way.facet} ${found.way.id}`, "prompt": `Why it goes — deleting it ${priceText(found.price)}`, "ignoreFocusOut": true });

			if (reason === undefined || reason.trim() === "") {
				return undefined;
			}

			const status = await Promise.resolve(vscode.commands.executeCommand<{ "head"?: string } | undefined>("editor.git.status")).catch(() => undefined);
			const tracked = [...await load()];
			const manifests = await manifestsOf(tracked);
			const removal = removalOf({ "name": found.way.id, "why": reason.trim(), "key": found.way.key, "paths": [], "ledger": parseLedger(await ledgerNow()), "features": program.features, "graph": program.graph, "tracked": tracked, "textOf": (file) => texts.get(file) ?? manifests.get(file), "head": status?.head?.slice(0, 7) ?? "HEAD", "today": today() });
			const said = removalText(found.way.id, removal);

			if (!removal.nothing) {
				for (const file of removal.files) {
					await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, file));
				}

				for (const { file, text } of removal.manifests) {
					await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, file), new TextEncoder().encode(text));
				}

				await writeLedger(removal.ledger);
			}

			output.appendLine(said);
			void vscode.window.showInformationMessage(said.split("\n")[0] + (removal.nothing ? "" : " The rest is in the History output."));

			return { "nothing": removal.nothing, "files": removal.files, "manifests": removal.manifests.map((each) => each.file), "text": said };
		}),
		// What a way in reaches, by its key (`hub request|code.problems`) or its id when one way in has it: Remove's plan,
		// nothing written, and every place that names it. Undefined until History has read the program.
		vscode.commands.registerCommand("history.reach", async (target: unknown) => {
			if (program === undefined || typeof target !== "string" || target === "") {
				return program === undefined ? { "ready": false } : undefined;
			}

			const ways = [...program.features.values()];
			const matching = ways.filter((way) => way.key === target || way.id === target);

			if (matching.length !== 1) {
				const close = matching.length > 1 ? matching : ways.filter((way) => way.key.includes(target) || target.includes(way.id));

				return { "ready": true, "matches": close.slice(0, 20).map((way) => way.key), "found": matching.length };
			}

			const [way] = matching;
			const tracked = [...await load()];
			const manifests = await manifestsOf(tracked);
			const manifest = parseManifest(manifests.get(manifestPath()) ?? "");
			const owners = manifest === undefined ? [] : featuresOfManifest(manifest).filter(([, , feature]) => feature.ways?.includes(way.key) === true).map(([area, name]) => `${area} / ${name}`);
			const removal = removalOf({ "name": way.id, "why": "(what it reaches)", "key": way.key, "paths": [], "ledger": parseLedger(await ledgerNow()), "features": program.features, "graph": program.graph, "tracked": tracked, "textOf": (file) => texts.get(file) ?? manifests.get(file), "head": "HEAD", "today": today() });
			// (by name: quoted, or as a word where it's an identifier — where it's registered aside)
			const quoted = new RegExp(/^[A-Za-z_$][\w$]*$/u.test(way.id) ? `\\b${way.id.replaceAll("$", "\\$")}\\b` : `["'\`]${way.id.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["'\`]`, "u");
			const named: { "file": string; "line": number; "text": string }[] = [];

			for (const [file, text] of texts) {
				if (file.endsWith(".md") || !includeByDefault(file) && !TEST_FILE.test(file)) {
					continue;
				}

				const registered = way.ranges.filter((range) => range.file === file).map((range) => [lineAt(file, range.start), lineAt(file, range.end)]);

				for (const [index, line] of text.split("\n").entries()) {
					if (quoted.test(line) && !registered.some(([from, to]) => index + 1 >= from && index + 1 <= to)) {
						named.push({ "file": file, "line": index + 1, "text": line.trim().slice(0, 200) });
					}
				}
			}

			named.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

			return {
				"ready": true,
				"way": { "key": way.key, "facet": way.facet, "id": way.id, "sides": way.sides },
				"features": owners,
				"registered": way.ranges.map((range) => `${range.file}:${lineAt(range.file, range.start)}`),
				"frees": { "declarations": removal.price.declarations.length, "files": removal.price.files, "lines": removal.price.lines, "bytes": removal.price.bytes },
				"byHand": removal.byHand,
				"docs": removal.docs,
				"named": named.filter(({ file }) => !TEST_FILE.test(file)).slice(0, NAMED),
				"tests": named.filter(({ file }) => TEST_FILE.test(file)).slice(0, NAMED),
				"counts": { "named": named.filter(({ file }) => !TEST_FILE.test(file)).length, "tests": named.filter(({ file }) => TEST_FILE.test(file)).length }
			};
		})
	);

	return {
		"check": async (features, graph) => {
			program = { "features": features, "graph": graph };

			const there = await load();
			const ledgerText = texts.get(ledgerPath()) ?? await textOf(ledgerUri);
			const ledger = parseLedger(ledgerText);
			const found = drift(ledger, {
				"today": today(),
				"ways": [...features.values()].map((feature) => ({ "key": feature.key, "facet": feature.facet, "id": feature.id, "sides": feature.sides })),
				"exists": (path) => there.has(path) || [...there].some((file) => file.startsWith(path.replace(/\/+$/u, "") + "/")),
				"docs": [...texts].filter(([path]) => path.endsWith(".md")).map(([path, text]) => ({ "file": path, "text": text })),
				"code": [...texts].filter(([path]) => !path.endsWith(".md") && includeByDefault(path)).map(([path, text]) => ({ "file": path, "text": text }))
			});
			const lines = (ledgerText ?? "").split("\n");

			problems.set(ledgerUri, found.map((each) => {
				// (at its entry's line in the ledger; a dead end the ledger doesn't name, at the top)
				const line = each.entry === undefined ? -1 : lines.findIndex((text) => text.includes(JSON.stringify(each.entry)));
				const problem = new vscode.Diagnostic(new vscode.Range(Math.max(0, line), 0, Math.max(0, line), lines[Math.max(0, line)]?.length ?? 0), `${each.check}: ${each.message} — change the code: ${each.code}; or the decision: ${each.decision}`, vscode.DiagnosticSeverity.Error);

				problem.source = "silo";
				problem.code = each.check;

				return problem;
			}));

			// The leases run out: by CI's records (none, and nothing is dormant).
			const reached = reachedFromRecords(await textOf(vscode.Uri.joinPath(root, CI_RECORDS)));
			const dormant = reached === undefined ? [] : dormantWays(features, graph, ledger, reached, (file) => texts.get(file));

			asleep = new Map(dormant.map((each) => [each.way.key, each]));
			dormantProblemsOf(dormant);
			draw();
		}
	};
}
