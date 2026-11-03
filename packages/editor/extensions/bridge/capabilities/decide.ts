/**
 * ENFORCE — the single capability DECISION ENDPOINT (ext host). A runtime's interceptor (a debug run's package calls,
 * through runtime-fs.ts) is THIN and round-trips here; no policy or grant store lives in an interceptor. This is the
 * one place the shared brain runs:
 *
 *   classify(raw call) → silo scope → broker.gate(redline → grant store → decider) → allow | deny
 *
 * It reuses the portable core published in @brianjenkins94/util/silo/enforce: `gate`/`CapabilityDenied`
 * (the fixed order), `redline` (BERNARD catastrophic scopes), and the intercept helpers (CAP_FS + scope
 * builders) as the single classification source. The decider is the policy alone today (what it leaves undecided is
 * refused); an external program or AI can replace it later behind the same seam. All `.silo/` I/O — the base+override
 * policy merge, the observed-capability rollup, the run firehose — lives in editor-api/policy.
 */
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

/**
 * The RAW call an interceptor sends — deliberately un-classified so the interceptors stay dumb and decoupled
 * (almostnode never imports the policy core). Classification happens HERE.
 *   • net: `{ kind: "net", args: [input, init] }` — host derived from the request.
 *   • fs:  `{ kind: "fs", method, args: [path, …] }` — op derived from the method, path from arg 0.
 *   • exec:`{ kind: "exec", args: [command, …] }`.
 */
export interface CapabilityCall {
	"kind": "net" | "fs" | "exec";
	"method"?: string;
	"op"?: "read" | "write";
	"resource"?: string;
	"args"?: readonly unknown[];
	/** The run this call belongs to, when known: counted among that run's effects (editor-api/effects's recordEffect). */
	"runId"?: string;
	/** The package whose code made it (a debug run's, beyond its baseline: runtime-fs.ts), by name@version — its run
	 *  counts it, as that package's, so it isn't counted here too; the policy's rules about that package's calls decide it,
	 *  and an answer of "Allow always" is a rule about them. */
	"package"?: string;
	/** Why the package's call is asked about (what its baseline says of it). */
	"why"?: AskedWhy;
	/** Who it's made for (the policy's `trigger`): `you` (someone's watching: the default) or `edit` (nobody is). */
	"trigger"?: "you" | "edit";
}

/** A package as `name@version` names it (a scoped name's own `@` kept). */
function packageNamed(pkg: string): { "name": string; "version"?: string } {
	const at = pkg.lastIndexOf("@");

	return at > 0 ? { "name": pkg.slice(0, at), "version": pkg.slice(at + 1) } : { "name": pkg };
}

/** How a call was decided (util/silo's Effect `decided`): by the policy, or at the call — the person's answer. */
export type Decided = NonNullable<Effect["decided"]>;

/** Turn a raw interceptor call into the canonical silo request (scope string + context), or undefined if it
 *  isn't a gated capability (e.g. an fs method neither almostnode nor CAP_FS gates). */
function classify(call: CapabilityCall): CapabilityRequest | undefined {
	const arg0 = call.args?.[0];

	if (call.kind === "net") {
		const host = hostOf(arg0);

		return { "kind": "net", "scope": netScope(host), "resource": host };
	}

	if (call.kind === "fs") {
		const op = call.op ?? (call.method !== undefined ? FS_SYNC[call.method] ?? FS_ASYNC[call.method] ?? CAP_FS[call.method] : undefined);

		if (op === undefined) {
			return undefined; // not a gated fs method
		}

		const path = typeof arg0 === "string" ? arg0 : call.resource ?? "";

		return { "kind": "fs", "op": op, "scope": fsScope(op, path), "resource": path };
	}

	const bin = typeof arg0 === "string" ? arg0 : call.resource ?? "";

	return { "kind": "exec", "scope": execScope(bin), "resource": bin };
}

/** The silo capability axis for a request: `fs:read`/`fs:write` carry the op; net and exec are the kind. */
function capabilityOf(request: CapabilityRequest): string {
	return request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind;
}

/** Each run's answers at the call: the scopes allowed once — for the rest of that run, never the next — and those
 *  refused, not asked again in it. Persisted decisions live in the policy (consulted by the decider), not here. */
const runAnswers = new Map<string, { "allowed": Set<string>; "refused": Set<string> }>();
/** How many runs' answers are kept: a run asks again only while it runs, and runs end. */
const KEEP_RUNS = 64;

/** `runId`'s answers so far (undefined with no run: a call that isn't a run's is asked each time). */
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

/** Whose call it is, and why it's asked about, as far as they're known: a package's (name@version), with what its
 *  baseline says of it. */
function askerOf(request: object): { "package"?: string; "why"?: AskedWhy } {
	const { "package": pkg, why } = request as { "package"?: string; "why"?: AskedWhy };

	return { ...typeof pkg === "string" ? { "package": pkg } : {}, ...why === undefined ? {} : { "why": why } };
}

/** What a rule about the call is about, beyond its capability and resource: the package making it, by name (any version
 *  of it) — a package's call, decided always, is decided for that package, not for every caller. */
