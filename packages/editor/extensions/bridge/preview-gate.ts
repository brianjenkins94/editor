/**
 * A preview's outside calls, decided (RUNNING.md, *Rules*): the service worker asks about a page's fetches, and for its sockets,
 * and this answers by the policy, as a run's are, with a rule giving a result in its place. What the policy leaves undecided its
 * window asks (shell/preview-ask.tsx), and the answer holds until the server stops, or always, as a rule about its site. A
 * preview nobody's watching has nobody to ask, so it's given what the call returned last time, or refused. Fails closed: a window
 * that doesn't answer is a refusal.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import { loadEffectivePolicy, recordedResult, recordResult, replaceRule } from "@brianjenkins94/editor-api/policy";
import { scopesOf } from "@brianjenkins94/editor-api/rules";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { effectiveDisposition, givenResult, isDangerous } from "@brianjenkins94/util/silo/policy";
import type * as vscode from "vscode";

/** What the service worker asks. */
interface Call { "port": number; "capability": string; "resource": string }

/** What it's told: made, refused, or a result in its place. */
type Answer = { "allow": boolean } | { "give": unknown; "by": string };

type Asked = { "answer"?: "allow" | "allow-always" | "deny" | "deny-always"; "unwatched"?: boolean };

const ASKING = { "timeoutMs": 300_000, "waitForResponderMs": 10_000 };

/** What an answer's about: a call's site, or the capability when it has no address. */
function siteOf({ capability, resource }: Call): string {
	try {
		return `${capability} ${new URL(resource).origin}`;
	} catch {
		return capability;
	}
}

export function installPreviewGate(context: vscode.ExtensionContext, hub: Hub, log: Logger): void {
	const rpc = createRpcClient(hub);
	/** What each server's been told, until it stops: by site, an answer on its way or given. */
	const answers = new Map<number, Map<string, Promise<boolean | undefined>>>();

	const ask = async (call: Call): Promise<boolean | undefined> => {
		const asked = await rpc.request("preview.ask", call, ASKING).catch(() => ({ "answer": "deny" })) as Asked;

		if (asked.unwatched === true) {
			return undefined;
		}

		// A rule about the whole site, as what's being held is; or, with no address, about every call of it.
		if (asked.answer === "allow-always" || asked.answer === "deny-always") {
			const scopes = scopesOf(call.capability, call.resource);
			const { when } = scopes.length > 2 ? scopes[1]! : scopes.at(-1)!;

			await replaceRule(undefined, { "when": when, "then": [{ "action_id": asked.answer.slice(0, asked.answer.indexOf("-")) }] });
		}

		return asked.answer?.startsWith("allow") === true;
	};

	const decide = async (call: Call): Promise<Answer> => {
		const { capability, resource, port } = call;
		const policy = await loadEffectivePolicy();
		const subject = { "capability": capability, "resource": resource, "trigger": "you" };
		const given = givenResult(policy, subject);

		if (given !== undefined) {
			return { "give": given.value, "by": "rule" };
		}

		const disposition = effectiveDisposition(policy, capability, resource, isDangerous(capability), { "trigger": "you" });

		if (disposition !== "review") {
			return { "allow": disposition === "allow" };
		}

		const held = answers.get(port) ?? new Map<string, Promise<boolean | undefined>>();
		const site = siteOf(call);
		const answer = held.get(site) ?? ask(call);

		answers.set(port, held);
		held.set(site, answer);

		const allow = await answer;

		if (allow !== undefined) {
			return { "allow": allow };
		}

		// Nobody's watching: asked again when someone is.
		held.delete(site);

		const recorded = await recordedResult(capability, resource);

		return recorded === undefined ? { "allow": false } : { "give": recorded.value, "by": "recording" };
	};

	context.subscriptions.push(
		{ "dispose": serve(hub, "capability.decide", async (args) => {
			const call = args as Call;

			return log.span("editor.extensions.bridge.preview-gate.decide", { "op": call.capability, "path": call.resource }, async (span) => {
				const answer = await decide(call);

				span.end("give" in answer ? { "by": answer.by } : { "allow": answer.allow });

				return answer;
			});
		}) },
		{ "dispose": serve(hub, "capability.record", async (args) => {
			const { capability, resource, value } = args as Call & { "value": unknown };

			await recordResult(capability, resource, value);

			return true;
		}) },
		{ "dispose": hub.subscribe("preview.close", (data) => {
			answers.delete((data as { "port": number }).port);
		}) }
	);
}
