import type { AskedWhy } from "@brianjenkins94/editor-api/runtime";
import type { BrokerOptions, CapabilityRequest, Verdict } from "@brianjenkins94/util/silo/enforce/broker";
import type { Effect } from "@brianjenkins94/util/silo/evidence";
import { FS_ASYNC, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import { loadEffectivePolicy, recordObservation } from "@brianjenkins94/editor-api/policy";
import { CapabilityDenied, gate } from "@brianjenkins94/util/silo/enforce/broker";
import { CAP_FS, execScope, fsScope, hostOf, netScope } from "@brianjenkins94/util/silo/enforce/intercept";
import { effectiveDisposition, isDangerous } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { coalesce } from "./coalesce";

export interface CapabilityCall {
	"kind": "net" | "fs" | "exec";
	"method"?: string;
	"op"?: "read" | "write";
	"resource"?: string;
	"args"?: readonly unknown[];
	"runId"?: string;
	"package"?: string;
	"why"?: AskedWhy;
	"trigger"?: "you" | "edit";
}

function packageNamed(pkg: string): { "name": string; "version"?: string } {
	const at = pkg.lastIndexOf("@");

	return at > 0 ? { "name": pkg.slice(0, at), "version": pkg.slice(at + 1) } : { "name": pkg };
}

export type Decided = NonNullable<Effect["decided"]>;

function classify(call: CapabilityCall): CapabilityRequest | undefined {
	const arg0 = call.args?.[0];

	if (call.kind === "net") {
		const host = hostOf(arg0);

		return { "kind": "net", "scope": netScope(host), "resource": host };
	}

	if (call.kind === "fs") {
		const op = call.op ?? (call.method !== undefined ? FS_SYNC[call.method] ?? FS_ASYNC[call.method] ?? CAP_FS[call.method] : undefined);

		if (op === undefined) {
			return undefined;
		}

		const path = typeof arg0 === "string" ? arg0 : call.resource ?? "";

		return { "kind": "fs", "op": op, "scope": fsScope(op, path), "resource": path };
	}

	const bin = typeof arg0 === "string" ? arg0 : call.resource ?? "";

	return { "kind": "exec", "scope": execScope(bin), "resource": bin };
}

function capabilityOf(request: CapabilityRequest): string {
	return request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind;
}

const runAnswers = new Map<string, { "allowed": Set<string>; "refused": Set<string> }>();
const KEEP_RUNS = 64;

function answersOf(runId: string | undefined): { "allowed": Set<string>; "refused": Set<string> } | undefined {
	if (runId === undefined) {
		return undefined;
	}

	let answers = runAnswers.get(runId);

	if (answers === undefined) {
		answers = { "allowed": new Set(), "refused": new Set() };
		runAnswers.set(runId, answers);

		for (const old of [...runAnswers.keys()].slice(0, Math.max(0, runAnswers.size - KEEP_RUNS))) {
			runAnswers.delete(old);
		}
	}

	return answers;
}

function askerOf(request: object): { "package"?: string; "why"?: AskedWhy } {
	const { "package": pkg, why } = request as { "package"?: string; "why"?: AskedWhy };

	return { ...typeof pkg === "string" ? { "package": pkg } : {}, ...why === undefined ? {} : { "why": why } };
}

function aboutOf(request: object): Record<string, string> {
	const { "package": pkg } = askerOf(request);

	return pkg === undefined ? {} : { "package": packageNamed(pkg).name };
}

const undecidedSaid = new Set<string>();

function refuseUndecided(scope: string, pkg: string | undefined): void {
	if (!undecidedSaid.has(scope)) {
		undecidedSaid.add(scope);
		void vscode.window.showWarningMessage(`${pkg === undefined ? "A call" : `${pkg}'s call`} to ${scope} wasn't made: the policy doesn't decide it, and nothing here asks yet. Allow it with a rule in your policy (.silo/policy/<you>.json).`);
	}
}

async function policyDecider(request: CapabilityRequest): Promise<Verdict & { "decided": Decided }> {
	const capability = capabilityOf(request);
	const resource = request.resource ?? "";
	const pkg = askerOf(request).package;
	const { trigger = "you" } = request as { "trigger"?: "you" | "edit" };
	const effective = effectiveDisposition(await loadEffectivePolicy(), capability, resource, isDangerous(capability), { "trigger": trigger, ...pkg === undefined ? {} : packageNamed(pkg) });

	if (effective === "allow") {
		return { "behavior": "allow", "decided": "policy" };
	}

	if (effective === "deny") {
		return { "behavior": "deny", "message": "denied by .silo policy", "decided": "policy" };
	}

	if (effective === "skip") {
		return { "behavior": "deny", "message": "skipped by .silo policy", "decided": "policy" };
	}

	refuseUndecided(request.scope, pkg);

	return { "behavior": "deny", "message": "undecided by .silo policy", "decided": "refused" };
}

async function breakGlass(request: CapabilityRequest): Promise<boolean> {
	refuseUndecided(request.scope, askerOf(request).package);

	return false;
}

const decide = coalesce((request: CapabilityRequest) => JSON.stringify([capabilityOf(request), request.scope, request.resource ?? "", aboutOf(request)]), policyDecider);

export async function decideCapabilityAs(call: CapabilityCall): Promise<{ "allow": boolean; "decided": Decided }> {
	const request = classify(call);

	if (request === undefined) {
		return { "allow": true, "decided": "policy" };
	}

	if (call.trigger !== undefined) {
		(request as { "trigger"?: string }).trigger = call.trigger;
	}

	if (call.package !== undefined) {
		Object.assign(request, { "package": call.package }, call.why === undefined ? {} : { "why": call.why });
	}

	const answers = answersOf(call.runId);
	const answered = (scope: string): string => (call.package === undefined ? scope : `${packageNamed(call.package).name}\0${scope}`);
	const counted = call.package === undefined ? call.runId : undefined;
	const how: { "decided": Decided } = { "decided": "policy" };

	if (answers?.refused.has(answered(request.scope)) === true) {
		recordObservation(request, "deny", counted, "refused");

		return { "allow": false, "decided": "refused" };
	}

	const options: BrokerOptions = {
		"store": {
			"has": (scope) => {
				const allowed = answers?.allowed.has(answered(scope)) === true;

				if (allowed) {
					how.decided = "once";
				}

				return allowed;
			},
			"grant": (scope) => {
				if (how.decided === "once") {
					answers?.allowed.add(answered(scope));
				}
			}
		},
		"decide": async (asked) => {
			const verdict = await decide(asked);

			how.decided = verdict.decided;

			return verdict;
		},
		"breakGlass": async (asked) => {
			const authorized = await breakGlass(asked);

			how.decided = authorized ? "once" : "refused";

			return authorized;
		}
	};

	try {
		await gate(request, options);
		recordObservation(request, "allow", counted, how.decided);

		return { "allow": true, "decided": how.decided };
	} catch (error) {
		if (error instanceof CapabilityDenied) {
			if (how.decided === "refused") {
				answers?.refused.add(answered(request.scope));
			}

			recordObservation(request, "deny", counted, how.decided);

			return { "allow": false, "decided": how.decided };
		}

		throw error;
	}
}
