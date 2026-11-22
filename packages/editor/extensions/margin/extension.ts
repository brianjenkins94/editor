import type { AskEvent, CapabilityChoice } from "@brianjenkins94/editor-api";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import type { PaneAction, PaneContent, PaneItem } from "@brianjenkins94/editor-api/pane";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import { installCoverage } from "./coverage";
import { installMock } from "./mock";
import { installPin } from "./pin";
import { installPlaced, placedMarks } from "./placed";
import { endMarks, installValues, runsShown, valueItems, valuesState } from "./values";

const VIEW = "margin";

interface Asking { "session": string; "ask": AskEvent }

function code(text: string): string {
	return `\`${text.replaceAll("`", "'")}\``;
}

function questionOf({ session, ask }: Asking): Pick<PaneContent, "items"> & { "marks": NonNullable<PaneContent["marks"]> } {
	const known = ask.resolved ? ask.resource : undefined;
	const always = ask.resolved ? `${ask.capability} on ${ask.resource}, in your policy (.silo/policy/<you>.json)` : undefined;
	const choice = (label: string, [once, run, forever]: [CapabilityChoice, CapabilityChoice, CapabilityChoice], does: string): PaneAction => ({
		"title": label,
		"command": "margin.decide",
		"arguments": [session, once],
		"tooltip": `${does}: this call, and stop here again next time`,
		"more": [
			{ "title": "this call", "command": "margin.decide", "arguments": [session, once], "tooltip": `${does}: this call` },
			{ "title": "this run", "command": "margin.decide", "arguments": [session, run], "tooltip": `${does}: every ${ask.capability} call, until this run ends (kept nowhere)` },
			{ "title": "always", "command": "margin.decide", "arguments": [session, forever], "tooltip": always === undefined ? "Needs the resource the call reaches, which isn't known before the line runs" : `${does}: ${always}`, "disabled": always === undefined }
		]
	});
	const item: PaneItem = {
		"id": "ask",
		"at": { "lines": [ask.line, ask.line] },
		"content": { "markdown": `${code(ask.callee)} ${ask.resolved ? code(`'${ask.resource}'`) : `_${ask.resource}_`} ${ask.capability}` },
		"tone": ask.dangerous ? "warning" : "question",
		"actions": [
			choice("Allow", ["allow-once", "allow-run", "allow-always"], "Let it run, for real"),
			choice("Skip", ["skip", "skip-run", "skip-always"], "Don't make it: the run goes on as if it did nothing"),
			choice("Deny", ["deny", "deny-run", "deny-always"], "Fail it, as a denied call does (EACCES)"),
			{ "title": "Give…", "command": "margin.give", "arguments": [session, ask.capability, known], "tooltip": "Don't make it: this call returns what you say" },
			{ "title": "Rule…", "command": "margin.rule", "arguments": [session, ask.capability, known], "tooltip": "A rule for this and calls like it: pick what it covers and what happens, saved in your policy" }
		]
	};

	return { "items": [item], "marks": [{ "at": item.at, "kind": "stopped", "title": `Stopped: ${ask.callee} needs your answer` }] };
}

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension(VIEW, vscode);

	installCoverage(context);

	const asks = new Map<string, Asking>();
	const redraw = (uri: string): void => {
		void refreshPane(vscode.commands, VIEW, uri);
	};
	const clear = (session: string): void => {
		for (const [uri, asking] of asks) {
			if (asking.session === session) {
				asks.delete(uri);
				redraw(uri);
			}
		}
	};

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	installValues(context, observed?.log, redraw, clear);
	installMock(context, observed?.log);
	installPin(context, observed?.log);
	installPlaced(context, observed?.log, async () => refreshPane(vscode.commands, VIEW));

	context.subscriptions.push(
		vscode.commands.registerCommand("margin.paneView", async (uri: unknown): Promise<PaneContent | undefined> => {
			if (typeof uri !== "string") {
				return undefined;
			}

			const asking = asks.get(uri);
			const question = asking === undefined ? undefined : questionOf(asking);
			const text = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText();
			const items = [...question?.items ?? [], ...valueItems(uri, text)];
			const marks = [...question?.marks ?? [], ...endMarks(uri), ...await placedMarks(uri)];

			const runs = runsShown(uri);

			return items.length === 0 && marks.length === 0 && runs.runs === undefined ? undefined : { "items": items, "marks": marks, ...runs };
		}),
		vscode.commands.registerCommand("margin.state", async (file: unknown) => {
			const uri = vscode.Uri.file(String(file)).toString();
			const text = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText();
			const asking = asks.get(uri);

			return {
				"file": vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false),
				...await valuesState(uri, text),
				...asking === undefined ? {} : { "question": { "session": asking.session, "line": asking.ask.line + 1, "call": asking.ask.callee, "capability": asking.ask.capability, "resource": asking.ask.resource, "answers": ["allow-once", "allow-run", "allow-always", "skip", "skip-run", "skip-always", "deny", "deny-run", "deny-always"] } }
			};
		}),
		vscode.commands.registerCommand("margin.decide", async (session: unknown, choice: unknown) => {
			const decide = async (): Promise<void> => {
				await vscode.commands.executeCommand("editor.capability.decide", session, choice);
				clear(String(session));
			};

			await (observed === undefined ? decide() : observed.log.span("editor.extensions.margin.decide", { "op": String(choice) }, decide));
		}),
		vscode.commands.registerCommand("margin.give", async (session: string, capability: string, resource?: string) => {
			const given = await vscode.commands.executeCommand<{ "value": unknown } | undefined>("capabilities.pickValue", capability, resource);

			if (given !== undefined) {
				await vscode.commands.executeCommand("editor.capability.decide", session, "give-once", undefined, given.value);
				clear(session);
			}
		}),
		vscode.commands.registerCommand("margin.rule", async (session: string, capability: string, resource?: string) => {
			const rule = await vscode.commands.executeCommand<Rule | undefined>("capabilities.pickRule", capability, resource);

			if (rule !== undefined) {
				await vscode.commands.executeCommand("editor.capability.decide", session, "rule", rule);
				clear(session);
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
			if (event === "ask") {
				const ask = body as AskEvent;
				const uri = vscode.Uri.file(ask.file).toString();

				clear(session.id);
				asks.set(uri, { "session": session.id, "ask": ask });
				redraw(uri);
			}
		}),
		vscode.debug.onDidChangeActiveStackItem((item) => {
			const { activeDebugSession } = vscode.debug;

			if (item === undefined && activeDebugSession !== undefined) {
				clear(activeDebugSession.id);
			}
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			clear(session.id);
		})
	);
}
