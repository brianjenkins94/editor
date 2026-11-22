import type { AskEvent, CapabilityChoice, DecideRequest } from "@brianjenkins94/editor-api";
import type { Policy, Rule } from "@brianjenkins94/util/silo/policy";
import { loadEffectivePolicy, persistOverride, replaceRule } from "@brianjenkins94/editor-api/policy";
import { EMPTY_POLICY, problemOf, ruleMatches } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

const CHOICES = new Set<string>(["allow-once", "allow-run", "allow-always", "skip", "skip-run", "skip-always", "deny", "deny-run", "deny-always", "rule", "give-once"] satisfies CapabilityChoice[]);

const asks = new Map<string, AskEvent>();
const runRules = new Map<string, Rule[]>();
const onceFor = new Map<string, { "capability": string; "resource": string; "verdict": "allow" | "skip" | "deny" }>();

export function takeOnce(session: string, capability: string, resource: string): "allow" | "skip" | "deny" | undefined {
	const once = onceFor.get(session);

	if (once?.capability !== capability || once.resource !== resource) {
		return undefined;
	}

	onceFor.delete(session);

	return once.verdict;
}

export async function policyFor(session?: string): Promise<Policy> {
	let policy: Policy;

	try {
		policy = await loadEffectivePolicy();
	} catch {
		policy = EMPTY_POLICY;
	}

	const kept = session === undefined ? [] : runRules.get(session) ?? [];

	return kept.length === 0 ? policy : { ...policy, "rules": [...kept, ...policy.rules] };
}

export function asked(session: vscode.DebugSession, ask: AskEvent): void {
	asks.set(session.id, ask);
}

function answered(session: string): void {
	asks.delete(session);
}

async function ruleRequest(session: vscode.DebugSession, ask: AskEvent, rule?: Rule): Promise<DecideRequest> {
	const subject = { "capability": ask.capability, "resource": ask.resolved ? ask.resource : "" };
	const decision = rule?.then?.find(({ "action_id": actionId }) => ["allow", "deny", "skip", "ask"].includes(actionId))?.action_id;

	if (rule === undefined || problemOf(rule) !== undefined || !ruleMatches(rule, subject)) {
		throw new Error(rule === undefined ? "no rule" : problemOf(rule) ?? "the rule doesn't cover this call");
	}

	const gives = rule.then.some((action) => action.action_id === "give" && action.target_id === "result");

	if (decision !== "allow" && decision !== "deny" && decision !== "skip" && !gives) {
		throw new Error("the rule doesn't allow, deny, skip or give this call");
	}

	await replaceRule(undefined, rule);

	return { "verdict": !gives && (decision === "deny" || decision === "skip") ? decision : "allow", "policy": await policyFor(session.id) };
}

async function decide(session: vscode.DebugSession, choice: CapabilityChoice, rule?: Rule, give?: unknown): Promise<void> {
	const ask = asks.get(session.id);

	if (ask === undefined) {
		throw new Error("not stopped at a capability call");
	}

	const always = async (disposition: "allow" | "deny" | "skip"): Promise<Policy> => {
		if (!ask.resolved) {
			throw new Error(`"${disposition[0].toUpperCase()}${disposition.slice(1)} always" needs the resource the call reaches, and ${ask.resource} isn't known before it runs`);
		}

		await persistOverride(ask.capability, ask.resource, disposition);

		return policyFor(session.id);
	};

	let request: DecideRequest;

	if (choice === "rule") {
		request = await ruleRequest(session, ask, rule);
	} else if (choice === "give-once") {
		request = { "verdict": "give", "value": give ?? null };
	} else if (choice === "allow-run" || choice === "skip-run" || choice === "deny-run") {
		const action = choice.slice(0, choice.indexOf("-")) as "allow" | "skip" | "deny";

		runRules.set(session.id, [...runRules.get(session.id) ?? [], { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": ask.capability }] }, "then": [{ "action_id": action }] }]);
		request = { "verdict": action, "policy": await policyFor(session.id) };
	} else if (choice === "allow-always" || choice === "skip-always" || choice === "deny-always") {
		const disposition = choice.slice(0, choice.indexOf("-")) as "allow" | "skip" | "deny";

		request = { "verdict": disposition, "policy": await always(disposition) };
	} else {
		const verdict = choice === "allow-once" ? "allow" : choice;

		onceFor.set(session.id, { "capability": ask.capability, "resource": ask.resource, "verdict": verdict });
		request = { "verdict": verdict };
	}

	let decided: NonNullable<DecideRequest["decided"]> = request.verdict === "allow" || request.verdict === "give" ? "once" : "refused";

	if (request.verdict === "allow" && (choice === "allow-always" || choice === "rule")) {
		decided = "always";
	}

	await session.customRequest("decide", { ...request, "decided": decided });
	answered(session.id);
}

export function registerCapabilityStops(context: vscode.ExtensionContext): void {
	const running = new Map<string, vscode.DebugSession>();

	context.subscriptions.push(
		vscode.commands.registerCommand("editor.capability.decide", async (id: unknown, choice: unknown, rule?: Rule, give?: unknown) => {
			const session = typeof id === "string" ? running.get(id) : undefined;

			if (session === undefined || typeof choice !== "string" || !CHOICES.has(choice)) {
				throw new Error(session === undefined ? "no such session" : `unknown choice ${JSON.stringify(choice)} — one of ${[...CHOICES].join(", ")}`);
			}

			await decide(session, choice as CapabilityChoice, rule ?? undefined, give ?? undefined);
		}),
		vscode.debug.onDidStartDebugSession((session) => {
			running.set(session.id, session);
		}),
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => ({
				"onDidSendMessage": (message: { "type"?: string; "event"?: string }) => {
					if (message.type === "event" && message.event === "continued") {
						answered(session.id);
					}
				},
				"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => {
					if (message.type === "request" && ["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"].includes(message.command ?? "")) {
						answered(session.id);
					}
				}
			})
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			running.delete(session.id);
			answered(session.id);
			runRules.delete(session.id);
			onceFor.delete(session.id);
		})
	);
}
