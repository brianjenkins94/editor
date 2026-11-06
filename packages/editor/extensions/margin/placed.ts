/**
 * A rule placed in the code (RUNNING.md, *Rules*): tied to a statement, followed through edits, shown as a mark in the gutter
 * with its sentence on hover, so a mocked value isn't invisible. A place that's lost, or only uncertain, doesn't apply (it might
 * be the wrong line), and says so in the file rather than quietly doing nothing: the lightbulb puts it back.
 */
import type { SpanRef } from "@brianjenkins94/editor-api/annotations";
import type { PaneMark } from "@brianjenkins94/editor-api/pane";
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { loadPolicyFiles, movePlace } from "@brianjenkins94/editor-api/policy";
import { catalogOf, describeRule } from "@brianjenkins94/editor-api/rules";
import * as policy from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

const catalog = catalogOf(policy);
const POLICY_FILES = "**/.silo/{policy.json,policy/*.json}";
const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

/** A rule placed in a file, and where it is now. */
export interface Placed {
	"rule": Rule;
	"whose": "mine" | "shared";
	"ref": SpanRef;
	"sentence": string;
	"status": string;
	/** The 0-based line it's on: none when it's lost. */
	"line"?: number;
}

/** A place someone can act on: the line (trimmed) as a span reference. Undefined: the file doesn't parse, or there's no BABLR. */
export async function referLine(document: vscode.TextDocument, line: number): Promise<SpanRef | undefined> {
	const { firstNonWhitespaceCharacterIndex, range } = document.lineAt(line);
	const start = document.offsetAt(new vscode.Position(line, firstNonWhitespaceCharacterIndex));
	const answer = await annotations(vscode.commands).refer(document.getText(), vscode.workspace.asRelativePath(document.uri, false), [{ "start": start, "end": document.offsetAt(range.end) }]);

	return "value" in answer ? answer.value[0] : undefined;
}

/** The rules placed in `document`, as it is now. */
export async function placedIn(document: vscode.TextDocument): Promise<Placed[]> {
	const file = vscode.workspace.asRelativePath(document.uri, false);
	const files = await loadPolicyFiles();
	const rules = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).flatMap((rule) => (policy.placesOf(rule) as SpanRef[]).filter((ref) => ref.file === file).map((ref) => ({ "rule": rule, "whose": whose, "ref": ref }))));

	if (rules.length === 0) {
		return [];
	}

	const text = document.getText();
	const answer = await annotations(vscode.commands).resolve(text, file, rules.map(({ ref }) => ref));

	// (the text can't be parsed as it is, or there's no BABLR: nothing to say this time)
	if (!("value" in answer)) {
		return [];
	}

	return rules.map((placed, index) => {
		const found = answer.value[index];
		const start = found?.status === "orphaned" ? undefined : found?.candidate?.start;

		return { ...placed, "sentence": describeRule(placed.rule, catalog), "status": found?.status ?? "orphaned", ...start === undefined ? {} : { "line": document.positionAt(start).line } };
	});
}

/** Whether `placed` applies: a place that's lost or only uncertain doesn't. */
export const applies = ({ status }: Placed): boolean => status !== "uncertain" && status !== "orphaned";

/** `rule` with its place at `ref` instead. */
function withPlace(rule: Rule, ref: SpanRef): Rule {
	const moved = (predicate: Predicate): Predicate => {
		if ("predicates" in predicate) {
			return { ...predicate, "predicates": predicate.predicates.map(moved) };
		}

		return predicate.target_id === "at" ? { ...predicate, "argument": ref } : predicate;
	};

	return { ...rule, "when": moved(rule.when) as Rule["when"] };
}

let collection: vscode.DiagnosticCollection | undefined;

/** The gutter's marks for the rules placed in `uri`, and a problem for each that's lost. */
export async function placedMarks(uri: string): Promise<PaneMark[]> {
	const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

	if (document === undefined) {
		return [];
	}

	const placed = await placedIn(document);

	// On the code too, as a call a rule decides is: what runs isn't what this line says.
	collection?.set(document.uri, placed.map((each) => {
		const problem = applies(each) && each.line !== undefined
			? new vscode.Diagnostic(document.lineAt(each.line).range, `A rule changes what this line does: ${each.sentence}`, vscode.DiagnosticSeverity.Information)
			: new vscode.Diagnostic(document.lineAt(0).range, `A rule's place in this file is lost, so it doesn't apply: ${each.sentence}. Put the cursor where it belongs: the lightbulb puts it back.`, vscode.DiagnosticSeverity.Warning);

		problem.source = "rules";

		return problem;
	}));

	return placed.flatMap((each): PaneMark[] => (each.status === "orphaned" ? [] : [{ "at": { "ref": each.ref }, "kind": applies(each) ? "rule" : "rule-uncertain", "title": applies(each) ? each.sentence : `Not sure this is its place, so it doesn't apply: ${each.sentence}` }]));
}

export function installPlaced(context: vscode.ExtensionContext, log: ObservedExtension["log"] | undefined, redraw: () => Promise<void>): void {
	collection = vscode.languages.createDiagnosticCollection("rules");

	const watcher = vscode.workspace.createFileSystemWatcher(POLICY_FILES);
	const changed = (): void => {
		void redraw();
	};

	context.subscriptions.push(
		collection,
		watcher,
		watcher.onDidCreate(changed),
		watcher.onDidChange(changed),
		watcher.onDidDelete(changed),
		vscode.commands.registerCommand("margin.placeRule", async (whose: "mine" | "shared", rule: Rule, uri: string, line: number) => {
			const place = async (): Promise<void> => {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
				const ref = await referLine(document, line);

				if (ref === undefined) {
					void vscode.window.showWarningMessage("That line can't be a rule's place: the file doesn't parse as it is.");

					return;
				}

				await movePlace(whose, rule, withPlace(rule, ref));
			};

			await (log === undefined ? place() : log.span("editor.extensions.margin.placed.place", { "op": whose, "count": line }, place));
		}),
		vscode.languages.registerCodeActionsProvider(LANGUAGES.map((language) => ({ "language": language, "scheme": "file" })), {
			"provideCodeActions": async (document, range) => {
				const action = (title: string, command: string, ...args: unknown[]): vscode.CodeAction => {
					const made = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					made.command = { "title": title, "command": command, "arguments": args };

					return made;
				};

				return (await placedIn(document)).flatMap((each) => [
					...applies(each) ? [] : [action(`Put the rule back here: ${each.sentence}`, "margin.placeRule", each.whose, each.rule, document.uri.toString(), range.start.line)],
					...(each.line === range.start.line || !applies(each)) && each.whose === "mine" ? [action(`Take out your rule: ${each.sentence}`, "capabilities.takeOut", each.rule)] : []
				]);
			}
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] })
	);
}