function aboutOf(request: object): Record<string, string> {
	const { "package": pkg } = askerOf(request);

	return pkg === undefined ? {} : { "package": packageNamed(pkg).name };
}

/** The calls refused as undecided that were said, by scope: each said once a session. */
const undecidedSaid = new Set<string>();

/** An undecided call, refused — and said, once a scope: nothing in the core asks a person at the call yet (the
 *  shell's prompt went with previews), so the policy decides, and what it leaves undecided isn't made. */
function refuseUndecided(scope: string, pkg: string | undefined): void {
	if (!undecidedSaid.has(scope)) {
		undecidedSaid.add(scope);
		void vscode.window.showWarningMessage(`${pkg === undefined ? "A call" : `${pkg}'s call`} to ${scope} wasn't made: the policy doesn't decide it, and nothing here asks yet. Allow it with a rule in your policy (.silo/policy/<you>.json).`);
	}
}

/** The decider: the effective policy — my `policy/<user>.json` overrides layered over the base `policy.json` contract —
 *  allows or denies with no question (so pre-approved scopes and default-allow patterns like fs:read under the
 *  workspace never nag). What it leaves undecided is refused (refuseUndecided). Swappable for an external or AI
 *  decider behind this same seam (ARCHITECTURE.md, *Extension points* 5). */
async function policyDecider(request: CapabilityRequest): Promise<Verdict & { "decided": Decided }> {
	const capability = capabilityOf(request);
	const resource = request.resource ?? "";
	// (a package's call: the rules about that package's calls too)
	const pkg = askerOf(request).package;
	const { trigger = "you" } = request as { "trigger"?: "you" | "edit" };
	const effective = effectiveDisposition(await loadEffectivePolicy(), capability, resource, isDangerous(capability), { "trigger": trigger, ...pkg === undefined ? {} : packageNamed(pkg) });

	if (effective === "allow") {
		return { "behavior": "allow", "decided": "policy" };
	}

	if (effective === "deny") {
		return { "behavior": "deny", "message": "denied by .silo policy", "decided": "policy" };
	}

	// Skipped (util/silo's `skip`): not made. Here there's no stand-in to answer it in its place, as a debug run has — so,
	// as an enforcer without one, the gate refuses it.
	if (effective === "skip") {
		return { "behavior": "deny", "message": "skipped by .silo policy", "decided": "policy" };
	}

	refuseUndecided(request.scope, pkg);

	return { "behavior": "deny", "message": "undecided by .silo policy", "decided": "refused" };
}

/** A redline scope's break-glass: nobody here can authorize one (the shell's prompt went with previews), so it stays
 *  refused. */
async function breakGlass(request: CapabilityRequest): Promise<boolean> {
	refuseUndecided(request.scope, askerOf(request).package);

	return false;
}

// The same question, asked while it's still being decided (six peer connections opened at once), gets one answer.
const decide = coalesce((request: CapabilityRequest) => JSON.stringify([capabilityOf(request), request.scope, request.resource ?? "", aboutOf(request)]), policyDecider);

/**
 * Decide one raw capability call: whether it may be made, and how that was decided — by the policy, or at the call, the
 * person's answer (an exception to the policy, recorded among its run's effects). This is the endpoint every interceptor
 * round-trips to; a non-capability call (unclassifiable) is allowed (nothing to gate). Within a run, a scope allowed
 * once stays allowed, and one refused stays refused, until it ends; the next run asks again.
 */
export async function decideCapabilityAs(call: CapabilityCall): Promise<{ "allow": boolean; "decided": Decided }> {
	const request = classify(call);

	if (request === undefined) {
		return { "allow": true, "decided": "policy" };
	}

	if (call.trigger !== undefined) {
		(request as { "trigger"?: string }).trigger = call.trigger;
	}

	// And whose call it is, and why it's asked: a package's is decided by the rules about its calls.
	if (call.package !== undefined) {
		Object.assign(request, { "package": call.package }, call.why === undefined ? {} : { "why": call.why });
	}

	const answers = answersOf(call.runId);
	// (a run's answers are about whose call it was: a package allowed once doesn't allow another's)
	const answered = (scope: string): string => (call.package === undefined ? scope : `${packageNamed(call.package).name}\0${scope}`);
	// (a package's call is counted by its run, as that package's: its debugger's)
	const counted = call.package === undefined ? call.runId : undefined;
	// (an object: the broker's callbacks below set it, which a `let` narrowed to its first value wouldn't show)
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
			// (the broker grants every allow; only an answer of "once" is this run's to remember — the policy's are the policy's)
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
		recordObservation(request, "allow", counted, how.decided); // fired ⇒ observed surface + this run's record

		return { "allow": true, "decided": how.decided };
	} catch (error) {
		if (error instanceof CapabilityDenied) {
			if (how.decided === "refused") {
				answers?.refused.add(answered(request.scope));
			}

			recordObservation(request, "deny", counted, how.decided); // attempt-but-blocked: recorded, not in the surface

			return { "allow": false, "decided": how.decided };
		}

		throw error;
	}
}
