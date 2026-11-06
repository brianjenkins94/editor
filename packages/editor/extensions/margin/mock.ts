/**
 * Mock a value (RUNNING.md, *Rules*): give the program a different value from the lightbulb, on the line it's about. A variable
 * now (at a stop, as code could: not a const), or on every run, by a rule placed on its line; `process.argv` on every run, by a
 * rule about the program. Rules, so they show (placed.ts) and can be taken out, rather than a hidden setting.
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import { loadPolicyFiles, replaceRule } from "@brianjenkins94/editor-api/policy";
import { joinCommandLine } from "@brianjenkins94/editor-api/rules";
import { EMPTY_POLICY, given } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { placedIn, referLine } from "./placed";
import { valueNamed } from "./values";

const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

/** What's typed, read as JSON if it is, else as text. */
function valueOf(typed: string): unknown {
	try {
		return JSON.parse(typed) as unknown;
	} catch {
		return typed;
	}
}

/** A command line's arguments: split on spaces, a quoted one kept whole. */
export function argumentsOf(line: string): string[] {
	return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** The variables `line`'s text declares. */
const declaredIn = (text: string): string[] => [...text.matchAll(/\b(?:const|let|var)\s+([\p{ID_Start}$_][\p{ID_Continue}$]*)/gu)].map((match) => match[1]);

/** The variables on `line` of `document` someone could mean: what it declares, and what the Margin has a value of there. */
function variablesOn(document: vscode.TextDocument, line: number, word: string | undefined): string[] {
	const named = word !== undefined && valueNamed(document.uri.toString(), line, word) ? [word] : [];

	return [...new Set([...named, ...declaredIn(document.lineAt(line).text)])];
}

export function installMock(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
	const span = async (word: string, attrs: Record<string, string>, work: () => Promise<void>): Promise<void> => (log === undefined ? work() : log.span(`editor.extensions.margin.mock.${word}`, attrs, work));
	const ask = async (title: string, value?: string): Promise<string | undefined> => vscode.window.showInputBox({ "title": title, "prompt": "JSON, or text", ...value === undefined ? {} : { "value": value } });

	context.subscriptions.push(
		// Now, at the stop: the session's own Set Value, as the Variables view's.
		vscode.commands.registerCommand("margin.setValue", async (name: string) => {
			const session = vscode.debug.activeDebugSession;
			const typed = session === undefined ? undefined : await ask(`Set ${name} now`);

			if (session !== undefined && typed !== undefined) {
				await span("setValue", { "op": name }, async () => {
					await Promise.resolve(session.customRequest("setVariable", { "name": name, "value": JSON.stringify(valueOf(typed)) })).then(undefined, (error: unknown) => {
						void vscode.window.showWarningMessage(`${name} wasn't set: ${error instanceof Error ? error.message : String(error)}. A rule can set a const, on every run.`);
					});
				});
			}
		}),
		vscode.commands.registerCommand("margin.mockVariable", async (uri: string, line: number, name: string) => {
			const typed = await ask(`Set ${name} on every run`);

			if (typed === undefined) {
				return;
			}

			await span("variable", { "op": name }, async () => {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
				const ref = await referLine(document, line);

				if (ref === undefined) {
					void vscode.window.showWarningMessage("A rule can't be placed on that line: the file doesn't parse as it is.");

					return;
				}

				const target = `variables.${name}`;
				const previous = (await placedIn(document)).find((each) => each.whose === "mine" && each.line === line && each.rule.then.some((action) => action.target_id === target));
				const rule: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "at", "operator_id": "is", "argument": ref }] }, "then": [{ "action_id": "set", "target_id": target, "argument": valueOf(typed) }] };

				await replaceRule(previous?.rule, rule);
			});
		}),
		vscode.commands.registerCommand("margin.mockArgv", async (uri: string) => {
			const program = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false);
			const files = await loadPolicyFiles();
			const previous = given({ ...EMPTY_POLICY, "rules": files?.mine.rules ?? [] }, { "program": program, "trigger": "you" }, "process.argv");
			const typed = await vscode.window.showInputBox({ "title": `${program}'s arguments, on every run`, "prompt": "As on a command line. Nothing: take the rule out", "value": previous === undefined ? "" : joinCommandLine((previous.values[0] ?? []) as unknown[]) });

			if (typed !== undefined) {
				await span("argv", {}, async () => {
					const args = argumentsOf(typed);

					await replaceRule(previous?.rule, args.length === 0 ? undefined : { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": program }] }, "then": [{ "action_id": "give", "target_id": "process.argv", "argument": [args] }] });
				});
			}
		}),
		vscode.languages.registerCodeActionsProvider(LANGUAGES.map((language) => ({ "language": language, "scheme": "file" })), {
			"provideCodeActions": (document, range) => {
				const { line } = range.start;
				const at = document.getWordRangeAtPosition(range.start);
				const action = (title: string, command: string, ...args: unknown[]): vscode.CodeAction => {
					const made = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					made.command = { "title": title, "command": command, "arguments": args };

					return made;
				};
				const stopped = vscode.debug.activeStackItem !== undefined;

				return [
					...variablesOn(document, line, at === undefined ? undefined : document.getText(at)).flatMap((name) => [
						...stopped ? [action(`Set ${name} now…`, "margin.setValue", name)] : [],
						action(`Set ${name} on every run…`, "margin.mockVariable", document.uri.toString(), line, name)
					]),
					...document.lineAt(line).text.includes("process.argv") ? [action("Give the program its arguments, on every run…", "margin.mockArgv", document.uri.toString())] : []
				];
			}
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] })
	);
}
