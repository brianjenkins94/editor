/**
 * Capability stops, whichever debugger's (the run contract, @brianjenkins94/run-contract): a run stopped at a gated call
 * asks on its line (`ask`), the question shows in the margin (`capability.ask`, live-values.ts), and the answer — the
 * margin's buttons, an agent's `debug.session.<id>.decide` — goes back to the debugger as a `decide` request.
 *
 * What an answer means is the editor's, not the debugger's: Allow, Skip or Deny for this call, this run (every call of
 * its capability, until the run ends — a rule kept here, never written) or always (my policy override, as the preview's
 * prompt writes it); a rule made in the margin's rule editor (saved in my policy, deciding the call as it does); or a
 * result given in the call's place. The debugger is told the verdict, and — when the answer changed it — the policy in
 * effect from now on. Every debugger is given the policy as it launches (`__policy`, debug-events.ts).
 */
import type { AskEvent, DecideRequest } from "@brianjenkins94/run-contract";
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import { EMPTY_POLICY, problemOf, ruleMatches, type Policy, type Rule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { loadEffectivePolicy, persistOverride, replaceRule } from "../capabilities/silo-store";
import type { CapabilityChoice } from "./debug-protocol";
import { controllable, type DebugOutcome } from "./debug-control";

const CHOICES = new Set<string>(["allow-once", "allow-run", "allow-always", "skip", "skip-run", "skip-always", "deny", "deny-run", "deny-always", "rule", "give-once"] satisfies CapabilityChoice[]);

/** The question each session is stopped at, by its id. */
const asks = new Map<string, AskEvent>();
/** What each session was allowed, skipped or denied for the rest of its run (… this run), ahead of every other rule. */
const runRules = new Map<string, Rule[]>();

/** The policy a run decides its calls by: base `policy.json` and my overrides, as the enforcer reads them — and, for a
 *  session already running, what it was told for the rest of its run. */
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

/** A session asking (its `ask` event): the question on its line, in its file's margin. */
export function asked(hub: Hub, session: vscode.DebugSession, ask: AskEvent): void {
	const { file, source, ...question } = ask;

	asks.set(session.id, ask);
	hub.publish("capability.ask", { "session": session.id, "file": file, ...source === undefined ? {} : { "source": source }, "ask": question });
}

/** The question answered — or gone (the run resumed some other way, or ended): off its margin. */
function answered(hub: Hub, session: string): void {
	const ask = asks.get(session);

	if (ask !== undefined) {
		asks.delete(session);
		hub.publish("capability.ask", { "session": session, "file": ask.file });
	}
}

/** What `choice` means for the call `session` is stopped at, told the debugger (`decide`), which continues. */
async function decide(hub: Hub, session: vscode.DebugSession, choice: CapabilityChoice, rule?: Rule, give?: unknown): Promise<void> {
	const ask = asks.get(session.id);

	if (ask === undefined) {
		throw new Error("not stopped at a capability call");
	}

	const always = async (disposition: "allow" | "deny" | "skip"): Promise<Policy> => {
		if (!ask.resolved) {
			throw new Error(`"${disposition[0]!.toUpperCase()}${disposition.slice(1)} always" needs the resource the call reaches, and ${ask.resource} isn't known before it runs`);
		}

		await persistOverride(ask.capability, ask.resource, disposition);

		return policyFor(session.id);
	};
	let request: DecideRequest;

	if (choice === "rule") {
		// The call as a rule sees it: an unknown resource is "".
		const subject = { "capability": ask.capability, "resource": ask.resolved ? ask.resource : "" };
		const decision = rule?.then?.find(({ action_id }) => ["allow", "deny", "skip", "ask"].includes(action_id))?.action_id;

		if (rule === undefined || problemOf(rule) !== undefined || !ruleMatches(rule, subject)) {
			throw new Error(rule === undefined ? "no rule" : problemOf(rule) ?? "the rule doesn't cover this call");
		}

		// A rule giving the call's result decides it too: the call isn't made, the debugger returns what it gives.
		const gives = rule.then.some((action) => action.action_id === "give" && action.target_id === "result");

		if (decision !== "allow" && decision !== "deny" && decision !== "skip" && !gives) {
			throw new Error("the rule doesn't allow, deny, skip or give this call");
		}

		await replaceRule(undefined, rule);
		request = { "verdict": !gives && (decision === "deny" || decision === "skip") ? decision : "allow", "policy": await policyFor(session.id) };
	} else if (choice === "give-once") {
		request = { "verdict": "give", "value": give ?? null };
	} else if (choice === "allow-run" || choice === "skip-run" || choice === "deny-run") {
		// Every call of the capability, until the run ends — whatever it reaches (a loop's calls reach a different one
		// each time round) — allowed, skipped or denied, this one with them.
		const action = choice.slice(0, choice.indexOf("-")) as "allow" | "skip" | "deny";

		runRules.set(session.id, [...runRules.get(session.id) ?? [], { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": ask.capability }] }, "then": [{ "action_id": action }] } as Rule]);
		request = { "verdict": action, "policy": await policyFor(session.id) };
	} else if (choice === "allow-always" || choice === "skip-always" || choice === "deny-always") {
		const disposition = choice.slice(0, choice.indexOf("-")) as "allow" | "skip" | "deny";

		request = { "verdict": disposition, "policy": await always(disposition) };
	} else {
		// This call only: allowed, skipped (the run goes on as if it did nothing), or denied (it fails, as refused).
		request = { "verdict": choice === "allow-once" ? "allow" : choice };
	}

	await session.customRequest("decide", request);
	// (answered, the run goes on — a debugger in another extension host is seen by no tracker resuming)
	answered(hub, session.id);
}

/** Every session's capability stops: answered over `debug.session.<id>.decide` (the margin's buttons, an agent's
 *  debug_* tools) — answering, for a tsval session, with where it stops next — and cleared as the session resumes or
 *  ends. */
export function registerCapabilityStops(context: vscode.ExtensionContext, hub: Hub): void {
	const served = new Map<string, () => void>();

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			served.set(session.id, serve(hub, `debug.session.${session.id}.decide`, async (args, { signal }): Promise<DebugOutcome | { "session": string; "state": "running" }> => {
				const { choice = "", rule, give } = (args ?? {}) as { "choice"?: string; "rule"?: Rule; "give"?: unknown };

				if (!CHOICES.has(choice)) {
					throw new Error(`unknown choice "${choice}" — one of ${[...CHOICES].join(", ")}`);
				}

				// (waiting from before it's told, so the stop it reaches isn't missed)
				const next = controllable(session.id)?.next(signal);

				await decide(hub, session, choice as CapabilityChoice, rule, give);

				return next ?? { "session": session.id, "state": "running" };
			}));
		}),
		// Resumed — by an answer, or VS Code's toolbar — the question's been answered.
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => ({
				"onDidSendMessage": (message: { "type"?: string; "event"?: string }) => {
					if (message.type === "event" && message.event === "continued") {
						answered(hub, session.id);
					}
				},
				"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => {
					if (message.type === "request" && ["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"].includes(message.command ?? "")) {
						answered(hub, session.id);
					}
				}
			})
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			answered(hub, session.id);
			runRules.delete(session.id);
			served.get(session.id)?.();
			served.delete(session.id);
		})
	);
}
